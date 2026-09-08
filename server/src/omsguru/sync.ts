// OMSGuru cache sync orchestration (cron + admin "run now").
// Listings (SKU photos) sweep all active channels; invoices (order lines
// by AWB) cover the recent window for one warehouse. Gentle pacing + 429
// backoff keep us inside the 60req/5min budget.
import type { Pool } from 'pg';
import { mapInvoiceToCachedOrder, mapListingToPhoto } from './mappers';
import { createOMSGuruClient, omsguruGentleDelay, OMSGuruCreds } from './client';

export interface SyncCreds extends OMSGuruCreds {
  warehouseId: string;
}

// DB settings row wins (rotatable from the admin UI); env is fallback.
export function resolveSyncCreds(
  row: { token?: string | null; cid?: string | null; warehouse_id?: string | null } | null,
  env: { token?: string; cid?: string; warehouseId?: string }
): SyncCreds {
  const token = (row?.token || '').trim() || (env.token || '').trim();
  const cid = (row?.cid || '').trim() || (env.cid || '').trim();
  const warehouseId = (row?.warehouse_id || '').trim() || (env.warehouseId || '').trim();
  if (!token || !cid) {
    throw new Error('OMSGuru is not configured (token / client ID)');
  }
  return { token, cid, warehouseId };
}

export function maskToken(token: string): string {
  if (!token) return '';
  return token.length <= 4 ? '••••' : `••••${token.slice(-4)}`;
}

// Cache freshness: positive rows (matched) live 24 hours — the packing
// floor works off daily synced data, and anything older revalidates.
export const POSITIVE_TTL_MS = 24 * 3600 * 1000;
export const NEGATIVE_TTL_MS = 1 * 3600 * 1000;

export function cacheDecision(
  row: { order_id?: string | null; items?: unknown; fetched_at?: string | Date | null } | null,
  nowMs: number
): 'use' | 'refresh' {
  if (!row?.fetched_at) return 'refresh';
  const age = nowMs - new Date(row.fetched_at).getTime();
  if (!Number.isFinite(age) || age < 0) return 'refresh';
  const items = Array.isArray(row.items) ? row.items : [];
  const positive = Boolean(row.order_id) || items.length > 0;
  if (positive) return age < POSITIVE_TTL_MS ? 'use' : 'refresh';
  return age < NEGATIVE_TTL_MS ? 'use' : 'refresh';
}

export function parseWarehouseIds(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

// AWB matching is suffix-tolerant: OMSGuru sometimes stores the tracker
// with a courier suffix ("MYEP1135031932 ( EK_E2E )") while the packer
// scans the bare barcode. Compare normalized forms; a prefix counts only
// when the next character is a non-alphanumeric separator (so "123" never
// matches "12345").
export function normalizeTracker(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .toUpperCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function trackerMatches(stored: unknown, scanned: string): boolean {
  const want = normalizeTracker(scanned);
  if (!want) return false;
  const have = normalizeTracker(stored);
  if (!have) return false;
  if (have === want) return true;
  if (have.startsWith(want)) {
    const next = have[want.length];
    if (next === undefined || /[^A-Z0-9]/.test(next)) return true;
  }
  return false;
}

export interface TrackerClient {
  listInvoicesPage(options: { start: number; end: number; warehouseId?: string; lastId: number; limit?: number }): Promise<any[]>;
  listOrdersPage?(options: { start: number; end: number; warehouseId: string; statusId?: string; lastId: number; limit?: number }): Promise<any[]>;
}

// Order statuses worth caching in the background poll: an order can sit in
// either when its parcel is scanned (Packed -> ReadyToShip). Scan-time live
// lookup uses all-status streams instead (see below).
export const PACKING_ORDER_STATUSES = ['1', '9', '16', '23', '18'];

export type TrackerLookupStatus = 'found' | 'not_found' | 'deadline' | 'budget' | 'error';
export interface TrackerLookupResult {
  status: TrackerLookupStatus;
  order: ReturnType<typeof mapInvoiceToCachedOrder>;
  error?: unknown;
}

async function boundedCall<T>(work: Promise<T>, deadlineAtMs: number): Promise<T | null> {
  if (deadlineAtMs <= 0) return work;
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Bounded live lookup. PROVEN LIVE: list endpoints paginate ASCENDING by
// internal id — last_id=0 starts at the OLDEST row in the window, not the
// newest. So phase 1 walks the invoice stream (all warehouses, no filter)
// through SHORT widening windows: a 6h window puts a just-packed parcel on
// page 1 instead of pages deep. Phase 2 sweeps per-warehouse all-status
// order streams (orders require warehouse_id; status omitted = all statuses)
// for pre-invoice open orders. Caps calls so one scan can never eat the
// 60req/5min budget.
const SCAN_PHASE_WINDOWS_SEC = [6 * 3600, 24 * 3600, 7 * 24 * 3600];
const SCAN_ORDERS_WINDOW_SEC = 48 * 3600;
const SCAN_PAGE_LIMIT = 50;

// List rows carry the tracker as shipment_tracker (tracking_id accepted as a
// fallback alias); anything else never matches.
function rowTrackerMatches(row: any, wanted: string): boolean {
  return trackerMatches(row?.shipment_tracker ?? row?.tracking_id, wanted);
}

export async function lookupOrderByTrackerDetailed(
  client: TrackerClient,
  warehouseIds: string[],
  trackingId: string,
  maxPagesPerWarehouse = 3,
  windowDays = 7,
  maxTotalCalls = 10,
  deadlineAtMs = 0
): Promise<TrackerLookupResult> {
  const wanted = normalizeTracker(trackingId);
  if (!wanted) return { status: 'not_found', order: null };
  const nowSec = Math.floor(Date.now() / 1000);
  // Hard deadline: throttled calls sleep Retry-After seconds each, which
  // would otherwise hang a scan for a minute+. Callers pass ~8s.
  const expired = () => deadlineAtMs > 0 && Date.now() > deadlineAtMs;
  let calls = 0;
  // maxPagesPerWarehouse now caps pages per phase window (name kept for
  // callers); maxTotalCalls still bounds the whole lookup.
  const checkBudget = (): TrackerLookupStatus | null => {
    if (expired()) return 'deadline';
    if (calls >= maxTotalCalls) return 'budget';
    return null;
  };
  const maxWindowSec = Math.max(3600, windowDays * 24 * 3600);
  const windows = SCAN_PHASE_WINDOWS_SEC.filter((w) => w <= maxWindowSec);
  if (windows.length === 0) windows.push(maxWindowSec);
  try {
    for (const windowSec of windows) {
      let lastId = 0;
      for (let page = 0; page < maxPagesPerWarehouse; page++) {
        const stop = checkBudget();
        if (stop) return { status: stop, order: null };
        calls += 1;
        const invoices = await boundedCall(
          client.listInvoicesPage({ start: nowSec - windowSec, end: nowSec, lastId, limit: SCAN_PAGE_LIMIT }),
          deadlineAtMs
        );
        if (!invoices) return { status: 'deadline', order: null };
        if (invoices.length === 0) break;
        const hit = invoices.find((o: any) => rowTrackerMatches(o, wanted));
        if (hit) {
          const mapped = mapInvoiceToCachedOrder(hit);
          if (mapped) return { status: 'found', order: mapped };
        }
        const ids = invoices.map((o: any) => Number(o.last_id || o.id || 0)).filter((n: number) => n > 0);
        if (ids.length === 0 || invoices.length < SCAN_PAGE_LIMIT) break;
        lastId = Math.max(...ids);
      }
    }

    if (typeof client.listOrdersPage === 'function') {
      const start = nowSec - Math.min(SCAN_ORDERS_WINDOW_SEC, maxWindowSec);
      for (const warehouseId of warehouseIds) {
        // One all-status page per warehouse inside the call budget; the
        // background poll keeps these rows warm in the cache anyway.
        const stop = checkBudget();
        if (stop) return { status: stop, order: null };
        calls += 1;
        const orders = await boundedCall(
          client.listOrdersPage({ start, end: nowSec, warehouseId, lastId: 0, limit: SCAN_PAGE_LIMIT }),
          deadlineAtMs
        );
        if (!orders) return { status: 'deadline', order: null };
        if (orders.length === 0) continue;
        const hit = orders.find((o: any) => rowTrackerMatches(o, wanted));
        if (hit) {
          const mapped = mapInvoiceToCachedOrder(hit);
          if (mapped) return { status: 'found', order: mapped };
        }
      }
    }
    return { status: 'not_found', order: null };
  } catch (error) {
    return { status: 'error', order: null, error };
  }
}

export async function lookupOrderByTracker(
  client: TrackerClient,
  warehouseIds: string[],
  trackingId: string,
  maxPagesPerWarehouse = 3,
  windowDays = 7,
  maxTotalCalls = 10,
  deadlineAtMs = 0
): Promise<ReturnType<typeof mapInvoiceToCachedOrder>> {
  const result = await lookupOrderByTrackerDetailed(
    client,
    warehouseIds,
    trackingId,
    maxPagesPerWarehouse,
    windowDays,
    maxTotalCalls,
    deadlineAtMs
  );
  return result.order;
}

const INVOICE_WINDOW_SEC = 3 * 24 * 3600;
const MAX_LISTING_PAGES = 50;
const ORDER_POLL_PAGE_LIMIT = 50;
const CACHE_ORDER_STATUSES = ['9', '1'];

// Background polling walks each feed from a persisted cursor (see
// omsguru_poll_state): list rows arrive oldest-first, so re-reading page 1
// every poll would re-cache the same stale rows forever while new parcels
// stay out of reach. Caps keep every poll inside the shared 60req/5min
// budget; catch-up simply continues on the next poll.
const POLL_INVOICE_WINDOW_SEC = 3 * 24 * 3600;
const POLL_ORDERS_WINDOW_SEC = 24 * 3600;
const POLL_FEED_PAGE_CAP = 3;
const POLL_GLOBAL_CALL_CAP = 24;
const SYNC_FEED_PAGE_CAP = 8;
const SYNC_GLOBAL_CALL_CAP = 40;

export async function getPollCursor(
  pool: Pool,
  organizationId: string,
  warehouseKey: string,
  feed: string
): Promise<number> {
  const res = await pool.query(
    `SELECT last_id FROM omsguru_poll_state
     WHERE organization_id = $1 AND warehouse_id = $2 AND feed = $3`,
    [organizationId, warehouseKey, feed]
  );
  return Number(res.rows[0]?.last_id || 0);
}

export async function setPollCursor(
  pool: Pool,
  organizationId: string,
  warehouseKey: string,
  feed: string,
  lastId: number
): Promise<void> {
  await pool.query(
    `INSERT INTO omsguru_poll_state (organization_id, warehouse_id, feed, last_id, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (organization_id, warehouse_id, feed) DO UPDATE SET
       last_id = GREATEST(omsguru_poll_state.last_id, EXCLUDED.last_id),
       updated_at = NOW()`,
    [organizationId, warehouseKey, feed, lastId]
  );
}

// Forward walk of one feed from its persisted cursor (see note above).
// Shared by the 5-minute poll (shallow caps) and the full sync (deep caps).
async function walkOrderFeed(
  pool: Pool,
  organizationId: string,
  spec: {
    warehouseKey: string;
    feed: string;
    pageCap: number;
    globalCap: number;
    fetchPage: (lastId: number) => Promise<any[]>;
    statusIdOverride?: string;
  },
  state: { orders: number; calls: number }
): Promise<void> {
  let cursor = await getPollCursor(pool, organizationId, spec.warehouseKey, spec.feed);
  for (let page = 0; page < spec.pageCap && state.calls < spec.globalCap; page++) {
    const rows = await spec.fetchPage(cursor);
    state.calls += 1;
    if (rows.length === 0) break;
    for (const row of rows) {
      if (await cacheOrder(pool, organizationId, mapInvoiceToCachedOrder(row), spec.statusIdOverride)) {
        state.orders += 1;
      }
    }
    const ids = rows.map((o: any) => Number(o.last_id || o.id || 0)).filter((n: number) => n > 0);
    if (ids.length > 0) {
      cursor = Math.max(cursor, ...ids);
      await setPollCursor(pool, organizationId, spec.warehouseKey, spec.feed, cursor);
    }
    if (rows.length < ORDER_POLL_PAGE_LIMIT || ids.length === 0) break;
    await omsguruGentleDelay();
  }
}

async function cacheOrder(
  pool: Pool,
  organizationId: string,
  cached: ReturnType<typeof mapInvoiceToCachedOrder>,
  statusIdOverride?: string
): Promise<boolean> {
  if (!cached) return false;
  const statusId = statusIdOverride || cached.statusId || null;
  const status = cached.status || null;
  // Explicit casts: node-pg sends NULL params untyped and PostgreSQL cannot
  // infer $6/$7 from context — without casts every status-less cache write
  // fails with "could not determine data type of parameter $6" (seen live).
  await pool.query(
    `INSERT INTO omsguru_order_cache (organization_id, tracking_id, order_id, marketplace, items, status_id, status, fetched_at, status_checked_at)
     VALUES ($1, $2, $3, $4, $5, $6::VARCHAR(20), $7::TEXT, NOW(), CASE WHEN $6 IS NULL AND $7 IS NULL THEN NULL ELSE NOW() END)
     ON CONFLICT (organization_id, tracking_id) DO UPDATE SET
       order_id = EXCLUDED.order_id, marketplace = EXCLUDED.marketplace,
       items = EXCLUDED.items, fetched_at = NOW(),
       status_id = COALESCE(EXCLUDED.status_id, omsguru_order_cache.status_id),
       status = COALESCE(EXCLUDED.status, omsguru_order_cache.status),
       status_checked_at = CASE
         WHEN EXCLUDED.status_id IS NOT NULL OR EXCLUDED.status IS NOT NULL THEN NOW()
         ELSE omsguru_order_cache.status_checked_at
       END`,
    [organizationId, cached.trackingId, cached.orderId, cached.marketplace, JSON.stringify(cached.items), statusId, status]
  );
  return true;
}

// Lightweight near-real-time order poll. Tracking IDs are created throughout
// the day, so waiting for the full photo/listing sweep would leave the SQL
// cache behind. Each feed (all-warehouse invoices, per-warehouse Packed /
// ReadyToShip orders) walks forward from its persisted cursor, so steady
// state costs ~1 short page per feed — far below the shared 60/5min OMSGuru
// budget — while no new parcel is ever out of reach.
export async function runOMSGuruOrderPoll(
  pool: Pool,
  organizationId: string,
  creds: SyncCreds
): Promise<{ orders: number; warehouseIds: number }> {
  const client = createOMSGuruClient(creds);
  const nowSec = Math.floor(Date.now() / 1000);
  const warehouseIds = parseWarehouseIds(creds.warehouseId);
  const state = { orders: 0, calls: 0 };

  // Invoices across ALL warehouses in one stream (no warehouse filter).
  await walkOrderFeed(pool, organizationId, {
    warehouseKey: '',
    feed: 'invoices',
    pageCap: POLL_FEED_PAGE_CAP,
    globalCap: POLL_GLOBAL_CALL_CAP,
    fetchPage: (lastId) => client.listInvoicesPage({
      start: nowSec - POLL_INVOICE_WINDOW_SEC,
      end: nowSec,
      lastId,
      limit: ORDER_POLL_PAGE_LIMIT,
    }),
  }, state);

  // Open packing statuses per configured warehouse (orders require it).
  if (typeof client.listOrdersPage === 'function') {
    for (const warehouseId of warehouseIds) {
      for (const statusId of CACHE_ORDER_STATUSES) {
        await walkOrderFeed(pool, organizationId, {
          warehouseKey: warehouseId,
          feed: `orders:${statusId}`,
          pageCap: POLL_FEED_PAGE_CAP,
          globalCap: POLL_GLOBAL_CALL_CAP,
          fetchPage: (lastId) => client.listOrdersPage({
            start: nowSec - POLL_ORDERS_WINDOW_SEC,
            end: nowSec,
            warehouseId,
            statusId,
            lastId,
            limit: ORDER_POLL_PAGE_LIMIT,
          }),
          statusIdOverride: statusId,
        }, state);
      }
    }
  }

  // If an order moved out of Packed/ReadyToShip, it stops being returned by
  // those status queries. Remove it after one missed daily freshness window;
  // the scan-time invoice lookup remains available for later shipment stages.
  await pool.query(
     `DELETE FROM omsguru_order_cache
     WHERE organization_id = $1
       AND status_id = ANY($2::varchar[])
       AND (status_checked_at IS NULL OR status_checked_at < NOW() - INTERVAL '24 hours')`,
    [organizationId, CACHE_ORDER_STATUSES]
  );

  return { orders: state.orders, warehouseIds: warehouseIds.length };
}

export async function runOMSGuruSync(
  pool: Pool,
  organizationId: string,
  creds: SyncCreds,
  options?: { skipInvoices?: boolean }
): Promise<{ photos: number; orders: number; warehouseId: string | null }> {
  const client = createOMSGuruClient(creds);
  const nowSec = Math.floor(Date.now() / 1000);
  let photos = 0;
  let orders = 0;

  // 1. SKU photos per active channel (listings rarely change; full sweep).
  const channels = await client.listActiveChannels();
  for (const channel of channels) {
    let lastId = 0;
    for (let page = 0; page < MAX_LISTING_PAGES; page++) {
      const listings = await client.listListingsPage(channel.id, lastId);
      if (listings.length === 0) break;
      for (const listing of listings) {
        const photo = mapListingToPhoto(listing, channel.channel);
        if (!photo) continue;
        await pool.query(
          `INSERT INTO omsguru_sku_photos (organization_id, sku, title, image_url, marketplace, fetched_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (organization_id, sku) DO UPDATE SET
             title = EXCLUDED.title, image_url = EXCLUDED.image_url,
             marketplace = EXCLUDED.marketplace, fetched_at = NOW()`,
          [organizationId, photo.sku, photo.title, photo.imageUrl, photo.marketplace]
        );
        photos += 1;
      }
      const ids = listings.map((l: any) => Number(l.id || 0)).filter((n: number) => n > 0);
      if (ids.length === 0) break;
      lastId = Math.max(...ids);
      await omsguruGentleDelay();
    }
    await omsguruGentleDelay();
  }

  // 2. Recent invoices -> order lines by AWB (packing reads these).
  // Skipped by the photo bootstrap: order lines resolve live per scan.
  // Same persisted cursors as the 5-minute poll, with deeper caps so each
  // full sync advances the backfill further (progressive catch-up).
  const warehouseIds = parseWarehouseIds(creds.warehouseId);
  const syncState = { orders: 0, calls: 0 };
  if (!options?.skipInvoices) {
    await walkOrderFeed(pool, organizationId, {
      warehouseKey: '',
      feed: 'invoices',
      pageCap: SYNC_FEED_PAGE_CAP,
      globalCap: SYNC_GLOBAL_CALL_CAP,
      fetchPage: (lastId) => client.listInvoicesPage({
        start: nowSec - INVOICE_WINDOW_SEC,
        end: nowSec,
        lastId,
        limit: ORDER_POLL_PAGE_LIMIT,
      }),
    }, syncState);
    if (typeof client.listOrdersPage === 'function') {
      for (const warehouseId of warehouseIds) {
        for (const statusId of CACHE_ORDER_STATUSES) {
          await walkOrderFeed(pool, organizationId, {
            warehouseKey: warehouseId,
            feed: `orders:${statusId}`,
            pageCap: 2,
            globalCap: SYNC_GLOBAL_CALL_CAP,
            fetchPage: (lastId) => client.listOrdersPage({
              start: nowSec - POLL_ORDERS_WINDOW_SEC,
              end: nowSec,
              warehouseId,
              statusId,
              lastId,
              limit: ORDER_POLL_PAGE_LIMIT,
            }),
            statusIdOverride: statusId,
          }, syncState);
        }
      }
    }
    orders += syncState.orders;
  }

  return { photos, orders, warehouseId: creds.warehouseId || null };
}

// Photo bootstrap: first packing scan of the day finds zero cached photos,
// so sweep listings once in the background (fire-and-forget, one flight per
// org at a time). Invoices are skipped here — order lines resolve live.
const photoBootstrapRunning = new Set<string>();

export function ensurePhotoBootstrap(
  pool: Pool,
  organizationId: string,
  buildCreds: () => Promise<SyncCreds>
): void {
  if (photoBootstrapRunning.has(organizationId)) return;
  photoBootstrapRunning.add(organizationId);
  (async () => {
    try {
      const countRes = await pool.query(
        `SELECT COUNT(*) as count FROM omsguru_sku_photos
         WHERE organization_id = $1 AND fetched_at >= NOW() - INTERVAL '24 hours'`,
        [organizationId]
      );
      if (Number(countRes.rows[0]?.count || 0) > 0) return;
      await runOMSGuruSync(pool, organizationId, await buildCreds(), { skipInvoices: true });
    } catch (err) {
      console.warn('Photo bootstrap skipped:', err instanceof Error ? err.message : err);
    } finally {
      photoBootstrapRunning.delete(organizationId);
    }
  })();
}
