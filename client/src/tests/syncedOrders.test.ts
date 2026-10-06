import { describe, it, expect } from 'vitest';
import {
  buildManualOrderPayload,
  draftFromOrder,
  EMPTY_ITEM,
  formatRelativeTime,
  isValidImageLink,
  withMarketplace,
} from '../utils/syncedOrders';

const meeshoOrder = {
  tracking_id: 'VL0085600380655',
  marketplace: 'Meesho',
  order_id: '337427494817171264_1',
  is_meesho: true,
  items: [{
    sku: 'B110-Lavanya-Mehendi_XL',
    title: null,
    quantity: 2,
    imageUrl: 'https://catalogue/x.jpg',
    lineImageUrl: null,
    channelOrderId: '337427494817171264',
    subOrderId: '337427494817171264_1',
  }],
};

describe('synced order form helpers', () => {
  it('turns a synced order into an editable draft', () => {
    const draft = draftFromOrder(meeshoOrder);
    expect(draft).toMatchObject({ trackingId: 'VL0085600380655', marketplace: 'Meesho', orderId: '337427494817171264_1', isMeesho: true, rememberImages: true });
    expect(draft.items[0]).toEqual({
      sku: 'B110-Lavanya-Mehendi_XL',
      title: '',
      quantity: '2',
      imageUrl: 'https://catalogue/x.jpg',
      originalImageUrl: 'https://catalogue/x.jpg',
      lineImageUrl: '',
      channelOrderId: '337427494817171264',
      subOrderId: '337427494817171264_1',
    });
    expect(draftFromOrder(null).items).toEqual([EMPTY_ITEM]);
  });

  it('keeps sub-order ids and never turns an untouched catalogue photo into a manual link', () => {
    const { payload } = buildManualOrderPayload(withMarketplace(draftFromOrder(meeshoOrder), 'Meesho'));
    expect(payload?.items).toEqual([{
      sku: 'B110-Lavanya-Mehendi_XL',
      title: null,
      quantity: 2,
      imageUrl: null,
      saveSkuImage: false,
      channelOrderId: '337427494817171264',
      subOrderId: '337427494817171264_1',
    }]);
  });

  it('saves a changed photo link as the SKU photo only when asked', () => {
    const draft = draftFromOrder(meeshoOrder);
    draft.items[0].imageUrl = 'https://manual/new.jpg';
    expect((buildManualOrderPayload(draft).payload?.items as any[])[0]).toMatchObject({ imageUrl: 'https://manual/new.jpg', saveSkuImage: true });
    draft.rememberImages = false;
    expect((buildManualOrderPayload(draft).payload?.items as any[])[0]).toMatchObject({ imageUrl: 'https://manual/new.jpg', saveSkuImage: false });
  });

  it('derives Meesho from the marketplace so a corrected order switches the flyer scan off', () => {
    const draft = withMarketplace(draftFromOrder(meeshoOrder), 'Flipkart');
    expect(draft.isMeesho).toBe(false);
    expect(buildManualOrderPayload(draft).payload?.isMeesho).toBe(false);
    expect(withMarketplace(draftFromOrder(null), 'Tulip Prints - Meesho').isMeesho).toBe(true);
    const noMarketplace = { ...withMarketplace(draftFromOrder(null), ''), trackingId: 'T1', isMeesho: true, orderId: 'O1' };
    expect(buildManualOrderPayload(noMarketplace).payload?.isMeesho).toBe(true);
  });

  it('rejects bad photo links, orphan lines and empty drafts', () => {
    const base = { trackingId: 'T1', marketplace: '', orderId: '', isMeesho: false, rememberImages: true };
    expect(buildManualOrderPayload({ ...base, items: [{ ...EMPTY_ITEM, sku: 'S', imageUrl: 'javascript:alert(1)' }] }).error).toMatch(/Photo link/);
    expect(buildManualOrderPayload({ ...base, items: [{ ...EMPTY_ITEM, imageUrl: 'https://x/y.jpg' }] }).error).toMatch(/needs a SKU/);
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
