import { describe, it, expect, vi, afterEach } from 'vitest';
import { createOMSGuruClient } from '../omsguru/client';
import { mapInvoiceToCachedOrder, mapListingToPhoto, attachPhotos, multiItemSummary, normalizeImageUrl, normalizeSkuKey, usesSubOrderIdentity } from '../omsguru/mappers';
import { resolveSyncCreds, maskToken, cacheDecision, parseWarehouseIds, lookupOrderByTracker, trackerMatches, normalizeTracker } from '../omsguru/sync';

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

  it('maps open packing-order aliases into the same cache shape', () => {
    expect(mapInvoiceToCachedOrder({
      tracking_id: 'MEESHO-NEW-1',
      order_id: 'ORDER-1',
      channel_name: 'Meesho',
      items: [{ sku: 'BT218-Cat-Light Pink', quantity: 1, image_url: 'http://cdn.example/item.jpg' }],
    })).toMatchObject({
      trackingId: 'MEESHO-NEW-1',
      orderId: 'ORDER-1',
      marketplace: 'Meesho',
      items: [{ sku: 'BT218-Cat-Light Pink', quantity: 1, imageUrl: 'https://cdn.example/item.jpg' }],
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
  it('scopes listings with channel_id', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    vi.stubGlobal('fetch', fetchMock);

    await createOMSGuruClient({ token: 'token', cid: 'cid' }).listListingsPage(17970, 0);

    const request = (fetchMock as any).mock.calls[0]?.[1] as RequestInit | undefined;
    const body = new URLSearchParams(String(request?.body || ''));
    expect(body.get('channel_id')).toBe('17970');
    expect(body.has('channel_company_id')).toBe(false);
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
  const invoice = (tracker: string) => ({
    shipment_tracker: tracker,
    invoice_id: 'INV-1',
    channel: 'Test Mart',
    order_items: [{ sku_code: 'SKU-1', qty: 2 }],
  });

  it('finds the AWB and stops paging', async () => {
    const listInvoicesPage = vi.fn(async () => [invoice('OTHER'), invoice('TARGET-1')]);
    const hit = await lookupOrderByTracker({ listInvoicesPage } as any, ['6688'], 'TARGET-1');
    expect(hit?.trackingId).toBe('TARGET-1');
    expect(hit?.items).toEqual([{ sku: 'SKU-1', title: 'SKU-1', quantity: 2, imageUrl: null, subOrderId: null }]);
    expect(listInvoicesPage).toHaveBeenCalledTimes(1);
  });

  it('returns null when absent and bounds the pages', async () => {
    let cursor = 0;
    const listInvoicesPage = vi.fn(async () => {
      cursor += 100;
      return [{ ...invoice('OTHER'), last_id: cursor }];
    });
    const hit = await lookupOrderByTracker({ listInvoicesPage } as any, ['w1', 'w2'], 'MISSING', 2);
    expect(hit).toBeNull();
    // 2 warehouses x 2 pages max: one scan can never eat the rate budget.
    expect(listInvoicesPage).toHaveBeenCalledTimes(4);
  });

  it('stops at an already-expired deadline without calling', async () => {
    const listInvoicesPage = vi.fn(async () => [invoice('OTHER')]);
    const hit = await lookupOrderByTracker({ listInvoicesPage } as any, ['w1'], 'MISSING', 3, 7, 10, Date.now() - 1);
    expect(hit).toBeNull();
    expect(listInvoicesPage).not.toHaveBeenCalled();
  });

  it('searches open order statuses after invoices miss', async () => {
    const listInvoicesPage = vi.fn(async () => []);
    const listOrdersPage = vi.fn(async (opts: any) =>
      opts.statusId === '9' ? [invoice('TARGET-2')] : []
    );
    const hit = await lookupOrderByTracker({ listInvoicesPage, listOrdersPage } as any, ['w1'], 'TARGET-2');
    expect(hit?.trackingId).toBe('TARGET-2');
    expect(listOrdersPage).toHaveBeenCalled();
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
    let cursor = 0;
    const listInvoicesPage = vi.fn(async () => {
      cursor += 100;
      return [budgetInvoice('OTHER', cursor)];
    });
    // 4 warehouses x 10 pages would be 40 calls unbounded; budget stops at ~10.
    const hit = await lookupOrderByTracker({ listInvoicesPage } as any, ['w1', 'w2', 'w3', 'w4'], 'MISSING', 10);
    expect(hit).toBeNull();
    expect(listInvoicesPage.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('still returns a later-page hit before the budget runs out', async () => {
    let page = 0;
    const listInvoicesPage = vi.fn(async () => {
      page += 1;
      if (page < 3) return [budgetInvoice('OTHER', page * 100)];
      return [budgetInvoice('LATE-HIT', page * 100)];
    });
    const hit = await lookupOrderByTracker({ listInvoicesPage } as any, ['w1'], 'LATE-HIT', 5);
    expect(hit?.trackingId).toBe('LATE-HIT');
    expect(listInvoicesPage.mock.calls.length).toBe(3);
    expect(listInvoicesPage.mock.calls.length).toBeLessThanOrEqual(10);
  });
});
