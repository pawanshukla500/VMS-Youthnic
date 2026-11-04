// Shopify -> VMS order copy.
//
// Reads recent orders and shipments from the remote Shopify PostgreSQL database,
// maps them into marketplace_orders (source = 'shopify') and sku_images (source = 'shopify'),
// and updates the local sync state.
// All access to the Shopify database is strictly read-only.
import type { Pool } from 'pg';
import {
  mapShopifyOrder,
  mapShopifyPhotos,
} from './mappers';
import {
  openShopifySource,
  type ShopifySource,
} from './source';
import type {
  MarketplaceOrderRecord,
  SkuImageRecord,
} from '../forwardScan/mappers';

export const DEFAULT_SHOPIFY_RETENTION_DAYS = 3;
const UPSERT_BATCH = 500;

export function openConfiguredShopifySource(profile: 'sync' | 'scan' = 'sync'): ShopifySource | null {
  const url = process.env.SHOPIFY_DATABASE_URL;
  if (!url) return null;
  return openShopifySource(url, profile);
}

export const UPSERT_SHOPIFY_ORDERS_SQL = `
  INSERT INTO marketplace_orders (
    organization_id, tracking_id, tracking_raw, marketplace, channel_marketplace, channel_name,
    channel_id, company, is_meesho, order_id, channel_order_id, sub_order_ids, invoice_id,
    items, item_count, total_qty, status, status_group, shipping_company, order_type,
    order_date, awb_generated_at, sla_date, source, source_row_id, source_synced_at,
    source_hash, synced_at, updated_at
  )
  SELECT $1::uuid, r.tracking_id, r.tracking_raw, r.marketplace, r.channel_marketplace, r.channel_name,
    r.channel_id, r.company, COALESCE(r.is_meesho, FALSE), r.order_id, r.channel_order_id, r.sub_order_ids, r.invoice_id,
    COALESCE(r.items, '[]'::jsonb), COALESCE(r.item_count, 0), COALESCE(r.total_qty, 0), r.status, r.status_group,
    r.shipping_company, r.order_type, r.order_date, r.awb_generated_at, r.sla_date, 'shopify',
    r.source_row_id, r.source_synced_at, r.source_hash, NOW(), NOW()
  FROM jsonb_to_recordset($2::jsonb) AS r(
    tracking_id TEXT, tracking_raw TEXT, marketplace TEXT, channel_marketplace TEXT, channel_name TEXT,
    channel_id INTEGER, company TEXT, is_meesho BOOLEAN, order_id TEXT, channel_order_id TEXT,
    sub_order_ids TEXT, invoice_id TEXT, items JSONB, item_count INTEGER, total_qty INTEGER,
    status TEXT, status_group TEXT, shipping_company TEXT, order_type TEXT,
    order_date TIMESTAMPTZ, awb_generated_at TIMESTAMPTZ, sla_date TIMESTAMPTZ,
    source_row_id BIGINT, source_synced_at TIMESTAMPTZ, source_hash TEXT
  )
  ON CONFLICT (organization_id, tracking_id) DO UPDATE SET
    tracking_raw = EXCLUDED.tracking_raw,
    marketplace = EXCLUDED.marketplace,
    channel_marketplace = EXCLUDED.channel_marketplace,
    channel_name = EXCLUDED.channel_name,
    company = EXCLUDED.company,
    is_meesho = EXCLUDED.is_meesho,
    order_id = EXCLUDED.order_id,
    channel_order_id = EXCLUDED.channel_order_id,
    sub_order_ids = EXCLUDED.sub_order_ids,
    invoice_id = EXCLUDED.invoice_id,
    items = EXCLUDED.items,
    item_count = EXCLUDED.item_count,
    total_qty = EXCLUDED.total_qty,
    status = EXCLUDED.status,
    status_group = EXCLUDED.status_group,
    shipping_company = EXCLUDED.shipping_company,
    order_type = EXCLUDED.order_type,
    order_date = EXCLUDED.order_date,
    awb_generated_at = EXCLUDED.awb_generated_at,
    source_row_id = EXCLUDED.source_row_id,
    source_synced_at = EXCLUDED.source_synced_at,
    source_hash = EXCLUDED.source_hash,
    synced_at = NOW(),
    updated_at = NOW()
  WHERE marketplace_orders.source = 'shopify' AND marketplace_orders.manual_override = FALSE`;

export const UPSERT_SHOPIFY_PHOTOS_SQL = `
  INSERT INTO sku_images (organization_id, sku, sku_key, title, image_url, marketplace, source, source_updated_at, updated_at)
  SELECT $1::uuid, r.sku, r.sku_key, r.title, r.image_url, r.marketplace, 'shopify', r.source_updated_at, NOW()
  FROM jsonb_to_recordset($2::jsonb) AS r(
    sku TEXT, sku_key TEXT, title TEXT, image_url TEXT, marketplace TEXT, source_updated_at TIMESTAMPTZ
  )
  ON CONFLICT (organization_id, sku_key, source) DO UPDATE SET
    sku = EXCLUDED.sku,
    title = COALESCE(EXCLUDED.title, sku_images.title),
    image_url = EXCLUDED.image_url,
    marketplace = COALESCE(EXCLUDED.marketplace, sku_images.marketplace),
    source_updated_at = EXCLUDED.source_updated_at,
    updated_at = NOW()
  WHERE (sku_images.sku IS DISTINCT FROM EXCLUDED.sku
     OR sku_images.title IS DISTINCT FROM COALESCE(EXCLUDED.title, sku_images.title)
     OR sku_images.image_url IS DISTINCT FROM EXCLUDED.image_url
     OR sku_images.marketplace IS DISTINCT FROM COALESCE(EXCLUDED.marketplace, sku_images.marketplace))
    AND (sku_images.source_updated_at IS NULL OR EXCLUDED.source_updated_at IS NULL OR EXCLUDED.source_updated_at >= sku_images.source_updated_at)`;

export interface ShopifyOrgSyncResult {
  organizationId: string;
  ordersSeen: number;
  ordersWritten: number;
  skippedManual: number;
  photosWritten: number;
  error?: string;
}

export interface ShopifySyncResult {
  ok: boolean;
  ordersRead: number;
  cutoff: string;
  durationMs: number;
  results: ShopifyOrgSyncResult[];
  error?: string;
}

export async function upsertShopifyOrders(
  pool: Pool,
  organizationId: string,
  records: MarketplaceOrderRecord[]
): Promise<number> {
  if (records.length === 0) return 0;
  let written = 0;
  for (let i = 0; i < records.length; i += UPSERT_BATCH) {
    const batch = records.slice(i, i + UPSERT_BATCH);
    const res = await pool.query(UPSERT_SHOPIFY_ORDERS_SQL, [organizationId, JSON.stringify(batch)]);
    written += res.rowCount ?? 0;
  }
  return written;
}

export async function upsertShopifyPhotos(
  pool: Pool,
  organizationId: string,
  records: SkuImageRecord[]
): Promise<number> {
  if (records.length === 0) return 0;
  let written = 0;
  for (let i = 0; i < records.length; i += UPSERT_BATCH) {
    const batch = records.slice(i, i + UPSERT_BATCH);
    const res = await pool.query(UPSERT_SHOPIFY_PHOTOS_SQL, [organizationId, JSON.stringify(batch)]);
    written += res.rowCount ?? 0;
  }
  return written;
}

export async function runShopifySync(
  pool: Pool,
  openSource: () => ShopifySource | null = () => openConfiguredShopifySource('sync'),
  options: {
    organizationIds: string[];
    retentionDays?: number;
    sourceLabel?: string;
    now?: Date;
  } = { organizationIds: [] }
): Promise<ShopifySyncResult> {
  const started = Date.now();
  const now = options.now || new Date();
  const retentionDays = options.retentionDays ?? DEFAULT_SHOPIFY_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 3600 * 1000);
  const cutoffIso = cutoff.toISOString();

  let source: ShopifySource | null = null;
  try {
    source = openSource();
    if (!source) {
      return {
        ok: false,
        ordersRead: 0,
        cutoff: cutoffIso,
        durationMs: Date.now() - started,
        results: [],
        error: 'SHOPIFY_DATABASE_URL is not configured',
      };
    }
    const rawOrders = await source.fetchOrdersSince(cutoffIso);
    const mappedOrders: MarketplaceOrderRecord[] = [];
    const allPhotos: SkuImageRecord[] = [];

    for (const row of rawOrders) {
      const mapped = mapShopifyOrder(row);
      if (mapped) mappedOrders.push(mapped);
      const photos = mapShopifyPhotos(row);
      allPhotos.push(...photos);
    }

    // Deduplicate mapped orders by tracking_id (keep newest shipment row)
    const byTracking = new Map<string, MarketplaceOrderRecord>();
    for (const rec of mappedOrders) {
      const existing = byTracking.get(rec.tracking_id);
      if (!existing || (rec.source_row_id ?? 0) >= (existing.source_row_id ?? 0)) {
        byTracking.set(rec.tracking_id, rec);
      }
    }
    const dedupedOrders = [...byTracking.values()];

    // Deduplicate photos by sku_key (keep newest source_updated_at)
    const bySkuKey = new Map<string, SkuImageRecord>();
    for (const p of allPhotos) {
      const existing = bySkuKey.get(p.sku_key);
      if (!existing || !existing.source_updated_at || (p.source_updated_at && p.source_updated_at >= existing.source_updated_at)) {
        bySkuKey.set(p.sku_key, p);
      }
    }
    const dedupedPhotos = [...bySkuKey.values()];

    const canWrite = source.canWrite ? await source.canWrite().catch(() => false) : false;
    const orgResults: ShopifyOrgSyncResult[] = [];

    for (const orgId of options.organizationIds) {
      try {
        const trackingList = dedupedOrders.map((o) => o.tracking_id);
        const existingRes = trackingList.length > 0
          ? await pool.query(
              `SELECT tracking_id, source_hash, source, manual_override
               FROM marketplace_orders
               WHERE organization_id = $1 AND tracking_id = ANY($2::text[])`,
              [orgId, trackingList]
            )
          : { rows: [] };

        const existingMap = new Map<string, { source_hash: string | null; source: string; manual_override: boolean }>();
        for (const row of existingRes.rows) {
          existingMap.set(row.tracking_id, {
            source_hash: row.source_hash,
            source: row.source,
            manual_override: Boolean(row.manual_override),
          });
        }

        const changed: MarketplaceOrderRecord[] = [];
        let skippedManual = 0;
        for (const rec of dedupedOrders) {
          const cur = existingMap.get(rec.tracking_id);
          if (!cur) {
            changed.push(rec);
            continue;
          }
          if (cur.source !== 'shopify' || cur.manual_override) {
            skippedManual += 1;
            continue;
          }
          if (cur.source_hash !== rec.source_hash) {
            changed.push(rec);
          }
        }

        const ordersWritten = changed.length > 0 ? await upsertShopifyOrders(pool, orgId, changed) : 0;
        const photosWritten = dedupedPhotos.length > 0 ? await upsertShopifyPhotos(pool, orgId, dedupedPhotos) : 0;

        await pool.query(
          `INSERT INTO shopify_sync_state (
             organization_id, last_run_at, last_success_at, last_error,
             last_orders_seen, last_orders_written, last_photos_written,
             last_duration_ms, source, source_can_write, updated_at
           ) VALUES ($1, NOW(), NOW(), NULL, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (organization_id) DO UPDATE SET
             last_run_at = NOW(),
             last_success_at = NOW(),
             last_error = NULL,
             last_orders_seen = EXCLUDED.last_orders_seen,
             last_orders_written = EXCLUDED.last_orders_written,
             last_photos_written = EXCLUDED.last_photos_written,
             last_duration_ms = EXCLUDED.last_duration_ms,
             source = EXCLUDED.source,
             source_can_write = EXCLUDED.source_can_write,
             updated_at = NOW()`,
          [orgId, dedupedOrders.length, ordersWritten, photosWritten, Date.now() - started, options.sourceLabel || null, canWrite]
        );

        orgResults.push({
          organizationId: orgId,
          ordersSeen: dedupedOrders.length,
          ordersWritten,
          skippedManual,
          photosWritten,
        });
      } catch (err: any) {
        const errorMsg = err?.message || String(err);
        await pool.query(
          `INSERT INTO shopify_sync_state (
             organization_id, last_run_at, last_error, last_duration_ms, source, updated_at
           ) VALUES ($1, NOW(), $2, $3, $4, NOW())
           ON CONFLICT (organization_id) DO UPDATE SET
             last_run_at = NOW(),
             last_error = EXCLUDED.last_error,
             last_duration_ms = EXCLUDED.last_duration_ms,
             source = EXCLUDED.source,
             updated_at = NOW()`,
          [orgId, errorMsg, Date.now() - started, options.sourceLabel || null]
        );
        orgResults.push({
          organizationId: orgId,
          ordersSeen: 0,
          ordersWritten: 0,
          skippedManual: 0,
          photosWritten: 0,
          error: errorMsg,
        });
      }
    }

    const orgErrors = orgResults.map((r) => r.error).filter(Boolean);
    const hasOrgErrors = orgErrors.length > 0;
    return {
      ok: !hasOrgErrors,
      ordersRead: dedupedOrders.length,
      cutoff: cutoffIso,
      durationMs: Date.now() - started,
      results: orgResults,
      ...(hasOrgErrors ? { error: orgErrors.join('; ') } : {}),
    };
  } catch (err: any) {
    return {
      ok: false,
      ordersRead: 0,
      cutoff: cutoffIso,
      durationMs: Date.now() - started,
      results: [],
      error: err?.message || String(err),
    };
  } finally {
    if (source) await source.close().catch(() => {});
  }
}

/**
 * Scan-time lookup: when an operator scans a Shopify tracking number that hasn't
 * been synced yet, fetch directly from the Shopify DB and insert into marketplace_orders.
 */
export async function copyOneShopifyOrder(
  pool: Pool,
  organizationId: string,
  trackingCandidates: string[],
  openSource?: () => ShopifySource | null
): Promise<MarketplaceOrderRecord | null> {
  let source: ShopifySource | null = null;
  try {
    source = openSource ? openSource() : openConfiguredShopifySource('scan');
    if (!source) return null;
    const row = await source.fetchOrderByTracking(trackingCandidates);
    if (!row) return null;
    const mapped = mapShopifyOrder(row);
    if (!mapped) return null;

    const written = await upsertShopifyOrders(pool, organizationId, [mapped]);

    const photos = mapShopifyPhotos(row);
    if (photos.length > 0) {
      await upsertShopifyPhotos(pool, organizationId, photos).catch((err) => {
        console.warn('[shopify-sync] single-order photo upsert failed:', err?.message || err);
      });
    }

    if (written === 0) {
      // If the upsert was guarded out by an existing manual override or non-Shopify row,
      // return the persisted database row rather than masking it with unpersisted Shopify data.
      const persisted = await pool.query(
        `SELECT tracking_id, tracking_raw, marketplace, channel_marketplace, channel_name,
                channel_id, company, is_meesho, order_id, channel_order_id, sub_order_ids, invoice_id,
                items, item_count, total_qty, status, status_group, shipping_company, order_type,
                order_date, awb_generated_at, sla_date, source_row_id, source_synced_at, source_hash
         FROM marketplace_orders
         WHERE organization_id = $1 AND tracking_id = $2
         LIMIT 1`,
        [organizationId, mapped.tracking_id]
      );
      if (persisted.rows.length > 0) {
        return persisted.rows[0] as MarketplaceOrderRecord;
      }
    }

    return mapped;
  } finally {
    if (source) await source.close().catch(() => {});
  }
}
