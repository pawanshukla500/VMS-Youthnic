// Forward Scan -> VMS order copy (replaces the OMSGuru auto-sync).
//
// Every run reads the last FORWARD_SCAN_RETENTION_DAYS (default 3) of AWBs
// from the Forward Scan database, writes only rows whose content changed
// (sha1 per row), never overwrites rows an admin entered or corrected by
// hand, copies new/changed SKU photos by (updated_at, sku) cursor, and
// deletes orders older than the window (EXPIRED_ORDER_SQL; also every night
// at FORWARD_SCAN_PURGE_HOUR_IST via purgeExpiredOrders, even while the
// Forward Scan database is unreachable). Zero OMSGuru API calls. Forward
// Scan's database is only ever read (source.ts enforces it).
//
// Hand-entered SKU photos live in their own sku_images rows
// (source = 'manual'), so the copy never overwrites them and deleting one
// brings the Forward Scan photo back.
import type { Pool } from 'pg';
import {
  dedupeByTracking,
  forwardScanTimeToIso,
  isExcludedMarketplace,
  mapForwardScanOrder,
  mapForwardScanPhoto,
  MarketplaceOrderRecord,
  SkuImageRecord,
  toForwardScanTime,
} from './mappers';
import type { ForwardScanSource, PhotoCursor } from './source';

export const DEFAULT_RETENTION_DAYS = 3;
const UPSERT_BATCH = 500;
const PHOTO_PAGE = 2000;
const PHOTO_PAGES_PER_RUN = 25;
// Forward Scan stamps updated_at before its (multi-threaded) write commits,
// so a row can appear behind the cursor: every run re-reads this much.
const PHOTO_OVERLAP_MS = 5 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// When a copied order has expired (72 h with the default 3 days):
//   - Forward Scan rows: 72 h after the AWB date (the mapper's AWB, else
//     invoice, else first-seen date: the same date the copy window uses).
//     A later change in Forward Scan (status, items) never extends it, and
//     an older AWB copied at scan time goes at the next run (it is read
//     from Forward Scan again if that parcel is looked up again).
//   - hand-entered / hand-corrected rows: 72 h after their last edit.
// $2 = cutoff (now - retention). Rows inside the copy window (AWB date >=
// cutoff) never match, so the copy never deletes and re-inserts a row.
export const EXPIRED_ORDER_SQL = `GREATEST(
    COALESCE(awb_generated_at, created_at),
    CASE WHEN manual_override OR source <> 'forward-scan' THEN updated_at END
  ) < $2`;

export function buildExpiredOrdersDelete(organizationId: string, cutoff: Date): { text: string; values: unknown[] } {
  return {
    text: `DELETE FROM marketplace_orders WHERE organization_id = $1 AND ${EXPIRED_ORDER_SQL}`,
    values: [organizationId, cutoff.toISOString()],
  };
}

export interface ExpiredOrdersPurgeResult {
  cutoff: string;
  purged: number;
  byOrganization: Record<string, number>;
  vacuumed: boolean;
}

// Nightly clean-up of the copy: every organization's expired orders, then
// VACUUM (ANALYZE) so the table and its indexes stay small and the planner
// stats fresh. Touches only VMS's own marketplace_orders, never Forward Scan.
export async function purgeExpiredOrders(
  pool: Pick<Pool, 'query'>,
  options: { retentionDays: number; now?: Date }
): Promise<ExpiredOrdersPurgeResult> {
  const now = options.now || new Date();
  const cutoff = new Date(now.getTime() - options.retentionDays * 24 * 3600 * 1000);
  const result: ExpiredOrdersPurgeResult = { cutoff: cutoff.toISOString(), purged: 0, byOrganization: {}, vacuumed: false };
  const orgs = await pool.query(`SELECT DISTINCT organization_id FROM marketplace_orders`);
  for (const row of orgs.rows) {
    const organizationId = String(row.organization_id);
    const del = buildExpiredOrdersDelete(organizationId, cutoff);
    const res = await pool.query(del.text, del.values);
    const count = res.rowCount ?? 0;
    result.byOrganization[organizationId] = count;
    result.purged += count;
  }
  try {
    await pool.query('VACUUM (ANALYZE) marketplace_orders');
    result.vacuumed = true;
  } catch (err) {
    // Not the table owner, or a VACUUM already running: autovacuum covers it.
    console.warn('[forward-scan] nightly VACUUM (ANALYZE) marketplace_orders skipped:', errorMessage(err));
  }
  return result;
}

export function retentionDaysFrom(value: unknown): number {
  const days = Number(value);
  if (!Number.isFinite(days) || days < 1) return DEFAULT_RETENTION_DAYS;
  return Math.min(30, Math.floor(days));
}

// Copy cadence: every 5 minutes by default (orders are being processed in
// Forward Scan all day; a scan-time miss still reads that one AWB straight
// from the Forward Scan DB, so packers never wait for the next copy).
export const DEFAULT_SYNC_INTERVAL_SECONDS = 300;

export function syncIntervalSecondsFrom(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_SYNC_INTERVAL_SECONDS;
  return Math.min(3600, Math.max(30, Math.floor(seconds)));
}

export function parseOrganizationIds(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(',').map((s) => s.trim()).filter((s) => UUID_PATTERN.test(s)))];
}

export interface TargetOrganizations {
  ids: string[];
  // Why nobody receives the copy (shown on the status card / logged).
  reason: string | null;
}

// Forward Scan serves ONE business (one OMSGuru account), so its orders must
// never fan out to other tenants. FORWARD_SCAN_ORG_IDS pins the receiving
// organizations (active ones only); unset means the single active
// organization, and nobody (fail closed) when several are active.
export function pickTargetOrganizations(activeIds: string[], configured: unknown): TargetOrganizations {
  const pinned = parseOrganizationIds(configured);
  if (pinned.length > 0) {
    const ids = activeIds.filter((id) => pinned.includes(id));
    return { ids, reason: ids.length > 0 ? null : 'FORWARD_SCAN_ORG_IDS matches no active organization' };
  }
  if (activeIds.length === 1) return { ids: activeIds, reason: null };
  return {
    ids: [],
    reason: activeIds.length === 0
      ? 'no active organization'
      : `${activeIds.length} organizations are active — set FORWARD_SCAN_ORG_IDS to the one that owns the Forward Scan orders`,
  };
}

export async function resolveTargetOrganizations(pool: Pool, configured: unknown): Promise<TargetOrganizations> {
  const res = await pool.query(`SELECT id FROM organizations WHERE COALESCE(active, TRUE) = TRUE ORDER BY id`);
  return pickTargetOrganizations(res.rows.map((row: any) => String(row.id)), configured);
}

export const UPSERT_ORDERS_SQL = `
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
    r.shipping_company, r.order_type, r.order_date, r.awb_generated_at, r.sla_date, 'forward-scan',
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
    channel_id = EXCLUDED.channel_id,
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
    sla_date = EXCLUDED.sla_date,
    source_row_id = EXCLUDED.source_row_id,
    source_synced_at = EXCLUDED.source_synced_at,
    source_hash = EXCLUDED.source_hash,
    synced_at = NOW(),
    updated_at = NOW()
  WHERE marketplace_orders.source = 'forward-scan' AND marketplace_orders.manual_override = FALSE`;

export const UPSERT_PHOTOS_SQL = `
  INSERT INTO sku_images (organization_id, sku, sku_key, title, image_url, marketplace, source, source_updated_at, updated_at)
  SELECT $1::uuid, r.sku, r.sku_key, r.title, r.image_url, r.marketplace, 'forward-scan', r.source_updated_at, NOW()
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
  WHERE sku_images.sku IS DISTINCT FROM EXCLUDED.sku
     OR sku_images.title IS DISTINCT FROM COALESCE(EXCLUDED.title, sku_images.title)
     OR sku_images.image_url IS DISTINCT FROM EXCLUDED.image_url
     OR sku_images.marketplace IS DISTINCT FROM COALESCE(EXCLUDED.marketplace, sku_images.marketplace)`;

// Where a run starts reading photos: PHOTO_OVERLAP_MS before the saved
// cursor (unchanged rows in the overlap are skipped by the upsert).
export function photoReadStart(cursor: PhotoCursor): PhotoCursor {
  const iso = forwardScanTimeToIso(cursor.updatedAt);
  if (!iso) return { updatedAt: null, sku: null };
  return { updatedAt: toForwardScanTime(new Date(Date.parse(iso) - PHOTO_OVERLAP_MS)), sku: '' };
}

export interface ExistingOrderState {
  source_hash: string | null;
  source: string;
  manual_override: boolean;
}

// Which mapped rows actually need a write: new AWBs, or Forward Scan rows
// whose content hash moved. Manual rows / overrides are left alone.
export function selectChangedOrders(
  records: MarketplaceOrderRecord[],
  existing: Map<string, ExistingOrderState>
): { changed: MarketplaceOrderRecord[]; skippedManual: number } {
  const changed: MarketplaceOrderRecord[] = [];
  let skippedManual = 0;
  for (const record of records) {
    const current = existing.get(record.tracking_id);
    if (!current) {
      changed.push(record);
      continue;
    }
    if (current.source !== 'forward-scan' || current.manual_override) {
      skippedManual += 1;
      continue;
    }
    if (current.source_hash !== record.source_hash) changed.push(record);
  }
  return { changed, skippedManual };
}

export async function upsertOrders(pool: Pool, organizationId: string, records: MarketplaceOrderRecord[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < records.length; i += UPSERT_BATCH) {
    const batch = records.slice(i, i + UPSERT_BATCH);
    const res = await pool.query(UPSERT_ORDERS_SQL, [organizationId, JSON.stringify(batch)]);
    written += res.rowCount ?? 0;
  }
  return written;
}

function dedupePhotos(records: SkuImageRecord[]): SkuImageRecord[] {
  const byKey = new Map<string, SkuImageRecord>();
  for (const record of records) byKey.set(record.sku_key, record);
  return [...byKey.values()];
}

async function upsertPhotos(pool: Pool, organizationId: string, records: SkuImageRecord[]): Promise<number> {
  let written = 0;
  const unique = dedupePhotos(records);
  for (let i = 0; i < unique.length; i += UPSERT_BATCH) {
    const res = await pool.query(UPSERT_PHOTOS_SQL, [organizationId, JSON.stringify(unique.slice(i, i + UPSERT_BATCH))]);
    written += res.rowCount ?? 0;
  }
  return written;
}

async function loadPhotoCursor(pool: Pool, organizationId: string): Promise<PhotoCursor> {
  const res = await pool.query(
    `SELECT photo_cursor_at, photo_cursor_sku FROM forward_scan_sync_state WHERE organization_id = $1`,
    [organizationId]
  );
  return { updatedAt: res.rows[0]?.photo_cursor_at || null, sku: res.rows[0]?.photo_cursor_sku || null };
}

export interface OrgSyncResult {
  organizationId: string;
  ordersSeen: number;
  ordersWritten: number;
  skippedManual: number;
  photosWritten: number;
  purged: number;
  error?: string;
}

export interface ForwardScanSyncResult {
  ok: boolean;
  ordersRead: number;
  cutoff: string;
  durationMs: number;
  results: OrgSyncResult[];
  error?: string;
}

async function recordState(
  pool: Pool,
  organizationId: string,
  state: {
    ok: boolean;
    error?: string | null;
    result?: OrgSyncResult;
    cursor?: PhotoCursor;
    durationMs: number;
    source: string;
    sourceCanWrite?: boolean | null;
  }
): Promise<void> {
  await pool.query(
    `INSERT INTO forward_scan_sync_state (
        organization_id, photo_cursor_at, photo_cursor_sku, last_run_at, last_success_at, last_error,
        last_orders_seen, last_orders_written, last_photos_written, last_purged, last_duration_ms, source,
        source_can_write, updated_at
      )
     VALUES ($1, $2, $3, NOW(), CASE WHEN $4 THEN NOW() ELSE NULL END, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
     ON CONFLICT (organization_id) DO UPDATE SET
       photo_cursor_at = COALESCE(EXCLUDED.photo_cursor_at, forward_scan_sync_state.photo_cursor_at),
       photo_cursor_sku = COALESCE(EXCLUDED.photo_cursor_sku, forward_scan_sync_state.photo_cursor_sku),
       last_run_at = NOW(),
       last_success_at = CASE WHEN $4 THEN NOW() ELSE forward_scan_sync_state.last_success_at END,
       last_error = EXCLUDED.last_error,
       last_orders_seen = CASE WHEN $4 THEN EXCLUDED.last_orders_seen ELSE forward_scan_sync_state.last_orders_seen END,
       last_orders_written = CASE WHEN $4 THEN EXCLUDED.last_orders_written ELSE forward_scan_sync_state.last_orders_written END,
       last_photos_written = CASE WHEN $4 THEN EXCLUDED.last_photos_written ELSE forward_scan_sync_state.last_photos_written END,
       last_purged = CASE WHEN $4 THEN EXCLUDED.last_purged ELSE forward_scan_sync_state.last_purged END,
       last_duration_ms = EXCLUDED.last_duration_ms,
       source = EXCLUDED.source,
       source_can_write = COALESCE(EXCLUDED.source_can_write, forward_scan_sync_state.source_can_write),
       updated_at = NOW()`,
    [
      organizationId,
      state.cursor?.updatedAt ?? null,
      state.cursor?.sku ?? null,
      state.ok,
      state.error ? state.error.slice(0, 500) : null,
      state.result?.ordersSeen ?? 0,
      state.result?.ordersWritten ?? 0,
      state.result?.photosWritten ?? 0,
      state.result?.purged ?? 0,
      state.durationMs,
      state.source,
      state.sourceCanWrite ?? null,
    ]
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runForwardScanSync(
  pool: Pool,
  openSource: () => ForwardScanSource,
  options: { organizationIds: string[]; retentionDays: number; sourceLabel: string; excludedMarketplaces?: string[]; now?: Date }
): Promise<ForwardScanSyncResult> {
  const started = Date.now();
  const now = options.now || new Date();
  const cutoffDate = new Date(now.getTime() - options.retentionDays * 24 * 3600 * 1000);
  const cutoff = toForwardScanTime(cutoffDate);
  const results: OrgSyncResult[] = [];
  let source: ForwardScanSource | null = null;

  try {
    source = openSource();
    const rows = await source.fetchOrdersSince(cutoff);
    // Is the login a SELECT-only role? (VMS only reads either way.)
    const sourceCanWrite = source.canWrite ? await source.canWrite().catch(() => null) : null;
    const excluded = options.excludedMarketplaces || [];
    const records = dedupeByTracking(
      rows
        .map(mapForwardScanOrder)
        .filter((r): r is MarketplaceOrderRecord => r !== null && !isExcludedMarketplace(r, excluded))
    );

    for (const organizationId of options.organizationIds) {
      const result: OrgSyncResult = { organizationId, ordersSeen: records.length, ordersWritten: 0, skippedManual: 0, photosWritten: 0, purged: 0 };
      let cursor: PhotoCursor | undefined;
      try {
        const existingRes = await pool.query(
          `SELECT tracking_id, source_hash, source, manual_override FROM marketplace_orders WHERE organization_id = $1`,
          [organizationId]
        );
        const existing = new Map<string, ExistingOrderState>(
          existingRes.rows.map((row: any) => [String(row.tracking_id), {
            source_hash: row.source_hash ?? null,
            source: String(row.source || ''),
            manual_override: Boolean(row.manual_override),
          }])
        );
        const { changed, skippedManual } = selectChangedOrders(records, existing);
        result.skippedManual = skippedManual;
        result.ordersWritten = await upsertOrders(pool, organizationId, changed);

        cursor = await loadPhotoCursor(pool, organizationId);
        let readFrom = photoReadStart(cursor);
        for (let page = 0; page < PHOTO_PAGES_PER_RUN; page++) {
          const photoRows = await source.fetchPhotosAfter(readFrom, PHOTO_PAGE);
          if (photoRows.length === 0) break;
          const photos = photoRows.map(mapForwardScanPhoto).filter((p): p is SkuImageRecord => p !== null);
          result.photosWritten += await upsertPhotos(pool, organizationId, photos);
          const last = photoRows[photoRows.length - 1];
          readFrom = {
            updatedAt: last.updated_at == null ? readFrom.updatedAt : String(last.updated_at),
            sku: last.sku == null ? readFrom.sku : String(last.sku),
          };
          // The overlap re-reads rows at/behind the saved cursor: only move it forward.
          if (readFrom.updatedAt && (!cursor.updatedAt || `${readFrom.updatedAt}|${readFrom.sku}` > `${cursor.updatedAt}|${cursor.sku}`)) {
            cursor = readFrom;
          }
          if (photoRows.length < PHOTO_PAGE) break;
        }

        const expired = buildExpiredOrdersDelete(organizationId, cutoffDate);
        const purgeRes = await pool.query(expired.text, expired.values);
        result.purged = purgeRes.rowCount ?? 0;
        // Marketplaces taken off the copy: drop their copied rows (hand-made
        // and corrected rows stay — someone typed those on purpose).
        if (excluded.length > 0) {
          const excludedRes = await pool.query(
            `DELETE FROM marketplace_orders
             WHERE organization_id = $1 AND source = 'forward-scan' AND manual_override = FALSE
               AND (LOWER(BTRIM(COALESCE(marketplace, ''))) = ANY($2::text[])
                 OR LOWER(BTRIM(COALESCE(channel_marketplace, ''))) = ANY($2::text[]))`,
            [organizationId, excluded]
          );
          result.purged += excludedRes.rowCount ?? 0;
        }
        await recordState(pool, organizationId, {
          ok: true, result, cursor, durationMs: Date.now() - started, source: options.sourceLabel, sourceCanWrite,
        });
      } catch (err) {
        result.error = errorMessage(err);
        await recordState(pool, organizationId, { ok: false, error: result.error, durationMs: Date.now() - started, source: options.sourceLabel }).catch(() => undefined);
      }
      results.push(result);
    }

    const failed = results.filter((r) => r.error);
    return {
      ok: failed.length === 0,
      ordersRead: records.length,
      cutoff,
      durationMs: Date.now() - started,
      results,
      ...(failed.length > 0 ? { error: failed[0].error } : {}),
    };
  } catch (err) {
    // Source unreachable (file not mounted, DB down): record it per org so
    // the admin card shows why the copy is stale; existing rows stay.
    const message = errorMessage(err);
    for (const organizationId of options.organizationIds) {
      await recordState(pool, organizationId, { ok: false, error: message, durationMs: Date.now() - started, source: options.sourceLabel }).catch(() => undefined);
    }
    return { ok: false, ordersRead: 0, cutoff, durationMs: Date.now() - started, results, error: message };
  } finally {
    await source?.close().catch(() => undefined);
  }
}

// Order Imports: order date (fallback AWB date) for uploaded AWBs that are
// no longer — or not yet — in the 3-day copy. Keyed by canonical AWB.
export async function lookupForwardScanOrderDates(
  openSource: () => ForwardScanSource,
  trackingIds: string[],
  excludedMarketplaces: string[] = []
): Promise<Map<string, { orderDate: string; marketplace: string | null }>> {
  const out = new Map<string, { orderDate: string; marketplace: string | null }>();
  const ids = [...new Set(trackingIds.filter(Boolean))];
  if (ids.length === 0) return out;
  let source: ForwardScanSource | null = null;
  try {
    source = openSource();
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await source.fetchOrdersByTracking(ids.slice(i, i + 500));
      for (const row of rows) {
        const record = mapForwardScanOrder(row);
        if (!record || isExcludedMarketplace(record, excludedMarketplaces)) continue;
        const orderDate = record.order_date || record.awb_generated_at;
        if (orderDate) out.set(record.tracking_id, { orderDate, marketplace: record.marketplace });
      }
    }
    return out;
  } finally {
    await source?.close().catch(() => undefined);
  }
}

// Scan-time miss: an AWB generated after the last copy run. Read just that
// row straight from Forward Scan (a local DB read, still no OMSGuru call)
// and keep it, so the packing card resolves on the first scan.
export async function copyOneForwardScanOrder(
  pool: Pool,
  organizationId: string,
  openSource: () => ForwardScanSource,
  trackingIds: string[],
  excludedMarketplaces: string[] = []
): Promise<MarketplaceOrderRecord | null> {
  let source: ForwardScanSource | null = null;
  try {
    source = openSource();
    const row = await source.fetchOrderByTracking(trackingIds);
    const record = row ? mapForwardScanOrder(row) : null;
    if (!record || isExcludedMarketplace(record, excludedMarketplaces)) return null;
    await upsertOrders(pool, organizationId, [record]);
    return record;
  } finally {
    await source?.close().catch(() => undefined);
  }
}
