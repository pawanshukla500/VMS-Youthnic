import { describe, it, expect, vi, afterEach } from 'vitest';
import { getOMSGuruConfig, resolveOrderContext } from '../utils/orderContext';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('getOMSGuruConfig', () => {
  it('is disabled without credentials', () => {
    vi.stubEnv('VITE_OMSGURU_BASE_URL', '');
    vi.stubEnv('VITE_OMSGURU_API_KEY', '');
    expect(getOMSGuruConfig().enabled).toBe(false);
  });

  it('enables when both values are set', () => {
    vi.stubEnv('VITE_OMSGURU_BASE_URL', 'https://api.omsguru.com/');
    vi.stubEnv('VITE_OMSGURU_API_KEY', 'secret');
    const config = getOMSGuruConfig();
    expect(config.enabled).toBe(true);
    expect(config.baseUrl).toBe('https://api.omsguru.com');
  });
});

describe('resolveOrderContext', () => {
  it('resolves order + marketplace from the mapping table', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ mapping: { order_id: 'ORD-1', marketplace: 'Amazon' } }),
    })));
    const ctx = await resolveOrderContext('TRACK-1', 'https://api.example', 'token');
    expect(ctx).toEqual({ trackingId: 'TRACK-1', orderId: 'ORD-1', marketplace: 'Amazon', items: [], source: 'mapping' });
  });

  it('falls back to none when unmapped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ mapping: null }) })));
    const ctx = await resolveOrderContext('TRACK-9', 'https://api.example', 'token');
    expect(ctx.source).toBe('none');
    expect(ctx.orderId).toBeNull();
  });
});
