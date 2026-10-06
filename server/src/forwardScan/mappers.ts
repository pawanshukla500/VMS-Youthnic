// Pure mappers: Forward Scan database rows -> VMS marketplace_orders /
// sku_images rows (unit-tested).
//
// Forward Scan (the OMSGuru dispatch-scan app on the same VPS) already keeps
// a copy of every recent OMSGuru AWB (oms_orders, one row per shipment) and
// the channel listings' SKU photos (sku_photos). VMS copies those rows
// instead of calling OMSGuru itself, so the shared 60 req / 5 min budget is
// left to Forward Scan. Buyer name / city / pincode are never copied.
import { createHash } from 'crypto';
import { MAX_TRACKER_LENGTH, normalizeImageUrl, normalizeSkuKey } from '../omsguru/mappers';

export { normalizeSkuKey };

// Shape both source dialects return (timestamps cast to text in SQL).
export interface ForwardScanOrderRow {
  source_row_id?: number | string | null;
  tracking_norm?: string | null;
  tracking_raw?: string | null;
  channel_label?: string | null;
  channel_id?: number | string | null;
  company?: string | null;
  channel_marketplace?: string | null;
  channel_name?: string | null;
  channel_order_id?: string | null;
  sub_order_ids?: string | null;
  invoice_id?: string | null;
  items_json?: string | null;
  item_count?: number | string | null;
  total_qty?: number | string | null;
  status_text?: string | null;
  status_group?: string | null;
  shipping_company?: string | null;
  order_type?: string | null;
  order_date?: string | Date | null;
  awb_generated_at?: string | Date | null;
  invoice_date?: string | Date | null;
  sla_date?: string | Date | null;
  synced_at?: string | Date | null;
  first_seen_at?: string | Date | null;
}

export interface ForwardScanPhotoRow {
  sku?: string | null;
  title?: string | null;
  image_url?: string | null;
  marketplace?: string | null;
  updated_at?: string | Date | null;
}

export interface MarketplaceOrderItem {
  sku: string;
  title: string | null;
  quantity: number;
  imageUrl: string | null;
  channelOrderId: string | null;
  subOrderId: string | null;
  status: string | null;
}

export interface MarketplaceOrderRecord {
  tracking_id: string;
  tracking_raw: string | null;
  marketplace: string | null;
  channel_marketplace: string | null;
  channel_name: string | null;
  channel_id: number | null;
  company: string | null;
  is_meesho: boolean;
  order_id: string | null;
  channel_order_id: string | null;
  sub_order_ids: string | null;
  invoice_id: string | null;
  items: MarketplaceOrderItem[];
  item_count: number;
  total_qty: number;
  status: string | null;
  status_group: string | null;
  shipping_company: string | null;
  order_type: string | null;
  order_date: string | null;
  awb_generated_at: string | null;
  sla_date: string | null;
  source_row_id: number | null;
  source_synced_at: string | null;
  source_hash: string;
}

export interface SkuImageRecord {
  sku: string;
  sku_key: string;
  title: string | null;
  image_url: string;
  marketplace: string | null;
  source_updated_at: string | null;
}

function clean(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function toInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// Same canonical AWB form Forward Scan stores in tracking_norm (port of
// app/oms/mapping.py normalize_tracking): courier suffixes like
// "( EK_E2E )" dropped, upper-cased, only A-Z 0-9 - _ / kept.
export function normalizeForwardScanTracking(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .slice(0, MAX_TRACKER_LENGTH)
    .replace(/\s*\([^()]*\)\s*/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9\-_/]/g, '')
    .replace(/^[-_/]+|[-_/]+$/g, '');
}

// VMS marketplace naming (same rule as index.ts normalizeMarketplace, which
// recordings and retention policies already use): "Tulip Prints - Meesho"
// -> "Meesho", "VB EXPORT - Myntra PPMP" -> "Myntra PPMP".
export function marketplaceFromChannelLabel(value: unknown): string | null {
  const raw = clean(value);
  if (!raw) return null;
  const collapsed = raw.replace(/^[`']+/, '').replace(/\s+/g, ' ');
  const normalized = collapsed.includes(' - ') ? collapsed.split(' - ').pop()?.trim() || collapsed : collapsed;
  return normalized || null;
}

export function isMeeshoText(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase().includes('meesho');
}

// Marketplaces VMS does not copy (FORWARD_SCAN_EXCLUDE_MARKETPLACES). Their
// videos are not renamed from the copy and their orders are not stored.
export const DEFAULT_EXCLUDED_MARKETPLACES = ['Flipkart', 'Myntra Youthnic', 'Myntra PPMP'];

function marketplaceKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

// Unset/empty -> the default list; "none" -> copy every marketplace.
export function parseExcludedMarketplaces(value: unknown): string[] {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.toLowerCase() === 'none') return [];
  const list = raw ? raw.split(',') : DEFAULT_EXCLUDED_MARKETPLACES;
  return [...new Set(list.map(marketplaceKey).filter(Boolean))];
}

// Matches the VMS marketplace name ("Myntra Youthnic") or Forward Scan's
// channel type ("Myntra PPMP"), so every Myntra / Flipkart channel is caught.
export function isExcludedMarketplace(
  record: { marketplace?: string | null; channel_marketplace?: string | null },
  excluded: string[]
): boolean {
  if (excluded.length === 0) return false;
  return excluded.includes(marketplaceKey(record.marketplace)) || excluded.includes(marketplaceKey(record.channel_marketplace));
}

export function isAjioText(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase().includes('ajio');
}

// Forward Scan stores naive UTC datetimes ("2026-10-03 05:36:10.000000").
export function forwardScanTimeToIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!match) return null;
  const fraction = match[3] ? match[3].slice(0, 4) : '';
  let zone = (match[4] || 'Z').toUpperCase();
  if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const date = new Date(`${match[1]}T${match[2]}${fraction}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Cutoff in Forward Scan's own text format, so SQLite compares strings.
export function toForwardScanTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function parseItems(json: unknown, channelOrderId: string | null): MarketplaceOrderItem[] {
  let raw: unknown = json;
  if (typeof json === 'string') {
    try {
      raw = JSON.parse(json || '[]');
    } catch {
      raw = [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const qty = Number(item.qty ?? item.quantity);
      return {
        sku: clean(item.sku) || 'UNKNOWN',
        title: clean(item.title),
        quantity: Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 1,
        imageUrl: normalizeImageUrl(item.image_url ?? item.imageUrl),
        channelOrderId: clean(item.channel_order_id) || channelOrderId,
        subOrderId: clean(item.sub_order_id) || clean(item.subOrderId),
        status: clean(item.status),
      };
    });
}

// Parcel identity shown on the packing page and used to name the video:
// Meesho = sub-order/item id (VMS Meesho rename rule), everyone else = the
// channel order id that OMSGuru CSV exports (Order Imports) also carry.
export function orderIdentity(record: Pick<MarketplaceOrderRecord, 'is_meesho' | 'items' | 'sub_order_ids' | 'channel_order_id' | 'invoice_id'>): string | null {
  if (record.is_meesho) {
    const fromItems = record.items.map((item) => item.subOrderId).find((id): id is string => Boolean(id));
    const fromRow = (record.sub_order_ids || '').split(',').map((s) => s.trim()).find(Boolean);
    const sub = fromItems || fromRow;
    if (sub) return sub;
  }
  return record.channel_order_id || record.invoice_id || null;
}

// Recordings are renamed from the synced copy for every marketplace except
// Ajio, whose order id comes only from the Order Imports ExtraInfo column.
export function recordingOrderId(row: { order_id?: string | null; marketplace?: string | null; channel_name?: string | null }): string | null {
  if (isAjioText(row.marketplace) || isAjioText(row.channel_name)) return null;
  return clean(row.order_id);
}

export function hashOrderRecord(record: Omit<MarketplaceOrderRecord, 'source_hash' | 'source_synced_at' | 'source_row_id'>): string {
  return createHash('sha1').update(JSON.stringify(record)).digest('hex');
}

export function mapForwardScanOrder(row: ForwardScanOrderRow): MarketplaceOrderRecord | null {
  const trackingId = normalizeForwardScanTracking(row.tracking_norm) || normalizeForwardScanTracking(row.tracking_raw);
  if (!trackingId) return null;
  const channelName = clean(row.channel_name) || clean(row.channel_label);
  const channelMarketplace = clean(row.channel_marketplace);
  const marketplace = marketplaceFromChannelLabel(row.channel_label) || marketplaceFromChannelLabel(channelName) || channelMarketplace;
  const channelOrderId = clean(row.channel_order_id);
  const items = parseItems(row.items_json, channelOrderId);
  const isMeesho = isMeeshoText(channelMarketplace) || isMeeshoText(channelName) || isMeeshoText(marketplace);
  const subOrderIds = clean(row.sub_order_ids);
  const invoiceId = clean(row.invoice_id);
  const totalQty = toInt(row.total_qty);
  const base = {
    tracking_id: trackingId,
    tracking_raw: clean(row.tracking_raw),
    marketplace,
    channel_marketplace: channelMarketplace,
    channel_name: channelName,
    channel_id: toInt(row.channel_id),
    company: clean(row.company),
    is_meesho: isMeesho,
    order_id: orderIdentity({ is_meesho: isMeesho, items, sub_order_ids: subOrderIds, channel_order_id: channelOrderId, invoice_id: invoiceId }),
    channel_order_id: channelOrderId,
    sub_order_ids: subOrderIds,
    invoice_id: invoiceId,
    items,
    item_count: toInt(row.item_count) ?? items.length,
    total_qty: totalQty && totalQty > 0 ? totalQty : items.reduce((sum, item) => sum + item.quantity, 0),
    status: clean(row.status_text),
    status_group: clean(row.status_group),
    shipping_company: clean(row.shipping_company),
    order_type: clean(row.order_type),
    order_date: forwardScanTimeToIso(row.order_date),
    // AWB generation = OMSGuru invoice date; older rows may only have the
    // invoice date or the first time Forward Scan saw them.
    awb_generated_at: forwardScanTimeToIso(row.awb_generated_at)
      || forwardScanTimeToIso(row.invoice_date)
      || forwardScanTimeToIso(row.first_seen_at),
    sla_date: forwardScanTimeToIso(row.sla_date),
  };
  return {
    ...base,
    source_row_id: toInt(row.source_row_id),
    source_synced_at: forwardScanTimeToIso(row.synced_at),
    source_hash: hashOrderRecord(base),
  };
}

// One AWB -> one row. Forward Scan keeps tracking_norm unique in practice;
// should two rows ever share an AWB, the newest source row wins.
export function dedupeByTracking(records: MarketplaceOrderRecord[]): MarketplaceOrderRecord[] {
  const byTracking = new Map<string, MarketplaceOrderRecord>();
  for (const record of records) {
    const existing = byTracking.get(record.tracking_id);
    if (!existing || (record.source_row_id ?? 0) >= (existing.source_row_id ?? 0)) {
      byTracking.set(record.tracking_id, record);
    }
  }
  return [...byTracking.values()];
}

export function mapForwardScanPhoto(row: ForwardScanPhotoRow): SkuImageRecord | null {
  const sku = clean(row.sku);
  const imageUrl = normalizeImageUrl(row.image_url);
  if (!sku || !imageUrl) return null;
  return {
    sku,
    sku_key: normalizeSkuKey(sku),
    title: clean(row.title),
    image_url: imageUrl,
    marketplace: clean(row.marketplace),
    source_updated_at: forwardScanTimeToIso(row.updated_at),
  };
}

export interface SkuImageLookup {
  sku_key: string;
  title: string | null;
  image_url: string;
  source: string;
}

export interface ResolvedOrderItem {
  sku: string;
  title: string | null;
  quantity: number;
  imageUrl: string | null;
  // The line's own stored link (before SKU photos) — lets the edit form
  // tell a changed link from the catalogue photo it was showing.
  lineImageUrl: string | null;
  channelOrderId: string | null;
  subOrderId: string | null;
}

// Photo for each order line: a hand-entered SKU link is a correction and
// always wins, then the line's own image, then the Forward Scan catalogue.
export function mergeItemImages(rawItems: unknown, images: SkuImageLookup[]): ResolvedOrderItem[] {
  if (!Array.isArray(rawItems)) return [];
  const manual = new Map<string, SkuImageLookup>();
  const synced = new Map<string, SkuImageLookup>();
  for (const image of images) {
    if (image.source === 'manual') {
      manual.set(image.sku_key, image);
    } else if (image.source === 'forward-scan' || !synced.has(image.sku_key)) {
      // Forward Scan's live catalogue beats photos left from the old sweep.
      synced.set(image.sku_key, image);
    }
  }
  return rawItems
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const sku = clean(item.sku) || 'UNKNOWN';
      const key = normalizeSkuKey(sku);
      const qty = Number(item.quantity);
      const own = normalizeImageUrl(item.imageUrl);
      const picked = manual.get(key) || null;
      const catalogue = synced.get(key) || null;
      return {
        sku,
        title: clean(item.title) || picked?.title || catalogue?.title || null,
        quantity: Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 1,
        imageUrl: picked?.image_url || own || catalogue?.image_url || null,
        lineImageUrl: own,
        channelOrderId: clean(item.channelOrderId),
        subOrderId: clean(item.subOrderId),
      };
    });
}

// Manual SKU photo links from admins: http(s) only, upgraded to https.
export function normalizeManualImageUrl(value: unknown): string | null {
  const url = normalizeImageUrl(value);
  if (!url || url.length > 2000) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

// Only AWB-sized values are looked up; anything longer is not a tracking
// id (and would only feed the normalizer regexes junk).
export function isLookupTracking(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TRACKER_LENGTH;
}

// Candidate keys for one scanned barcode: as typed, the VMS cache form and
// Forward Scan's canonical form (they only differ for odd characters).
export function trackingCandidates(trackingId: string, extra: string[] = []): string[] {
  const values = [trackingId, ...extra, normalizeForwardScanTracking(trackingId)];
  return [...new Set(values.map((v) => (v || '').slice(0, MAX_TRACKER_LENGTH).trim()).filter(Boolean))];
}
