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

const INVOICE_WINDOW_SEC = 3 * 24 * 3600;
const MAX_LISTING_PAGES = 50;
const MAX_INVOICE_PAGES = 20;

export async function runOMSGuruSync(
  pool: Pool,
  organizationId: string,
  creds: SyncCreds
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
  if (creds.warehouseId) {
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
