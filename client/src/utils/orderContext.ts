// Order context for the packing page: what is in the parcel being packed.
//
// Today this resolves orderId/marketplace from the backend order-mapping
// table. It is structured for the planned OMSGuru integration: once
// VITE_OMSGURU_BASE_URL + VITE_OMSGURU_API_KEY are set, implement
// fetchOMSGuruOrder() (marked TODO below) and SKU lines with product
// images flow into the same OrderContext — no UI changes needed.

export interface OrderLineItem {
  sku: string;
  title?: string;
  quantity: number;
  imageUrl?: string;
}

export interface OrderContext {
  trackingId: string;
  orderId: string | null;
  marketplace: string | null;
  items: OrderLineItem[];
  source: 'mapping' | 'omsguru' | 'none';
}

export interface OMSGuruConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
}

export function getOMSGuruConfig(): OMSGuruConfig {
  const env = (import.meta as any)?.env || {};
  const baseUrl = typeof env.VITE_OMSGURU_BASE_URL === 'string' ? env.VITE_OMSGURU_BASE_URL.trim().replace(/\/+$/, '') : '';
  const apiKey = typeof env.VITE_OMSGURU_API_KEY === 'string' ? env.VITE_OMSGURU_API_KEY.trim() : '';
  return { enabled: Boolean(baseUrl && apiKey), baseUrl, apiKey };
}

// TODO(omsguru): call the OMSGuru order API here (by tracking/AWB number)
// and map its response to OrderContext with source 'omsguru', e.g.:
//   GET {baseUrl}/orders?tracking_id=...  Authorization: Bearer {apiKey}
//   -> { orderId, marketplace, items: [{ sku, title, quantity, imageUrl }] }
// Return null when the order is not found so the caller falls back.
async function fetchOMSGuruOrder(_trackingId: string, _config: OMSGuruConfig): Promise<OrderContext | null> {
  return null;
}

async function resolveFromMapping(trackingId: string, apiUrl: string, token: string | null): Promise<OrderContext | null> {
  if (!apiUrl || !token || !trackingId || trackingId === 'UNKNOWN') return null;
  try {
    const response = await fetch(`${apiUrl}/api/order-mappings/resolve?trackingId=${encodeURIComponent(trackingId)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const mapping = data?.mapping;
    if (!mapping) return null;
    return {
      trackingId,
      orderId: mapping.order_id || null,
      marketplace: mapping.marketplace || null,
      items: [],
      source: 'mapping',
    };
  } catch {
    return null;
  }
}

export async function resolveOrderContext(
  trackingId: string,
  apiUrl: string,
  token: string | null
): Promise<OrderContext> {
  const fallback: OrderContext = { trackingId, orderId: null, marketplace: null, items: [], source: 'none' };
  if (!trackingId) return fallback;

  const omsguru = getOMSGuruConfig();
  if (omsguru.enabled) {
    const viaOMSGuru = await fetchOMSGuruOrder(trackingId, omsguru).catch(() => null);
    if (viaOMSGuru) return viaOMSGuru;
  }

  return (await resolveFromMapping(trackingId, apiUrl, token)) || fallback;
}
