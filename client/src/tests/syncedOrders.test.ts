import { describe, it, expect } from 'vitest';
import { buildManualOrderPayload, draftFromOrder, formatRelativeTime, isValidImageLink } from '../utils/syncedOrders';

describe('synced order form helpers', () => {
  it('turns a synced order into an editable draft', () => {
    const draft = draftFromOrder({
      tracking_id: 'VL0085600380655',
      marketplace: 'Meesho',
      order_id: '337427494817171264_1',
      is_meesho: true,
      items: [{ sku: 'B110-Lavanya-Mehendi_XL', title: null, quantity: 2, imageUrl: 'https://cdn/x.jpg' }],
    });
    expect(draft).toEqual({
      trackingId: 'VL0085600380655',
      marketplace: 'Meesho',
      orderId: '337427494817171264_1',
      isMeesho: true,
      items: [{ sku: 'B110-Lavanya-Mehendi_XL', title: '', quantity: '2', imageUrl: 'https://cdn/x.jpg' }],
      rememberImages: true,
    });
    expect(draftFromOrder(null).items).toHaveLength(1);
  });

  it('builds the PUT payload and marks Meesho from the marketplace name', () => {
    const { payload, error } = buildManualOrderPayload({
      trackingId: ' VL1 ',
      marketplace: 'Tulip Prints - Meesho',
      orderId: '',
      isMeesho: false,
      items: [
        { sku: 'SKU-1', title: ' Kurti ', quantity: '3', imageUrl: 'https://cdn/a.jpg' },
        { sku: '', title: '', quantity: '1', imageUrl: '' },
      ],
      rememberImages: false,
    });
    expect(error).toBeNull();
    expect(payload).toEqual({
      trackingId: 'VL1',
      marketplace: 'Tulip Prints - Meesho',
      orderId: null,
      isMeesho: true,
      items: [{ sku: 'SKU-1', title: 'Kurti', quantity: 3, imageUrl: 'https://cdn/a.jpg' }],
      rememberImages: false,
    });
  });

  it('rejects bad photo links, orphan lines and empty drafts', () => {
    const base = { trackingId: 'T1', marketplace: '', orderId: '', isMeesho: false, rememberImages: true };
    expect(buildManualOrderPayload({ ...base, items: [{ sku: 'S', title: '', quantity: '1', imageUrl: 'javascript:alert(1)' }] }).error).toMatch(/Photo link/);
    expect(buildManualOrderPayload({ ...base, items: [{ sku: '', title: '', quantity: '1', imageUrl: 'https://x/y.jpg' }] }).error).toMatch(/needs a SKU/);
    expect(buildManualOrderPayload({ ...base, items: [] }).error).toMatch(/marketplace/);
    expect(buildManualOrderPayload({ ...base, trackingId: ' ', items: [] }).error).toMatch(/Tracking ID/);
  });

  it('validates optional photo links', () => {
    expect(isValidImageLink('')).toBe(true);
    expect(isValidImageLink('https://cdn/a.jpg')).toBe(true);
    expect(isValidImageLink('ftp://cdn/a.jpg')).toBe(false);
    expect(isValidImageLink('not a url')).toBe(false);
  });

  it('formats sync times relative to now', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    expect(formatRelativeTime(null, now)).toBe('never');
    expect(formatRelativeTime('2026-10-06T11:59:30Z', now)).toBe('30s ago');
    expect(formatRelativeTime('2026-10-06T11:55:00Z', now)).toBe('5 min ago');
    expect(formatRelativeTime('2026-10-06T09:00:00Z', now)).toBe('3 h ago');
  });
});
