// Pure mappers between OMSGuru payloads and our cache tables (unit-tested).
// The live API shapes were verified against the real account:
// - invoices carry shipment_tracker + channel + order_items[] (sku_code, qty)
// - order identity is invoice_id; channel_order_id lives per item
// - listings carry sku_name + img_url + title (real CDN photos)

export interface CachedOrderItem {
  sku: string;
  title: string | null;
  quantity: number;
  imageUrl: string | null;
  subOrderId?: string | null;
}

export interface CachedOrder {
  trackingId: string;
  orderId: string | null;
  marketplace: string | null;
  items: CachedOrderItem[];
}

export interface SkuPhoto {
  sku: string;
  title: string | null;
  imageUrl: string;
  marketplace: string | null;
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function toQuantity(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

// One invoice -> one cache row keyed by its AWB. Photos join later by sku.
export function mapInvoiceToCachedOrder(invoice: any): CachedOrder | null {
  const trackingId = clean(invoice?.shipment_tracker);
  if (!trackingId) return null;
  const items: CachedOrderItem[] = Array.isArray(invoice?.order_items)
    ? invoice.order_items
        .map((item: any) => ({
          sku: clean(item?.sku_code) || 'UNKNOWN',
          title: clean(item?.title) || clean(item?.sku_code),
          quantity: toQuantity(item?.qty),
          imageUrl: null,
          // Meesho-style rename key: the sub-order/item id identifies the
          // parcel better than the invoice number.
          subOrderId: clean(item?.channel_sub_order_id),
        }))
        .filter((item: CachedOrderItem) => item.sku !== 'UNKNOWN' || item.quantity > 0)
    : [];
  return {
    trackingId,
    orderId: clean(invoice?.invoice_id),
    marketplace: clean(invoice?.channel),
    items,
  };
}

// One channel listing -> one photo row keyed by sku_name.
export function mapListingToPhoto(listing: any, marketplace: string | null): SkuPhoto | null {
  const sku = clean(listing?.sku_name);
  const imageUrl = clean(listing?.img_url);
  if (!sku || !imageUrl) return null;
  return { sku, title: clean(listing?.title), imageUrl, marketplace };
}

// Attach cached photos to order items (exact sku match wins).
export function attachPhotos(items: CachedOrderItem[], photosBySku: Map<string, SkuPhoto>): CachedOrderItem[] {
  return items.map((item) => {
    const photo = photosBySku.get(item.sku);
    if (!photo) return item;
    return { ...item, imageUrl: photo.imageUrl, title: item.title || photo.title };
  });
}

// Multi-item guard: packers must verify every unit when a parcel holds
// more than one unit or more than one SKU.
export function multiItemSummary(items: CachedOrderItem[]): { units: number; skus: number; isMulti: boolean } {
  const units = items.reduce((sum, item) => sum + (item.quantity || 0), 0);
  const skus = new Set(items.map((item) => item.sku)).size;
  return { units, skus, isMulti: units > 1 || skus > 1 };
}
