// Pure mappers between OMSGuru payloads and our cache tables (unit-tested).
// The live API shapes were verified against the real account:
// - invoices carry shipment_tracker + channel + order_items[] (sku_code, qty)
// - order identity is invoice_id; channel_order_id lives per item
// - listings carry sku_name + img_url + title (real CDN photos); some
//   channels expose equivalent sku/image field names.

export interface CachedOrderItem {
  sku: string;
  title: string | null;
  quantity: number;
  imageUrl: string | null;
  channelOrderId?: string | null;
  subOrderId?: string | null;
}

export interface CachedOrder {
  trackingId: string;
  orderId: string | null;
  marketplace: string | null;
  items: CachedOrderItem[];
  statusId?: string | null;
  status?: string | null;
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

export function normalizeSkuKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toUpperCase() : '';
}

export function normalizeImageUrl(value: unknown): string | null {
  const url = clean(value);
  if (!url) return null;
  if (url.startsWith('//')) return `https:${url}`;
  if (/^http:\/\//i.test(url)) return url.replace(/^http:\/\//i, 'https://');
  return url;
}

function toQuantity(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

// Tracking IDs may carry courier suffixes from marketplaces or OMSGuru
// (e.g. "MYEP1135031932 ( EK_E2E )"). Normalize by stripping parenthetical
// suffixes and trimming whitespace so cache lookups and barcodes match.
export function normalizeTracker(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .toUpperCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// One invoice -> one cache row keyed by its AWB. Photos join later by sku.
export function mapInvoiceToCachedOrder(invoice: any): CachedOrder | null {
  const rawTracking = clean(invoice?.shipment_tracker)
    || clean(invoice?.tracking_id)
    || clean(invoice?.awb)
    || clean(invoice?.awb_number)
    || clean(invoice?.tracking_number);
  if (!rawTracking) return null;
  const trackingId = normalizeTracker(rawTracking) || rawTracking;
  const sourceItems = Array.isArray(invoice?.order_items)
    ? invoice.order_items
    : Array.isArray(invoice?.items)
      ? invoice.items
      : [];
  const items: CachedOrderItem[] = sourceItems
    .map((item: any) => {
      const channelOrderId = clean(item?.channel_order_id) || clean(item?.channelOrderId);
      return {
        sku: clean(item?.sku_code) || clean(item?.sku) || 'UNKNOWN',
        title: clean(item?.title) || clean(item?.sku_code) || clean(item?.sku),
        quantity: toQuantity(item?.qty ?? item?.quantity),
        imageUrl: normalizeImageUrl(item?.img_url || item?.image_url || item?.imageUrl || item?.image),
        ...(channelOrderId ? { channelOrderId } : {}),
        // Meesho-style rename key: the sub-order/item id identifies the
        // parcel better than the invoice number.
        subOrderId: clean(item?.channel_sub_order_id) || clean(item?.sub_order_id) || clean(item?.subOrderId),
      };
    })
    .filter((item: CachedOrderItem) => item.sku !== 'UNKNOWN' || item.quantity > 0);
  const statusId = clean(invoice?.status_id)
    || clean(invoice?.statusId)
    || (typeof invoice?.status_id === 'number' ? String(invoice.status_id) : null)
    || (typeof invoice?.statusId === 'number' ? String(invoice.statusId) : null);
  const status = clean(invoice?.status) || clean(invoice?.status_name);
  return {
    trackingId,
    orderId: clean(invoice?.invoice_id) || clean(invoice?.order_id) || clean(invoice?.orderId) || clean(invoice?.id),
    marketplace: clean(invoice?.channel) || clean(invoice?.channel_name) || clean(invoice?.marketplace),
    items,
    ...(statusId ? { statusId } : {}),
    ...(status ? { status } : {}),
  };
}

// One channel listing -> one photo row. Keep the original SKU for display;
// joins use normalizeSkuKey so channel casing/whitespace cannot hide photos.
export function mapListingToPhoto(listing: any, marketplace: string | null): SkuPhoto | null {
  const sku = clean(listing?.sku_name) || clean(listing?.sku_code) || clean(listing?.sku) || clean(listing?.product_sku);
  const imageUrl = normalizeImageUrl(listing?.img_url || listing?.image_url || listing?.imageUrl || listing?.image);
  if (!sku || !imageUrl) return null;
  return { sku, title: clean(listing?.title) || clean(listing?.name), imageUrl, marketplace };
}

// Attach cached photos to order items. The normalized key handles case and
// harmless whitespace differences between invoice and listing payloads.
export function attachPhotos(items: CachedOrderItem[], photosBySku: Map<string, SkuPhoto>): CachedOrderItem[] {
  return items.map((item) => {
    const photo = photosBySku.get(normalizeSkuKey(item.sku)) || photosBySku.get(item.sku);
    if (!photo) return item;
    return { ...item, imageUrl: photo.imageUrl, title: item.title || photo.title };
  });
}

// Meesho rename rule: parcels are identified by the sub-order/item id,
// not the invoice number. Ajio and others keep the invoice-level identity
// (Ajio renames come only from the CSV ExtraInfo flow, never from here).
export function usesSubOrderIdentity(marketplace: string | null): boolean {
  return Boolean(marketplace && marketplace.toLowerCase().includes('meesho'));
}
export function multiItemSummary(items: CachedOrderItem[]): { units: number; skus: number; isMulti: boolean } {
  const units = items.reduce((sum, item) => sum + (item.quantity || 0), 0);
  const skus = new Set(items.map((item) => item.sku)).size;
  return { units, skus, isMulti: units > 1 || skus > 1 };
}
