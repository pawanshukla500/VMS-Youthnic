// Order context for the packing page: what is in the parcel being packed.
//
// Resolved server-side in one call (mapping table + OMSGuru cache for SKU
// lines and photos). OMSGuru credentials stay on the backend — browsers
// must never hold that token (buyer PII + shared rate budget).

export interface OrderLineItem {
  sku: string;
  title?: string | null;
  quantity: number;
  imageUrl?: string | null;
}

export interface OrderContext {
  trackingId: string;
  orderId: string | null;
  marketplace: string | null;
  items: OrderLineItem[];
  source: 'mapping' | 'omsguru' | 'none';
}

function cleanItem(raw: any): OrderLineItem {
  return {
    sku: typeof raw?.sku === 'string' && raw.sku.trim() ? raw.sku : 'UNKNOWN',
    title: typeof raw?.title === 'string' ? raw.title : null,
    quantity: Number.isFinite(Number(raw?.quantity)) && Number(raw.quantity) > 0
      ? Math.floor(Number(raw.quantity))
      : 1,
    imageUrl: typeof raw?.imageUrl === 'string' ? raw.imageUrl : null,
  };
}

export async function resolveOrderContext(
  trackingId: string,
  apiUrl: string,
  token: string | null
): Promise<OrderContext> {
  const fallback: OrderContext = { trackingId, orderId: null, marketplace: null, items: [], source: 'none' };
  if (!trackingId || !apiUrl || !token || trackingId === 'UNKNOWN') return fallback;

  try {
    const response = await fetch(`${apiUrl}/api/order-context/resolve?trackingId=${encodeURIComponent(trackingId)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (response.ok) {
      const data = await response.json();
      return {
        trackingId,
        orderId: data?.orderId || null,
        marketplace: data?.marketplace || null,
        items: Array.isArray(data?.items) ? data.items.map(cleanItem) : [],
        source: data?.source === 'omsguru' || data?.source === 'mapping' ? data.source : 'none',
      };
    }
  } catch {
    // Fall through to the legacy mapping endpoint.
  }

  try {
    const response = await fetch(`${apiUrl}/api/order-mappings/resolve?trackingId=${encodeURIComponent(trackingId)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!response.ok) return fallback;
    const data = await response.json();
    if (!data?.mapping) return fallback;
    return {
      trackingId,
      orderId: data.mapping.order_id || null,
      marketplace: data.mapping.marketplace || null,
      items: [],
      source: 'mapping',
    };
  } catch {
    return fallback;
  }
}
