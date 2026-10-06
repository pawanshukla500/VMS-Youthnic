import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveOrderContext, isBlockedOrderStatus } from '../utils/orderContext';

afterEach(() => {
  vi.unstubAllGlobals();
});

function okJson(payload: unknown) {
  return { ok: true, json: async () => payload };
}

describe('resolveOrderContext', () => {
  it('resolves order + items with photos from the server endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({
      orderId: 'OD338778483273869100',
      marketplace: 'Flipkart',
      channel: 'ETHNIC JUNCTION - Flipkart',
      isMeesho: false,
      statusId: null,
      status: 'Ready to ship',
      statusGroup: 'OPEN',
      source: 'forward-scan',
      items: [
        { sku: 'A1-1001', title: 'Kurti', quantity: 2, imageUrl: 'https://img/x.jpeg' },
        { sku: 'B2-2002_M', quantity: 1, imageUrl: 'https://img/y.jpeg', imageMatch: 'style' },
      ],
    })));
    const ctx = await resolveOrderContext('TRACK-1', 'https://api.example', 'token');
    expect(ctx).toEqual({
      trackingId: 'TRACK-1',
      orderId: 'OD338778483273869100',
      marketplace: 'Flipkart',
      channel: 'ETHNIC JUNCTION - Flipkart',
      isMeesho: false,
      statusId: null,
      status: 'Ready to ship',
      statusGroup: 'OPEN',
      items: [
        { sku: 'A1-1001', title: 'Kurti', quantity: 2, imageUrl: 'https://img/x.jpeg', channelOrderId: null, subOrderId: null, imageMatch: null },
        { sku: 'B2-2002_M', title: null, quantity: 1, imageUrl: 'https://img/y.jpeg', channelOrderId: null, subOrderId: null, imageMatch: 'style' },
      ],
      source: 'forward-scan',
    });
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/api/order-context/resolve');
  });

  it('reads the Meesho flag from the server, or from the marketplace name for older servers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ marketplace: 'Meesho', isMeesho: true, source: 'forward-scan', items: [] })));
    expect((await resolveOrderContext('VL1', 'https://api.example', 'token')).isMeesho).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ marketplace: 'Tulip Prints - Meesho', source: 'mapping', items: [] })));
    expect((await resolveOrderContext('VL1', 'https://api.example', 'token')).isMeesho).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ marketplace: 'Myntra PPMP', source: 'weird', items: [] })));
    const ctx = await resolveOrderContext('MY1', 'https://api.example', 'token');
    expect(ctx.isMeesho).toBe(false);
    expect(ctx.source).toBe('none');
  });

  it('flags orders cancelled or returned in OMS', () => {
    expect(isBlockedOrderStatus('CANCELLED')).toBe(true);
    expect(isBlockedOrderStatus('RETURN')).toBe(true);
    expect(isBlockedOrderStatus('PARTIAL_CANCEL')).toBe(true);
    expect(isBlockedOrderStatus('OPEN')).toBe(false);
    expect(isBlockedOrderStatus(null)).toBe(false);
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
    expect(ctx).toEqual({
      trackingId: 'TRACK-9', orderId: null, marketplace: null, channel: null, isMeesho: false,
      statusId: null, status: null, statusGroup: null, items: [], source: 'none',
    });
  });

  it('skips network for UNKNOWN tracking ids', async () => {
    const spy = vi.fn(async () => { throw new Error('should not fetch'); });
    vi.stubGlobal('fetch', spy);
    const ctx = await resolveOrderContext('UNKNOWN', 'https://api.example', 'token');
    expect(ctx.source).toBe('none');
    expect(spy).not.toHaveBeenCalled();
  });
});
