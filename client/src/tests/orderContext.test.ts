import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveOrderContext } from '../utils/orderContext';

afterEach(() => {
  vi.unstubAllGlobals();
});

function okJson(payload: unknown) {
  return { ok: true, json: async () => payload };
}

describe('resolveOrderContext', () => {
  it('resolves order + items with photos from the server endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({
       orderId: 'LWAABHS270088497',
       marketplace: 'ETHNIC JUNCTION - Flipkart',
       statusId: '9',
       status: 'Packed',
       source: 'omsguru',
      items: [{ sku: 'A1-1001', title: 'Kurti', quantity: 2, imageUrl: 'https://img/x.jpeg' }],
    })));
    const ctx = await resolveOrderContext('TRACK-1', 'https://api.example', 'token');
    expect(ctx).toEqual({
      trackingId: 'TRACK-1',
       orderId: 'LWAABHS270088497',
       marketplace: 'ETHNIC JUNCTION - Flipkart',
       statusId: '9',
       status: 'Packed',
       items: [{ sku: 'A1-1001', title: 'Kurti', quantity: 2, imageUrl: 'https://img/x.jpeg', channelOrderId: null, subOrderId: null }],
      source: 'omsguru',
    });
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/api/order-context/resolve');
  });

  it('falls back to the legacy mapping endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url).includes('/api/order-context/resolve')) return { ok: false };
      return okJson({ mapping: { order_id: 'ORD-1', marketplace: 'Amazon' } });
    }));
    const ctx = await resolveOrderContext('TRACK-1', 'https://api.example', 'token');
    expect(ctx.source).toBe('mapping');
    expect(ctx.orderId).toBe('ORD-1');
    expect(ctx.items).toEqual([]);
  });

  it('returns none when unmapped and backend errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const ctx = await resolveOrderContext('TRACK-9', 'https://api.example', 'token');
    expect(ctx).toEqual({ trackingId: 'TRACK-9', orderId: null, marketplace: null, statusId: null, status: null, items: [], source: 'none' });
  });

  it('skips network for UNKNOWN tracking ids', async () => {
    const spy = vi.fn(async () => { throw new Error('should not fetch'); });
    vi.stubGlobal('fetch', spy);
    const ctx = await resolveOrderContext('UNKNOWN', 'https://api.example', 'token');
    expect(ctx.source).toBe('none');
    expect(spy).not.toHaveBeenCalled();
  });
});
