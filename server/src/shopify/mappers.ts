// Pure mappers: Shopify database rows -> VMS marketplace_orders / sku_images rows.
//
// Strictly respects privacy: Buyer PII (customerName, customerPhone, customerAddress,
// customerCity, customerState, customerPincode) is NEVER copied to VMS.
// Only tracking id, order name, SKUs, quantities, photos, courier, and status are synced.

import { createHash } from 'crypto';
import { MAX_TRACKER_LENGTH, normalizeImageUrl, normalizeSkuKey } from '../omsguru/mappers';
import { isColorConflicting } from '../omsguru/colorMatch';
import type {
  MarketplaceOrderItem,
  MarketplaceOrderRecord,
  SkuImageRecord,
} from '../forwardScan/mappers';
import type { ShopifyItemRow, ShopifyOrderRow } from './source';

export { normalizeSkuKey };

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

export function normalizeShopifyTracking(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .slice(0, MAX_TRACKER_LENGTH)
    .replace(/\s*\([^()]*\)\s*/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9\-_/]/g, '')
    .replace(/^[-_/]+|[-_/]+$/g, '');
}

/**
 * Normalizes Shopify order name for video naming and search:
 * '#26YOU6345' -> '26YOU6345'
 * '26YOU6231-EX-FWD' -> '26YOU6231-EX-FWD'
 * Falls back to shopifyOrderId if orderName is missing.
 */
export function shopifyOrderIdentity(
  shopifyOrderName: unknown,
  shopifyOrderId: unknown
): string | null {
  const rawName = clean(shopifyOrderName);
  if (rawName) {
    const stripped = rawName.replace(/^#+/, '').trim();
    if (stripped) return stripped;
  }
  return clean(shopifyOrderId);
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseShopifyItems(
  itemsJson: unknown,
  channelOrderId: string | null
): MarketplaceOrderItem[] {
  let raw: unknown = itemsJson;
  if (typeof itemsJson === 'string') {
    try {
      raw = JSON.parse(itemsJson || '[]');
    } catch {
      raw = [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const qty = Number(item.quantity ?? item.qty);
      const rawUrl = normalizeImageUrl(item.imageUrl ?? item.image_url);
      const sku = clean(item.sku) || 'UNKNOWN';
      const title = clean(item.title);
      // Validate photo against SKU color conflict
      const validUrl = rawUrl && !isColorConflicting(sku, title, rawUrl) ? rawUrl : null;
      return {
        sku,
        title,
        quantity: Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 1,
        imageUrl: validUrl,
        channelOrderId,
        subOrderId: null,
        status: clean(item.status),
      };
    });
}

export function hashShopifyOrderRecord(
  record: Omit<MarketplaceOrderRecord, 'source_hash' | 'source_synced_at' | 'source_row_id'>
): string {
  return createHash('sha1').update(JSON.stringify(record)).digest('hex');
}

export function mapShopifyOrder(row: ShopifyOrderRow): MarketplaceOrderRecord | null {
  const trackingId = normalizeShopifyTracking(row.waybill_number);
  if (!trackingId) return null;

  const channelOrderId = clean(row.shopify_order_name);
  const invoiceId = clean(row.shopify_order_id);
  const orderId = shopifyOrderIdentity(row.shopify_order_name, row.shopify_order_id);
  const items = parseShopifyItems(row.items, channelOrderId);
  const totalQty = items.reduce((sum, item) => sum + item.quantity, 0);

  const base: Omit<MarketplaceOrderRecord, 'source_hash' | 'source_synced_at' | 'source_row_id'> = {
    tracking_id: trackingId,
    tracking_raw: clean(row.waybill_number),
    marketplace: 'Shopify',
    channel_marketplace: 'Shopify',
    channel_name: clean(row.sales_channel) || 'Shopify',
    channel_id: null,
    company: 'Youthnic',
    is_meesho: false,
    order_id: orderId,
    channel_order_id: channelOrderId,
    sub_order_ids: null,
    invoice_id: invoiceId,
    items,
    item_count: items.length,
    total_qty: totalQty,
    status: clean(row.shipment_status) || clean(row.order_status),
    status_group: clean(row.tracking_status),
    shipping_company: clean(row.courier),
    order_type: clean(row.payment_method),
    order_date: toIsoString(row.order_created_at),
    awb_generated_at: toIsoString(row.shipment_created_at) || toIsoString(row.order_created_at),
    sla_date: null,
  };

  return {
    ...base,
    source_row_id: toInt(row.shipment_id),
    source_synced_at: new Date().toISOString(),
    source_hash: hashShopifyOrderRecord(base),
  };
}

export function mapShopifyPhotos(row: ShopifyOrderRow): SkuImageRecord[] {
  const records: SkuImageRecord[] = [];
  let items: ShopifyItemRow[] = [];
  if (Array.isArray(row.items)) {
    items = row.items;
  } else if (typeof row.items === 'string') {
    try {
      items = JSON.parse(row.items);
    } catch {
      items = [];
    }
  }

  const updatedAt = toIsoString(row.order_updated_at || row.order_created_at);

  for (const item of items) {
    const sku = clean(item.sku);
    const rawUrl = normalizeImageUrl(item.imageUrl);
    const title = clean(item.title);
    if (!sku || !rawUrl) continue;
    if (isColorConflicting(sku, title, rawUrl)) continue;

    records.push({
      sku,
      sku_key: normalizeSkuKey(sku),
      title,
      image_url: rawUrl,
      marketplace: 'Shopify',
      source_updated_at: updatedAt,
    });
  }

  return records;
}
