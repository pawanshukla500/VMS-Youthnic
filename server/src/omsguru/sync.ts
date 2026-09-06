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

// Cache freshness: positive rows (matched) live 7 days; negative rows
// (AWB unknown) only 1 hour so a newly invoiced parcel resolves soon.
// Anything else triggers a bounded live lookup.
export const POSITIVE_TTL_MS = 7 * 24 * 3600 * 1000;
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
  listInvoicesPage(options: { start: number; end: number; warehouseId: string; lastId: number; limit?: number }): Promise<any[]>;
  listOrdersPage?(options: { start: number; end: number; warehouseId: string; statusId: string; lastId: number; limit?: number }): Promise<any[]>;
}

// Order statuses worth searching at pack time: an order can sit in any of
// these when its parcel is scanned (New -> Packed -> ReadyToShip ->
// InTransit). Shipped/completed orders surface through invoices instead.
export const PACKING_ORDER_STATUSES = ['1', '9', '16', '23', '18'];

// Bounded live lookup: recent invoices per warehouse, newest first,
// stops at the first AWB hit. Caps calls so one scan can never eat the
// 60req/5min budget (warehouses x pages).
export async function lookupOrderByTracker(
  client: TrackerClient,
  warehouseIds: string[],
  trackingId: string,
  maxPagesPerWarehouse = 3,
  windowDays = 7
): Promise<ReturnType<typeof mapInvoiceToCachedOrder>> {
  const wanted = normalizeTracker(trackingId);
  if (!wanted) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const start = nowSec - windowDays * 24 * 3600;
  for (const warehouseId of warehouseIds) {
    let lastId = 0;
    for (let page = 0; page < maxPagesPerWarehouse; page++) {
      const invoices = await client.listInvoicesPage({ start, end: nowSec, warehouseId, lastId, limit: 100 });
      if (invoices.length === 0) break;
      const hit = invoices.find((o: any) => trackerMatches(o?.shipment_tracker, wanted));
      if (hit) {
        const mapped = mapInvoiceToCachedOrder(hit);
        if (mapped) return mapped;
      }
      const ids = invoices.map((o: any) => Number(o.last_id || o.id || 0)).filter((n: number) => n > 0);
      if (ids.length === 0) break;
      lastId = Math.max(...ids);
    }
    if (typeof client.listOrdersPage === 'function') {
      for (const statusId of PACKING_ORDER_STATUSES) {
        const orders = await client.listOrdersPage({ start, end: nowSec, warehouseId, statusId, lastId: 0, limit: 100 });
        const hit = orders.find((o: any) => trackerMatches(o?.shipment_tracker, wanted));
        if (hit) {
          const mapped = mapInvoiceToCachedOrder(hit);
          if (mapped) return mapped;
        }
      }
    }
  }
  return null;
}

const INVOICE_WINDOW_SEC = 3 * 24 * 3600;
const MAX_LISTING_PAGES = 50;
const MAX_INVOICE_PAGES = 20;

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
  if (!options?.skipInvoices && creds.warehouseId) {
    let lastId = 0;
    for (let page = 0; page < MAX_INVOICE_PAGES; page++) {
      const invoices = await client.listInvoicesPage({
        start: nowSec - INVOICE_WINDOW_SEC,
        end: nowSec,
        warehouseId: creds.warehouseId,
        lastId,
        limit: 100,
      });
      if (invoices.length === 0) break;
      for (const invoice of invoices) {
        const cached = mapInvoiceToCachedOrder(invoice);
        if (!cached) continue;
        await pool.query(
          `INSERT INTO omsguru_order_cache (organization_id, tracking_id, order_id, marketplace, items, fetched_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (organization_id, tracking_id) DO UPDATE SET
             order_id = EXCLUDED.order_id, marketplace = EXCLUDED.marketplace,
             items = EXCLUDED.items, fetched_at = NOW()`,
          [organizationId, cached.trackingId, cached.orderId, cached.marketplace, JSON.stringify(cached.items)]
        );
        orders += 1;
      }
      const ids = invoices.map((o: any) => Number(o.last_id || o.id || 0)).filter((n: number) => n > 0);
      if (ids.length === 0) break;
      lastId = Math.max(...ids);
      await omsguruGentleDelay();
    }
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
        `SELECT COUNT(*) as count FROM omsguru_sku_photos WHERE organization_id = $1`,
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
