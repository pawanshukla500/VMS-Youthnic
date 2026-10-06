import { describe, it, expect, vi, afterEach } from 'vitest';
import { createOMSGuruClient } from '../omsguru/client';
import { mapInvoiceToCachedOrder, mapListingToPhoto, attachPhotos, multiItemSummary, normalizeImageUrl, normalizeSkuKey, normalizeTracker, usesSubOrderIdentity } from '../omsguru/mappers';
import { resolveSyncCreds, maskToken, cacheDecision, parseWarehouseIds, lookupOrderByTracker, lookupOrderByTrackerDetailed, trackerMatches, getPollCursor, setPollCursor, runOMSGuruOrderPoll } from '../omsguru/sync';

afterEach(() => {
  vi.unstubAllGlobals();
});

const invoice = {
  invoice_id: 'LWAABHS270088497',
  channel: 'ETHNIC JUNCTION - Flipkart',
  shipment_tracker: 'FMPP4257348507',
  order_items: [
    { sku_code: 'A1-1001-Butti-Pink_2XL', qty: 1 },
    { sku_code: 'Combo-Dupatta-Green/Orange', qty: 2 },
  ],
};

describe('mapInvoiceToCachedOrder', () => {
  it('keys the row by AWB with order + items', () => {
    const row = mapInvoiceToCachedOrder(invoice);
    expect(row?.trackingId).toBe('FMPP4257348507');
    expect(row?.orderId).toBe('LWAABHS270088497');
    expect(row?.marketplace).toBe('ETHNIC JUNCTION - Flipkart');
    expect(row?.items).toEqual([
      { sku: 'A1-1001-Butti-Pink_2XL', title: 'A1-1001-Butti-Pink_2XL', quantity: 1, imageUrl: null, subOrderId: null },
      { sku: 'Combo-Dupatta-Green/Orange', title: 'Combo-Dupatta-Green/Orange', quantity: 2, imageUrl: null, subOrderId: null },
    ]);
  });

  it('drops invoices without a tracker', () => {
    expect(mapInvoiceToCachedOrder({ ...invoice, shipment_tracker: '  ' })).toBeNull();
  });

  it('strips courier suffixes from trackingId and normalizes item image URLs', () => {
    const row = mapInvoiceToCachedOrder({
      shipment_tracker: 'MYEP1135031932 ( EK_E2E )',
      invoice_id: 'INV-SUFFIX-1',
      channel: 'Flipkart',
      order_items: [
        { sku_code: 'SKU-IMG-1', qty: 1, image: 'http://cdn.example/photo.jpg' },
      ],
    });
    expect(row?.trackingId).toBe('MYEP1135031932');
    expect(row?.items[0].imageUrl).toBe('https://cdn.example/photo.jpg');
  });

  it('maps open packing-order aliases into the same cache shape', () => {
    expect(mapInvoiceToCachedOrder({
      tracking_id: 'MEESHO-NEW-1',
      order_id: 'ORDER-1',
      channel_name: 'Meesho',
      status_id: 9,
      status: 'Packed',
      items: [{ channel_order_id: 'CHANNEL-1', sku: 'BT218-Cat-Light Pink', quantity: 1, image_url: 'http://cdn.example/item.jpg' }],
    })).toMatchObject({
      trackingId: 'MEESHO-NEW-1',
      orderId: 'ORDER-1',
      marketplace: 'Meesho',
      statusId: '9',
      status: 'Packed',
      items: [{ channelOrderId: 'CHANNEL-1', sku: 'BT218-Cat-Light Pink', quantity: 1, imageUrl: 'https://cdn.example/item.jpg' }],
    });
  });
});

describe('mapListingToPhoto', () => {
  it('keeps sku, title and real image url', () => {
    expect(mapListingToPhoto(
      { sku_name: 'EJ1180', title: 'Shirt', img_url: 'https://img.fkcdn.com/image/x.jpeg' },
      'Flipkart'
    )).toEqual({ sku: 'EJ1180', title: 'Shirt', imageUrl: 'https://img.fkcdn.com/image/x.jpeg', marketplace: 'Flipkart' });
  });

  it('drops listings without sku or image', () => {
    expect(mapListingToPhoto({ sku_name: '', img_url: 'http://x/y.jpeg' }, null)).toBeNull();
    expect(mapListingToPhoto({ sku_name: 'A' }, null)).toBeNull();
  });

  it('accepts channel aliases and upgrades insecure CDN links', () => {
    expect(mapListingToPhoto({ sku_code: ' bt218-Cat-Light  Pink ', image_url: 'http://cdn.example/x.jpg', name: 'Cat Light' }, 'Meesho'))
      .toEqual({ sku: 'bt218-Cat-Light  Pink', title: 'Cat Light', imageUrl: 'https://cdn.example/x.jpg', marketplace: 'Meesho' });
    expect(normalizeImageUrl('//cdn.example/x.jpg')).toBe('https://cdn.example/x.jpg');
  });
});

describe('OMSGuru listing client', () => {
  const textMock = (text: string, headers?: Headers) =>
    vi.fn(async () => ({ ok: true, status: 200, headers: headers || new Headers(), text: async () => text }));

  it('scopes listings with the documented channel_company_id', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => '[]' }));
    vi.stubGlobal('fetch', fetchMock);

    await createOMSGuruClient({ token: 't-list', cid: 'c-list' }).listListingsPage(17970, 0);

    const request = (fetchMock as any).mock.calls[0]?.[1] as RequestInit | undefined;
    const body = new URLSearchParams(String(request?.body || ''));
    expect(body.get('channel_company_id')).toBe('17970');
    expect(body.has('channel_id')).toBe(false);
  });

  it('caps invoice and status pages at 50 records', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => '[]' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createOMSGuruClient({ token: 't-cap', cid: 'c-cap' });

    await client.listInvoicesPage({ start: 1, end: 2, warehouseId: '6688', lastId: 0, limit: 100 });
    await client.listOrdersPage({ start: 1, end: 2, warehouseId: '6688', statusId: '9', lastId: 0, limit: 100 });

    for (const call of (fetchMock as any).mock.calls) {
      const body = new URLSearchParams(String((call[1] as RequestInit).body || ''));
      expect(body.get('limit')).toBe('50');
    }
  });

  it('streams invoices across all warehouses when no warehouse is given', async () => {
    const fetchMock = textMock('[]');
    vi.stubGlobal('fetch', fetchMock);

    await createOMSGuruClient({ token: 't-str1', cid: 'c-str1' }).listInvoicesPage({ start: 1, end: 2, lastId: 0 });

    const request = (fetchMock as any).mock.calls[0]?.[1] as RequestInit | undefined;
    const body = new URLSearchParams(String(request?.body || ''));
    expect(body.has('warehouse_id')).toBe(false);
    expect(String((fetchMock as any).mock.calls[0]?.[0])).toContain('/order_api/invoices');
  });

  it('streams orders across all statuses when no status is given', async () => {
    const fetchMock = textMock('[]');
    vi.stubGlobal('fetch', fetchMock);

    await createOMSGuruClient({ token: 't-str2', cid: 'c-str2' }).listOrdersPage({ start: 1, end: 2, warehouseId: '6688', lastId: 0 });

    const request = (fetchMock as any).mock.calls[0]?.[1] as RequestInit | undefined;
    const body = new URLSearchParams(String(request?.body || ''));
    expect(body.get('warehouse_id')).toBe('6688');
    expect(body.has('status_id')).toBe(false);
  });

  it('retries a throttled envelope delivered as HTTP 200', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers({ 'Retry-After': '1' }), text: async () => JSON.stringify({ error: -4, message: 'API Throttled' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    const rows = await createOMSGuruClient({ token: 't-thr', cid: 'c-thr' }).listInvoicesPage({ start: 1, end: 2, lastId: 0 });
    expect(rows).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 15000);

  it('backs off HTTP 429 using Retry-After', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Headers({ 'Retry-After': '1' }), text: async () => '{}' })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), text: async () => '[]' });
    vi.stubGlobal('fetch', fetchMock);

    const rows = await createOMSGuruClient({ token: 't-429', cid: 'c-429' }).listOrdersPage({ start: 1, end: 2, warehouseId: '6688', lastId: 0 });
    expect(rows).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 15000);

  it('lists account warehouses for diagnostics', async () => {
    const fetchMock = textMock(JSON.stringify([{ id: 6688, name: 'DEFAULT 33299' }]));
    vi.stubGlobal('fetch', fetchMock);

    const warehouses = await createOMSGuruClient({ token: 't-wh', cid: 'c-wh' }).listWarehouses();
    expect(warehouses).toEqual([{ id: '6688', name: 'DEFAULT 33299' }]);
    expect(String((fetchMock as any).mock.calls[0]?.[0])).toContain('/order_api/warehouses');
  });
});

describe('attachPhotos + multiItemSummary', () => {
  it('joins photos by exact sku and flags multi-unit parcels', () => {
    const row = mapInvoiceToCachedOrder(invoice)!;
    const photos = new Map([
      ['A1-1001-Butti-Pink_2XL', { sku: 'A1-1001-Butti-Pink_2XL', title: 'Kurti', imageUrl: 'https://img/x.jpeg', marketplace: null }],
    ]);
    const items = attachPhotos(row.items, photos);
    expect(items[0].imageUrl).toBe('https://img/x.jpeg');
    expect(items[0].title).toBe('A1-1001-Butti-Pink_2XL');
    expect(items[1].imageUrl).toBeNull();
    expect(multiItemSummary(items)).toEqual({ units: 3, skus: 2, isMulti: true });
  });

  it('joins photos despite SKU case and whitespace differences', () => {
    const items = [{ sku: 'BT218-Cat-Light Pink', title: 'Cat', quantity: 1, imageUrl: null }];
    const photos = new Map([[normalizeSkuKey(' bt218-Cat-Light  Pink '), {
      sku: 'bt218-Cat-Light  Pink', title: 'Cat', imageUrl: 'https://img/x.jpg', marketplace: 'Meesho'
    }]]);
    expect(attachPhotos(items, photos)[0].imageUrl).toBe('https://img/x.jpg');
  });

  it('single-unit parcels are not multi', () => {
    expect(multiItemSummary([{ sku: 'A', title: null, quantity: 1, imageUrl: null }])).toEqual({ units: 1, skus: 1, isMulti: false });
  });
});

describe('resolveSyncCreds', () => {
  const env = { token: 'env-token', cid: 'env-cid', warehouseId: 'env-wh' };

  it('prefers DB settings over env (rotation without redeploy)', () => {
    expect(resolveSyncCreds({ token: 'db-token', cid: 'db-cid', warehouse_id: 'db-wh' }, env))
      .toEqual({ token: 'db-token', cid: 'db-cid', warehouseId: 'db-wh' });
  });

  it('falls back to env per field', () => {
    expect(resolveSyncCreds({ token: '', cid: 'db-cid', warehouse_id: '' }, env))
      .toEqual({ token: 'env-token', cid: 'db-cid', warehouseId: 'env-wh' });
    expect(resolveSyncCreds(null, env))
      .toEqual({ token: 'env-token', cid: 'env-cid', warehouseId: 'env-wh' });
  });

  it('throws when no credentials exist anywhere', () => {
    expect(() => resolveSyncCreds(null, {})).toThrow('not configured');
  });
});

describe('maskToken', () => {
  it('shows only the last 4 characters', () => {
    expect(maskToken('hWf5GLIVO00Xk9Ns')).toBe('••••k9Ns');
    expect(maskToken('')).toBe('');
  });
});

describe('cacheDecision', () => {
  const now = Date.now();
  const hoursAgo = (h: number) => new Date(now - h * 3600 * 1000).toISOString();

  it('refreshes missing or unreadable rows', () => {
    expect(cacheDecision(null, now)).toBe('refresh');
    expect(cacheDecision({ fetched_at: 'not-a-date' } as any, now)).toBe('refresh');
  });

  it('keeps fresh positives for 24 hours', () => {
    const row = { order_id: 'O1', items: [], fetched_at: hoursAgo(12) };
    expect(cacheDecision(row, now)).toBe('use');
    expect(cacheDecision({ ...row, fetched_at: hoursAgo(25) }, now)).toBe('refresh');
  });

  it('rechecks unknown AWBs after 1 hour', () => {
    const row = { order_id: null, items: [], fetched_at: hoursAgo(2) };
    expect(cacheDecision(row, now)).toBe('refresh');
    expect(cacheDecision({ ...row, fetched_at: new Date(now - 1000).toISOString() }, now)).toBe('use');
  });
});

describe('parseWarehouseIds', () => {
  it('splits CSV warehouse lists', () => {
    expect(parseWarehouseIds('6688, 6692')).toEqual(['6688', '6692']);
    expect(parseWarehouseIds('')).toEqual([]);
    expect(parseWarehouseIds(undefined)).toEqual([]);
  });
});

describe('lookupOrderByTracker', () => {
  const invoice = (tracker: string, lastId = 0) => ({
    shipment_tracker: tracker,
    invoice_id: 'INV-1',
    channel: 'Test Mart',
    order_items: [{ sku_code: 'SKU-1', qty: 2 }],
    ...(lastId ? { last_id: lastId } : {}),
  });
  // Full pages keep an ascending walk going; short pages end the stream.
  const fullPage = (tracker: string, baseId: number) =>
    Array.from({ length: 50 }, (_, i) => invoice(i === 49 ? tracker : 'OTHER', baseId + i + 1));

  it('finds the AWB on the first page and stops', async () => {
    const listInvoicesPage = vi.fn(async () => [invoice('OTHER'), invoice('TARGET-1')]);
    const hit = await lookupOrderByTracker({ listInvoicesPage } as any, ['6688'], 'TARGET-1');
    expect(hit?.trackingId).toBe('TARGET-1');
    expect(hit?.items).toEqual([{ sku: 'SKU-1', title: 'SKU-1', quantity: 2, imageUrl: null, subOrderId: null }]);
    expect(listInvoicesPage).toHaveBeenCalledTimes(1);
    // Primary search streams all warehouses: no warehouse filter attached.
    const firstCall = (listInvoicesPage.mock.calls as any[][])[0][0] as any;
    expect(firstCall.warehouseId).toBeUndefined();
  });

  it('walks ascending pages to a later hit (proven API order)', async () => {
    let page = 0;
    const listInvoicesPage = vi.fn(async () => {
      page += 1;
      if (page < 3) return fullPage('OTHER', page * 1000);
      return fullPage('LATE-HIT', page * 1000);
    });
    const hit = await lookupOrderByTracker({ listInvoicesPage } as any, ['w1'], 'LATE-HIT', 5);
    expect(hit?.trackingId).toBe('LATE-HIT');
    expect(listInvoicesPage.mock.calls.length).toBe(3);
  });

  it('widens the window when the short window has no hit', async () => {
    const listInvoicesPage = vi.fn(async () => []);
    const hit = await lookupOrderByTracker({ listInvoicesPage } as any, ['w1'], 'MISSING', 1, 7, 10);
    expect(hit).toBeNull();
    const starts = (listInvoicesPage.mock.calls as any[][]).map((c) => (c[0] as any).start);
    // 6h, then 24h, then 7d windows — newest rows first despite ascending paging.
    expect(starts.length).toBe(3);
    expect(starts[0]).toBeGreaterThan(starts[1]);
    expect(starts[1]).toBeGreaterThan(starts[2]);
    expect((listInvoicesPage.mock.calls as any[][]).every((c) => (c[0] as any).warehouseId === undefined)).toBe(true);
  });

  it('matches the tracking_id alias when shipment_tracker is absent', async () => {
    const listInvoicesPage = vi.fn(async () => [{ ...invoice('OTHER'), shipment_tracker: undefined, tracking_id: 'ALIAS-1' }]);
    const hit = await lookupOrderByTracker({ listInvoicesPage } as any, ['w1'], 'ALIAS-1');
    expect(hit?.trackingId).toBe('ALIAS-1');
  });

  it('stops at an already-expired deadline without calling', async () => {
    const listInvoicesPage = vi.fn(async () => [invoice('OTHER')]);
    const hit = await lookupOrderByTracker({ listInvoicesPage } as any, ['w1'], 'MISSING', 3, 7, 10, Date.now() - 1);
    expect(hit).toBeNull();
    expect(listInvoicesPage).not.toHaveBeenCalled();
  });

  it('does not confuse a call budget exit with a definitive not-found', async () => {
    const listInvoicesPage = vi.fn(async () => fullPage('OTHER', 100));
    const result = await lookupOrderByTrackerDetailed({ listInvoicesPage } as any, ['w1'], 'MISSING', 3, 7, 1);
    expect(result.status).toBe('budget');
    expect(result.order).toBeNull();
    expect(listInvoicesPage).toHaveBeenCalledTimes(1);
  });

  it('searches per-warehouse all-status order streams after invoices miss', async () => {
    const listInvoicesPage = vi.fn(async () => []);
    const listOrdersPage = vi.fn(async () => [invoice('TARGET-2')]);
    const hit = await lookupOrderByTracker({ listInvoicesPage, listOrdersPage } as any, ['w1', 'w2'], 'TARGET-2');
    expect(hit?.trackingId).toBe('TARGET-2');
    const firstCall = (listOrdersPage.mock.calls as any[][])[0][0] as any;
    expect(firstCall.warehouseId).toBe('w1');
    expect(firstCall.statusId).toBeUndefined();
  });
});

describe('Ajio render-but-never-rename contract', () => {
  // Real AJEJ2087 shape (Ajio B2C Dropship, BLUEDART suffix): details must
  // resolve for render, while recording renames stay owned by the CSV
  // ExtraInfo flow (resolve/sync never write recording_sessions).
  const ajioInvoice = {
    invoice_id: 'AJEJ2087',
    channel: 'Ajio B2C Dropship',
    shipment_tracker: '76054651691 ( BLUEDART )',
    order_items: [{ channel_order_id: '1242627278', channel_sub_order_id: '1242627278.8', sku_code: 'T62-Peppa-Rani_2XL', qty: 1, status: 'Ready to ship' }],
  };

  it('matches the suffixed AWB and exposes sub-order identity', () => {
    expect(trackerMatches(ajioInvoice.shipment_tracker, '76054651691')).toBe(true);
    const row = mapInvoiceToCachedOrder(ajioInvoice);
    expect(row?.trackingId).toBe('76054651691');
    expect(row?.orderId).toBe('AJEJ2087');
    expect(row?.marketplace).toBe('Ajio B2C Dropship');
    expect(row?.items[0]).toMatchObject({ sku: 'T62-Peppa-Rani_2XL', quantity: 1, subOrderId: '1242627278.8' });
  });

  it('keeps Ajio order identity out of the Meesho sub-order rule', () => {
    expect(usesSubOrderIdentity('Tulip Prints - Meesho')).toBe(true);
    expect(usesSubOrderIdentity('Ajio B2C Dropship')).toBe(false);
    expect(usesSubOrderIdentity('VB EXPORT - Amazon Flex')).toBe(false);
    expect(usesSubOrderIdentity(null)).toBe(false);
  });
});

describe('trackerMatches', () => {
  it('matches exact barcodes', () => {
    expect(trackerMatches('MYEP1135031932', 'MYEP1135031932')).toBe(true);
  });

  it('tolerates courier suffixes in stored values', () => {
    expect(trackerMatches('MYEP1135031932 ( EK_E2E )', 'MYEP1135031932')).toBe(true);
    expect(trackerMatches('myep1135031932', 'MYEP1135031932')).toBe(true);
  });

  it('never matches a mere prefix', () => {
    expect(trackerMatches('12345', '123')).toBe(false);
    expect(trackerMatches('', '123')).toBe(false);
    expect(trackerMatches('123', '')).toBe(false);
  });

  it('normalizes parentheticals and whitespace', () => {
    expect(normalizeTracker('  MYEP1 (EK) ')).toBe('MYEP1');
  });
});

describe('lookupOrderByTracker total call budget', () => {
  const budgetInvoice = (tracker: string, lastId: number) => ({
    shipment_tracker: tracker,
    invoice_id: 'INV-1',
    channel: 'Test Mart',
    order_items: [{ sku_code: 'SKU-1', qty: 1 }],
    last_id: lastId,
  });

  it('caps total HTTP calls when pages never match', async () => {
    const listInvoicesPage = vi.fn(async (opts: any) => {
      const base = Number(opts.lastId || 0);
      return Array.from({ length: 50 }, (_, i) => budgetInvoice('OTHER', base + i + 1));
    });
    // Unbounded ascending pages would walk forever; budget stops at ~10.
    const hit = await lookupOrderByTracker({ listInvoicesPage } as any, ['w1', 'w2', 'w3', 'w4'], 'MISSING', 10);
    expect(hit).toBeNull();
    expect(listInvoicesPage.mock.calls.length).toBeLessThanOrEqual(10);
  });
});

describe('poll cursors', () => {
  const pollRow = (tracker: string, lastId: number) => ({
    shipment_tracker: tracker,
    invoice_id: 'INV-1',
    channel: 'Test Mart',
    order_items: [{ sku_code: 'SKU-1', qty: 1 }],
    last_id: lastId,
  });

  function makeFakePool() {
    const cursors = new Map<string, number>();
    const queries: Array<{ text: string; params: any[] }> = [];
    return {
      queries,
      cursors,
      query: vi.fn(async (text: string, params: any[] = []) => {
        queries.push({ text, params });
        if (text.includes('omsguru_poll_state')) {
          const key = `${params[0]}|${params[1]}|${params[2]}`;
          if (text.includes('SELECT last_id')) {
            const v = cursors.get(key);
            return { rows: v === undefined ? [] : [{ last_id: v }] };
          }
          cursors.set(key, Math.max(cursors.get(key) || 0, Number(params[3] || 0)));
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
  }

  it('round-trips the high-water mark and never regresses', async () => {
    const pool = makeFakePool() as any;
    expect(await getPollCursor(pool, 'o', 'w', 'invoices')).toBe(0);
    await setPollCursor(pool, 'o', 'w', 'invoices', 500);
    expect(await getPollCursor(pool, 'o', 'w', 'invoices')).toBe(500);
    await setPollCursor(pool, 'o', 'w', 'invoices', 100);
    expect(await getPollCursor(pool, 'o', 'w', 'invoices')).toBe(500);
  });

  it('walks from the persisted cursor and advances it', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => pollRow(`T-${i}`, i + 1));
    const page2 = [pollRow('T-NEW', 101)];
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      const body = new URLSearchParams(String((init as RequestInit).body || ''));
      const rows = Number(body.get('last_id') || 0) === 0 ? page1 : page2;
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(rows) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const pool = makeFakePool() as any;

    const result = await runOMSGuruOrderPoll(pool, 'org-1', { token: 't', cid: 'c', warehouseId: '' });
    expect(result.orders).toBe(51);
    expect(pool.queries.some((q: any) => q.text.includes('INSERT INTO omsguru_order_cache'))).toBe(true);
    expect(pool.cursors.get('org-1||invoices')).toBe(101);

    // Second poll resumes from the cursor and finds nothing new (drop the
    // first run's calls — mock.calls accumulates across implementations).
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200, headers: new Headers(), text: async () => '[]',
    }));
    const again = await runOMSGuruOrderPoll(pool, 'org-1', { token: 't', cid: 'c', warehouseId: '' });
    const bodies = fetchMock.mock.calls.map((c) => new URLSearchParams(String((c[1] as RequestInit).body || '')));
    expect(bodies[0].get('last_id')).toBe('101');
    expect(again.orders).toBe(0);
  });

  it('caps pages per feed so one poll stays in budget', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      const body = new URLSearchParams(String((init as RequestInit).body || ''));
      const base = Number(body.get('last_id') || 0);
      const rows = Array.from({ length: 50 }, (_, i) => pollRow('T', base + i + 1));
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(rows) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const pool = makeFakePool() as any;

    await runOMSGuruOrderPoll(pool, 'org-1', { token: 't', cid: 'c', warehouseId: 'w1' });
    // 1 invoice feed + 2 status feeds, 3 pages each = 9 calls max.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(24);
    expect(pool.cursors.size).toBeGreaterThan(0);
  });
});
