import { describe, it, expect, vi } from 'vitest';
import { mapInvoiceToCachedOrder, mapListingToPhoto, attachPhotos, multiItemSummary } from '../omsguru/mappers';
import { resolveSyncCreds, maskToken, cacheDecision, parseWarehouseIds, lookupOrderByTracker } from '../omsguru/sync';

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
      { sku: 'A1-1001-Butti-Pink_2XL', title: 'A1-1001-Butti-Pink_2XL', quantity: 1, imageUrl: null },
      { sku: 'Combo-Dupatta-Green/Orange', title: 'Combo-Dupatta-Green/Orange', quantity: 2, imageUrl: null },
    ]);
  });

  it('drops invoices without a tracker', () => {
    expect(mapInvoiceToCachedOrder({ ...invoice, shipment_tracker: '  ' })).toBeNull();
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

  it('keeps fresh positives for 7 days', () => {
    const row = { order_id: 'O1', items: [], fetched_at: hoursAgo(24) };
    expect(cacheDecision(row, now)).toBe('use');
    expect(cacheDecision({ ...row, fetched_at: hoursAgo(24 * 8) }, now)).toBe('refresh');
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
    expect(hit?.items).toEqual([{ sku: 'SKU-1', title: 'SKU-1', quantity: 2, imageUrl: null }]);
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
});
