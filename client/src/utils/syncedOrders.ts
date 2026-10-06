// Form helpers for the Synced Orders page (unit-tested): turn a synced
// order into an editable draft and a draft back into the PUT payload.
import { isMeeshoMarketplace } from './scanFlow';

export interface ManualItemDraft {
  sku: string;
  title: string;
  quantity: string;
  imageUrl: string;
}

export interface ManualOrderDraft {
  trackingId: string;
  marketplace: string;
  orderId: string;
  isMeesho: boolean;
  items: ManualItemDraft[];
  rememberImages: boolean;
}

export const EMPTY_ITEM: ManualItemDraft = { sku: '', title: '', quantity: '1', imageUrl: '' };

// Photo links are optional; when given they must be plain http(s) URLs.
export function isValidImageLink(value: string): boolean {
  const link = value.trim();
  if (!link) return true;
  try {
    const url = new URL(link);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function draftFromOrder(order: any | null): ManualOrderDraft {
  const items = Array.isArray(order?.items) ? order.items : [];
  return {
    trackingId: order?.tracking_raw || order?.tracking_id || '',
    marketplace: order?.marketplace || '',
    orderId: order?.order_id || '',
    isMeesho: Boolean(order?.is_meesho),
    items: items.length > 0
      ? items.map((item: any) => ({
        sku: item?.sku && item.sku !== 'UNKNOWN' ? String(item.sku) : '',
        title: item?.title ? String(item.title) : '',
        quantity: String(Number(item?.quantity) > 0 ? Math.floor(Number(item.quantity)) : 1),
        imageUrl: item?.imageUrl ? String(item.imageUrl) : '',
      }))
      : [{ ...EMPTY_ITEM }],
    rememberImages: true,
  };
}

export function buildManualOrderPayload(draft: ManualOrderDraft): { payload: Record<string, unknown> | null; error: string | null } {
  const trackingId = draft.trackingId.trim();
  if (!trackingId) return { payload: null, error: 'Tracking ID (AWB) is required' };
  const items = [];
  for (const item of draft.items) {
    const sku = item.sku.trim();
    if (!sku) {
      if (item.imageUrl.trim() || item.title.trim()) return { payload: null, error: 'Every line with a title or photo needs a SKU' };
      continue;
    }
    if (!isValidImageLink(item.imageUrl)) return { payload: null, error: `Photo link for ${sku} must start with http:// or https://` };
    const quantity = Math.floor(Number(item.quantity));
    items.push({
      sku,
      title: item.title.trim() || null,
      quantity: Number.isFinite(quantity) && quantity > 0 ? Math.min(999, quantity) : 1,
      imageUrl: item.imageUrl.trim() || null,
    });
  }
  const marketplace = draft.marketplace.trim();
  const orderId = draft.orderId.trim();
  if (!marketplace && !orderId && items.length === 0) {
    return { payload: null, error: 'Enter a marketplace, an order ID or at least one SKU' };
  }
  return {
    payload: {
      trackingId,
      marketplace: marketplace || null,
      orderId: orderId || null,
      isMeesho: draft.isMeesho || isMeeshoMarketplace(marketplace),
      items,
      rememberImages: draft.rememberImages,
    },
    error: null,
  };
}

export function formatRelativeTime(value: string | null | undefined, now = Date.now()): string {
  if (!value) return 'never';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'never';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
