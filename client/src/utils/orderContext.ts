// Order context for the packing page: what is in the parcel being packed.
//
// Resolved server-side in one call (Order Imports mapping + the marketplace
// orders VMS copies from the Forward Scan database, with SKU photos). The
// browser never talks to OMSGuru (buyer PII + shared rate budget).

import { isKnownNonMeeshoTracking, isMeeshoMarketplace } from './scanFlow';

export interface OrderLineItem {
  sku: string;
  title?: string | null;
  quantity: number;
  imageUrl?: string | null;
  channelOrderId?: string | null;
  subOrderId?: string | null;
  // 'style' = no photo for this exact SKU; showing another size of it.
  imageMatch?: 'exact' | 'style' | null;
}

export type OrderContextSource = 'mapping' | 'forward-scan' | 'manual' | 'none';

export interface OrderContext {
  trackingId: string;
  orderId: string | null;
  marketplace: string | null;
  // Full sales-channel name, e.g. "Tulip Prints - Meesho".
  channel: string | null;
  // Server's Meesho verdict (sales channel), drives the flyer toggle.
  isMeesho: boolean;
  statusId: string | null;
  status: string | null;
  // OMS bucket: OPEN | NOT_PACKED | CANCELLED | PARTIAL_CANCEL | SHIPPED | RETURN | ...
  statusGroup: string | null;
  items: OrderLineItem[];
  source: OrderContextSource;
}

const SOURCES: OrderContextSource[] = ['mapping', 'forward-scan', 'manual', 'none'];

function cleanItem(raw: any): OrderLineItem {
  return {
    sku: typeof raw?.sku === 'string' && raw.sku.trim() ? raw.sku : 'UNKNOWN',
    title: typeof raw?.title === 'string' ? raw.title : null,
    quantity: Number.isFinite(Number(raw?.quantity)) && Number(raw.quantity) > 0
      ? Math.floor(Number(raw.quantity))
      : 1,
    imageUrl: typeof raw?.imageUrl === 'string' ? raw.imageUrl : null,
    channelOrderId: typeof raw?.channelOrderId === 'string' && raw.channelOrderId.trim() ? raw.channelOrderId.trim() : null,
    subOrderId: typeof raw?.subOrderId === 'string' && raw.subOrderId.trim() ? raw.subOrderId.trim() : null,
    imageMatch: raw?.imageMatch === 'style' ? 'style' : raw?.imageMatch === 'exact' ? 'exact' : null,
  };
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export async function resolveOrderContext(
  trackingId: string,
  apiUrl: string,
  token: string | null
): Promise<OrderContext> {
  const fallback: OrderContext = {
    trackingId, orderId: null, marketplace: null, channel: null, isMeesho: false,
    statusId: null, status: null, statusGroup: null, items: [], source: 'none',
  };
  if (!trackingId || !apiUrl || !token || trackingId === 'UNKNOWN') return fallback;

  try {
    // Hard cap: a slow backend must never hang the packing card.
    // On timeout we fall through to the fast mapping-table fallback below.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let response: Response;
    try {
      response = await fetch(`${apiUrl}/api/order-context/resolve?trackingId=${encodeURIComponent(trackingId)}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      const data = await response.json();
      const marketplace = textOrNull(data?.marketplace);
      const channel = textOrNull(data?.channel);
      return {
        trackingId,
        orderId: data?.orderId || null,
        marketplace,
        channel,
        isMeesho: typeof data?.isMeesho === 'boolean'
          ? data.isMeesho
          : isMeeshoMarketplace(marketplace) || isMeeshoMarketplace(channel),
        statusId: typeof data?.statusId === 'string' ? data.statusId : null,
        status: typeof data?.status === 'string' ? data.status : null,
        statusGroup: textOrNull(data?.statusGroup),
        items: Array.isArray(data?.items) ? data.items.map(cleanItem) : [],
        source: SOURCES.includes(data?.source) ? data.source : 'none',
      };
    }
  } catch {
    // Fall through to the legacy mapping endpoint.
  }

  try {
    const fallbackController = new AbortController();
    const fallbackTimer = setTimeout(() => fallbackController.abort(), 3000);
    let fallbackResponse: Response;
    try {
      fallbackResponse = await fetch(`${apiUrl}/api/order-mappings/resolve?trackingId=${encodeURIComponent(trackingId)}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: fallbackController.signal,
      });
    } finally {
      clearTimeout(fallbackTimer);
    }
    if (!fallbackResponse.ok) return fallback;
    const data = await fallbackResponse.json();
    if (!data?.mapping) return fallback;
    const marketplace = data.mapping.marketplace || null;
    return {
      ...fallback,
      orderId: data.mapping.order_id || null,
      marketplace,
      isMeesho: isMeeshoMarketplace(marketplace),
      source: 'mapping',
    };
  } catch {
    return fallback;
  }
}

// A parcel scanned before its order lines reached VMS (label just generated,
// Forward Scan not synced yet, 5-minute copy) is looked up again by itself,
// so SKU details + photos appear without the packer pressing Retry. About
// one copy cycle of tries; flyer settings play no part in this.
export const ORDER_REFRESH_MS = 20_000;
export const ORDER_REFRESH_MAX_TRIES = 15;

export function shouldAutoRefreshOrder(ctx: OrderContext | null | undefined, tries: number): boolean {
  return Boolean(ctx)
    && ctx!.trackingId !== 'UNKNOWN'
    // Flipkart / Myntra are never copied: their lines can never arrive.
    && !isKnownNonMeeshoTracking(ctx!.trackingId)
    && ctx!.items.length === 0
    && tries < ORDER_REFRESH_MAX_TRIES;
}

// What a background re-check may change: it fills in missing lines, or a
// missing marketplace, and never replaces lines already on screen (a Retry
// may have filled them while the re-check was in flight).
export function mergeRefreshedOrder(prev: OrderContext | null, next: OrderContext): OrderContext | null {
  if (!prev || prev.trackingId !== next.trackingId || prev.items.length > 0) return prev;
  if (next.items.length > 0) return next;
  if (!prev.marketplace && next.marketplace) {
    return { ...prev, marketplace: next.marketplace, channel: next.channel, isMeesho: next.isMeesho };
  }
  return prev;
}

// Orders the OMS no longer wants shipped: warn the packer before sealing.
export function isBlockedOrderStatus(statusGroup: string | null | undefined): boolean {
  return statusGroup === 'CANCELLED' || statusGroup === 'RETURN' || statusGroup === 'PARTIAL_CANCEL';
}
