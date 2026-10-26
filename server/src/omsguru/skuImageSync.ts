// Nightly SKU photo sync runner: walks OMSGuru channel listings with a
// persisted cursor per channel and turns them into sku_images rows
// (source 'omsguru'). See skuImages.ts for why and how SKUs are matched.
//
// Budget: one call at a time, spaced so at most 60 - reserve calls land in
// any 5-minute window, and never while that window has `reserve` calls or
// fewer left (X-OMS-Remaining) — so Forward Scan (same OMSGuru account)
// keeps working through the night. Stops at `deadlineMs`; the next night
// resumes from the saved cursors. A channel that errors is skipped for the
// night (its error is kept on its cursor row); only auth errors stop the run.
import type { Pool } from 'pg';
import { createOMSGuruClient, omsguruRateSnapshot, OMSGuruCreds, OMSGuruThrottledError, OMSGuruRateSnapshot } from './client';
import { isColorConflicting, extractColorFamilies, ColorFamily } from './colorMatch';
import {
  budgetWaitMs,
  ChannelInfo,
  ListingRow,
  mapListingRow,
  minCallIntervalMs,
  nextListingCursor,
  orderChannelsForSync,
  planChannelPass,
} from './skuImages';

export interface ListingClient {
  listActiveChannels(): Promise<ChannelInfo[]>;
  listListingsPage(channelCompanyId: number, lastId: number): Promise<any[]>;
}

export type SkuImageSyncTrigger = 'nightly' | 'admin' | 'job';

export interface SkuImageSyncOptions {
  organizationId: string;
  creds: OMSGuruCreds;
  deadlineMs: number;
  reserve: number;
  fullRefreshDays: number;
  excludedMarketplaces: string[];
  trigger: SkuImageSyncTrigger;
  // Default: minCallIntervalMs(reserve).
  minIntervalMs?: number;
  // Test seams.
  client?: ListingClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rateSnapshot?: () => OMSGuruRateSnapshot | null;
}

export interface SkuImageReconcileResult {
  organizationId: string;
  purgedMismatches: number;
  ordersScanned: number;
  orderItemsAudited: number;
  orderImagesCorrected: number;
  durationMs: number;
}

export interface SkuImageSyncResult {
  organizationId: string;
  ok: boolean;
  stoppedBy: 'done' | 'deadline' | 'error';
  calls: number;
  listingsSeen: number;
  listingsStored: number;
  imagesWritten: number;
  channelsCompleted: number;
  channelsTotal: number;
  channelErrors: number;
  rowsSkipped: number;
  durationMs: number;
  error?: string;
  reconciled?: SkuImageReconcileResult;
}

const THROTTLE_PAUSE_MS = 60_000;
// Pages one channel reads before the next channel's turn.
export const PAGES_PER_TURN = 20;
// The photo rebuild is one statement; never let it run away.
const REBUILD_TIMEOUT = '120s';

// Wrong token / client ID: every channel would fail the same way.
export function isAuthFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /HTTP 40[13]\b|unauthori[sz]ed|forbidden|invalid token|not configured/i.test(message);
}

const UPSERT_LISTINGS_SQL = `
  INSERT INTO omsguru_listings (organization_id, channel_id, listing_row_id, sku_name, sku_key, match_key,
                                oms_sku_id, title, image_url, marketplace, seen_at, updated_at)
  SELECT $1, $2, r.listing_row_id, r.sku_name, r.sku_key, r.match_key, r.oms_sku_id, r.title, r.image_url, $3, NOW(), NOW()
  FROM jsonb_to_recordset($4::jsonb) AS r(listing_row_id BIGINT, sku_name TEXT, sku_key TEXT, match_key TEXT,
                                          oms_sku_id TEXT, title TEXT, image_url TEXT)
  ON CONFLICT (organization_id, channel_id, listing_row_id) DO UPDATE SET
    sku_name = EXCLUDED.sku_name,
    sku_key = EXCLUDED.sku_key,
    match_key = EXCLUDED.match_key,
    oms_sku_id = EXCLUDED.oms_sku_id,
    title = EXCLUDED.title,
    image_url = EXCLUDED.image_url,
    marketplace = EXCLUDED.marketplace,
    seen_at = NOW(),
    updated_at = CASE
      WHEN omsguru_listings.sku_key IS DISTINCT FROM EXCLUDED.sku_key
        OR omsguru_listings.oms_sku_id IS DISTINCT FROM EXCLUDED.oms_sku_id
        OR omsguru_listings.title IS DISTINCT FROM EXCLUDED.title
        OR omsguru_listings.image_url IS DISTINCT FROM EXCLUDED.image_url
      THEN NOW() ELSE omsguru_listings.updated_at END`;

// One photo per SKU key, best match first:
//   0 the listing's own name, 1 its name without channel tags,
//   2/3 the same for listings sharing its oms_sku_id AND style_key (same style + colour,
//   e.g. 2XL vs XXL, Ajio aliases), using that group's newest photo. Listings with
//   different styles or colours sharing oms_sku_id are NEVER cross-linked.
//   Only new or changed rows reach the INSERT, so unchanged rows are not even locked.
//   Manual links live in their own rows.
export const REBUILD_SKU_IMAGES_SQL = `
  WITH photo AS (
    SELECT listing_row_id, sku_name, sku_key, match_key, oms_sku_id, title, image_url, marketplace, updated_at,
           regexp_replace(match_key, '_[^_]*$', '') AS style_key
    FROM omsguru_listings
    WHERE organization_id = $1 AND image_url IS NOT NULL
  ),
  linkable AS (
    SELECT oms_sku_id, regexp_replace(match_key, '_[^_]*$', '') AS style_key
    FROM omsguru_listings
    WHERE organization_id = $1 AND oms_sku_id IS NOT NULL
    GROUP BY oms_sku_id, regexp_replace(match_key, '_[^_]*$', '')
    HAVING COUNT(*) BETWEEN 2 AND 50
  ),
  group_photo AS (
    SELECT DISTINCT ON (p.oms_sku_id, regexp_replace(p.match_key, '_[^_]*$', ''))
      p.oms_sku_id, regexp_replace(p.match_key, '_[^_]*$', '') AS style_key,
      p.title, p.image_url, p.marketplace, p.updated_at, p.listing_row_id
    FROM photo p JOIN linkable g ON g.oms_sku_id = p.oms_sku_id AND g.style_key = regexp_replace(p.match_key, '_[^_]*$', '')
    ORDER BY p.oms_sku_id, regexp_replace(p.match_key, '_[^_]*$', ''), p.updated_at DESC, p.listing_row_id DESC
  ),
  candidate AS (
    SELECT sku_key AS key, sku_name AS sku, 0 AS rank, title, image_url, marketplace, updated_at, listing_row_id
    FROM photo
    UNION ALL
    SELECT match_key, match_key, 1, title, image_url, marketplace, updated_at, listing_row_id
    FROM photo WHERE match_key <> sku_key
    UNION ALL
    SELECT s.sku_key, s.sku_name, 2, g.title, g.image_url, g.marketplace, g.updated_at, g.listing_row_id
    FROM omsguru_listings s JOIN group_photo g ON g.oms_sku_id = s.oms_sku_id AND g.style_key = regexp_replace(s.match_key, '_[^_]*$', '')
    WHERE s.organization_id = $1
    UNION ALL
    SELECT s.match_key, s.match_key, 3, g.title, g.image_url, g.marketplace, g.updated_at, g.listing_row_id
    FROM omsguru_listings s JOIN group_photo g ON g.oms_sku_id = s.oms_sku_id AND g.style_key = regexp_replace(s.match_key, '_[^_]*$', '')
    WHERE s.organization_id = $1 AND s.match_key <> s.sku_key
  ),
  best AS (
    SELECT DISTINCT ON (key) key, sku, title, image_url, marketplace, updated_at
    FROM candidate
    WHERE key <> ''
    ORDER BY key, rank, updated_at DESC, listing_row_id DESC, sku
  ),
  changed AS (
    SELECT b.*
    FROM best b
    LEFT JOIN sku_images e ON e.organization_id = $1 AND e.source = 'omsguru' AND e.sku_key = b.key
    WHERE e.sku_key IS NULL
       OR e.image_url IS DISTINCT FROM b.image_url
       OR e.sku IS DISTINCT FROM b.sku
       OR (b.title IS NOT NULL AND e.title IS DISTINCT FROM b.title)
  )
  INSERT INTO sku_images (organization_id, sku, sku_key, title, image_url, marketplace, source, source_updated_at, updated_at)
  SELECT $1, sku, key, title, image_url, marketplace, 'omsguru', updated_at, NOW() FROM changed
  ON CONFLICT (organization_id, sku_key, source) DO UPDATE SET
    sku = EXCLUDED.sku,
    title = COALESCE(EXCLUDED.title, sku_images.title),
    image_url = EXCLUDED.image_url,
    marketplace = COALESCE(EXCLUDED.marketplace, sku_images.marketplace),
    source_updated_at = EXCLUDED.source_updated_at,
    updated_at = NOW()
  WHERE sku_images.image_url IS DISTINCT FROM EXCLUDED.image_url
     OR sku_images.sku IS DISTINCT FROM EXCLUDED.sku
     OR sku_images.title IS DISTINCT FROM COALESCE(EXCLUDED.title, sku_images.title)`;

// Purges orphaned or obsolete 'omsguru' sku_images rows that are no longer
// produced by candidate matching (e.g. listings that were deleted, or older rows
// that were erroneously linked across mismatched styles/colors).
export const PURGE_ORPHAN_SKU_IMAGES_SQL = `
  WITH valid_keys AS (
    SELECT sku_key AS key FROM omsguru_listings WHERE organization_id = $1 AND image_url IS NOT NULL
    UNION
    SELECT match_key FROM omsguru_listings WHERE organization_id = $1 AND image_url IS NOT NULL
    UNION
    SELECT s.sku_key FROM omsguru_listings s
    JOIN (
      SELECT DISTINCT ON (p.oms_sku_id, regexp_replace(p.match_key, '_[^_]*$', ''))
        p.oms_sku_id, regexp_replace(p.match_key, '_[^_]*$', '') AS style_key
      FROM omsguru_listings p
      WHERE p.organization_id = $1 AND p.image_url IS NOT NULL
    ) g ON g.oms_sku_id = s.oms_sku_id AND g.style_key = regexp_replace(s.match_key, '_[^_]*$', '')
    WHERE s.organization_id = $1
    UNION
    SELECT s.match_key FROM omsguru_listings s
    JOIN (
      SELECT DISTINCT ON (p.oms_sku_id, regexp_replace(p.match_key, '_[^_]*$', ''))
        p.oms_sku_id, regexp_replace(p.match_key, '_[^_]*$', '') AS style_key
      FROM omsguru_listings p
      WHERE p.organization_id = $1 AND p.image_url IS NOT NULL
    ) g ON g.oms_sku_id = s.oms_sku_id AND g.style_key = regexp_replace(s.match_key, '_[^_]*$', '')
    WHERE s.organization_id = $1
  )
  DELETE FROM sku_images
  WHERE organization_id = $1
    AND source = 'omsguru'
    AND sku_key NOT IN (SELECT key FROM valid_keys WHERE key <> '')`;

// "Tulip Prints - Meesho" -> "Meesho" (same naming as the order copy).
function channelMarketplace(channel: ChannelInfo): string | null {
  const right = channel.name.includes(' - ') ? channel.name.split(' - ').pop()!.trim() : '';
  return right || channel.channel || channel.name || null;
}

function dedupeRows(rows: ListingRow[]): ListingRow[] {
  const byId = new Map<number, ListingRow>();
  for (const row of rows) byId.set(row.listing_row_id, row);
  return [...byId.values()];
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

// Store one page; if the batch is rejected (a value Postgres refuses), store
// row by row and skip only the bad rows. Every row failing = the database
// itself is in trouble: give up the run instead of skipping the catalogue.
async function storeListingPage(
  pool: Pool,
  org: string,
  channelId: number,
  marketplace: string | null,
  rows: ListingRow[]
): Promise<{ stored: number; skipped: number }> {
  if (rows.length === 0) return { stored: 0, skipped: 0 };
  try {
    await pool.query(UPSERT_LISTINGS_SQL, [org, channelId, marketplace, JSON.stringify(rows)]);
    return { stored: rows.length, skipped: 0 };
  } catch (batchErr) {
    let stored = 0;
    for (const row of rows) {
      try {
        await pool.query(UPSERT_LISTINGS_SQL, [org, channelId, marketplace, JSON.stringify([row])]);
        stored += 1;
      } catch {
        // Skipped below.
      }
    }
    if (stored === 0) throw batchErr;
    console.warn(`[sku-images] channel ${channelId}: skipped ${rows.length - stored} listing(s) Postgres rejected:`, errorText(batchErr));
    return { stored, skipped: rows.length - stored };
  }
}

export async function rebuildSkuImagesFromListings(pool: Pool, organizationId: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '${REBUILD_TIMEOUT}'`);
    const res = await client.query(REBUILD_SKU_IMAGES_SQL, [organizationId]);
    await client.query(PURGE_ORPHAN_SKU_IMAGES_SQL, [organizationId]).catch(() => undefined);
    await client.query('COMMIT');
    return res.rowCount ?? 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Audits and reconciles SKU images across the system every night:
 * 1. Scans automated rows in sku_images ('omsguru' and 'forward-scan') and purges any
 *    that contradict the SKU's color (e.g. BT216-Geomi-Rust_S having a Navy/Blue photo).
 * 2. Scans recent orders (last 30 days) and clears any contradictory hardcoded imageUrl
 *    values so they cleanly resolve to the correct photo (or style fallback).
 */
export async function auditAndReconcileSkuImages(
  pool: Pool,
  organizationId: string
): Promise<SkuImageReconcileResult> {
  const startedAt = Date.now();
  const result: SkuImageReconcileResult = {
    organizationId,
    purgedMismatches: 0,
    ordersScanned: 0,
    orderItemsAudited: 0,
    orderImagesCorrected: 0,
    durationMs: 0,
  };

  // 1. Audit sku_images: find and delete any color-conflicting photos from automated sources.
  const imagesRes = await pool.query(
    `SELECT id, sku, sku_key, title, image_url, source
     FROM sku_images
     WHERE organization_id = $1 AND source <> 'manual'`,
    [organizationId]
  );

  const idsToPurge: string[] = [];
  for (const row of imagesRes.rows) {
    if (isColorConflicting(row.sku, row.title, row.image_url)) {
      idsToPurge.push(row.id);
      console.warn(
        `[sku-images] audit: detected color conflict for SKU "${row.sku}" (${row.sku_key}) ` +
        `source="${row.source}" title="${row.title}" image="${row.image_url}"`
      );
    }
  }

  if (idsToPurge.length > 0) {
    const delRes = await pool.query(
      `DELETE FROM sku_images WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [organizationId, idsToPurge]
    );
    result.purgedMismatches = delRes.rowCount ?? 0;
  }

  // 2. Audit recent orders in marketplace_orders (last 30 days):
  // Clean up any conflicting item.imageUrl stored in marketplace_orders.items JSON.
  const ordersRes = await pool.query(
    `SELECT tracking_id, items
     FROM marketplace_orders
     WHERE organization_id = $1
       AND COALESCE(awb_generated_at, created_at) >= NOW() - INTERVAL '30 days'
       AND items IS NOT NULL AND jsonb_typeof(items) = 'array'`,
    [organizationId]
  );
  result.ordersScanned = ordersRes.rowCount ?? 0;

  for (const order of ordersRes.rows) {
    const items = Array.isArray(order.items) ? order.items : [];
    let orderChanged = false;
    for (const item of items) {
      result.orderItemsAudited += 1;
      const sku = item?.sku;
      const rawImg = item?.imageUrl || item?.image_url;
      if (sku && rawImg && isColorConflicting(sku, item.title, rawImg)) {
        console.warn(
          `[sku-images] audit: order ${order.tracking_id} item "${sku}" has conflicting image "${rawImg}", clearing`
        );
        delete item.imageUrl;
        delete item.image_url;
        orderChanged = true;
      }
    }
    if (orderChanged) {
      await pool.query(
        `UPDATE marketplace_orders SET items = $3, updated_at = NOW()
         WHERE organization_id = $1 AND tracking_id = $2`,
        [organizationId, order.tracking_id, JSON.stringify(items)]
      );
      result.orderImagesCorrected += 1;
    }
  }

  result.durationMs = Date.now() - startedAt;
  console.log(
    `[sku-images] reconcile completed for org ${organizationId}: ` +
    `${result.purgedMismatches} mismatched photo(s) purged, ` +
    `${result.ordersScanned} orders scanned, ${result.orderImagesCorrected} order(s) corrected ` +
    `in ${result.durationMs}ms`
  );

  return result;
}

export interface ResyncSingleSkuResult {
  sku: string;
  skuKey: string;
  found: boolean;
  verifiedImageUrl: string | null;
  purgedConflictingCount: number;
  ordersUpdatedCount: number;
  source: 'database' | 'omsguru_api' | 'none';
}

/**
 * Resyncs, verifies, and updates the image for a specific SKU on-demand:
 * 1. Purges any color-conflicting photos from sku_images for this SKU and style.
 * 2. Searches omsguru_listings and (if creds provided) live OMSGuru API.
 * 3. Checks that any candidate image passes color compatibility (!isColorConflicting).
 * 4. Upserts verified image into sku_images (both manual and omsguru source).
 * 5. Updates marketplace_orders.items for all recent orders containing this SKU.
 */
export async function resyncSingleSkuImage(
  pool: Pool,
  organizationId: string,
  targetSku: string,
  creds?: OMSGuruCreds | null
): Promise<ResyncSingleSkuResult> {
  const cleanSku = targetSku.trim();
  const skuKey = cleanSku.toUpperCase().replace(/\s+/g, ' ');
  const styleKey = skuKey.replace(/_[^_]*$/, '');

  const result: ResyncSingleSkuResult = {
    sku: cleanSku,
    skuKey,
    found: false,
    verifiedImageUrl: null,
    purgedConflictingCount: 0,
    ordersUpdatedCount: 0,
    source: 'none',
  };

  // 1. Purge any conflicting images for this SKU from sku_images
  const currentImages = await pool.query(
    `SELECT id, sku, sku_key, title, image_url, source
     FROM sku_images
     WHERE organization_id = $1 AND (sku_key = $2 OR sku_key LIKE $3 || '%')`,
    [organizationId, skuKey, styleKey]
  );

  const idsToPurge: string[] = [];
  for (const row of currentImages.rows) {
    if (isColorConflicting(cleanSku, row.title, row.image_url)) {
      idsToPurge.push(row.id);
    }
  }

  if (idsToPurge.length > 0) {
    const delRes = await pool.query(
      `DELETE FROM sku_images WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [organizationId, idsToPurge]
    );
    result.purgedConflictingCount = delRes.rowCount ?? 0;
  }

  // 2. Check omsguru_listings for a non-conflicting photo
  const listingsRes = await pool.query(
    `SELECT listing_row_id, channel_id, sku_name, sku_key, match_key, oms_sku_id, title, image_url, marketplace
     FROM omsguru_listings
     WHERE organization_id = $1
       AND (sku_key = $2 OR match_key = $2 OR regexp_replace(match_key, '_[^_]*$', '') = $3)
       AND image_url IS NOT NULL
     ORDER BY (sku_key = $2) DESC, updated_at DESC`,
    [organizationId, skuKey, styleKey]
  );

  let verifiedUrl: string | null = null;
  let verifiedTitle: string | null = null;
  let verifiedMarketplace: string | null = null;

  const targetColors = extractColorFamilies(cleanSku);
  let bestDbCandidate: { url: string; title: string | null; marketplace: string | null; score: number } | null = null;

  for (const row of listingsRes.rows) {
    if (row.image_url && !isColorConflicting(cleanSku, row.title, row.image_url)) {
      const candidateColors = extractColorFamilies((row.title || '') + ' ' + (row.image_url || ''));
      let hasExplicitColor = false;
      if (targetColors.size > 0) {
        for (const c of candidateColors) {
          if (targetColors.has(c)) {
            hasExplicitColor = true;
            break;
          }
        }
      }
      const isExactSku = row.sku_name?.toUpperCase().trim() === skuKey;

      let score = 0;
      if (isExactSku && hasExplicitColor) score = 100;
      else if (!isExactSku && hasExplicitColor) score = 80;
      else if (isExactSku) score = 50;
      else score = 30;

      if (!bestDbCandidate || score > bestDbCandidate.score) {
        bestDbCandidate = {
          url: row.image_url,
          title: row.title,
          marketplace: row.marketplace,
          score,
        };
      }
    }
  }

  if (bestDbCandidate) {
    verifiedUrl = bestDbCandidate.url;
    verifiedTitle = bestDbCandidate.title;
    verifiedMarketplace = bestDbCandidate.marketplace;
    result.source = 'database';
  }

  // 3. If not found in database and creds are provided, search OMSGuru API directly
  if (!verifiedUrl && creds?.token && creds?.cid) {
    try {
      const client = createOMSGuruClient(creds);
      const channels = await client.listActiveChannels();
      for (const ch of channels) {
        let lastId = 0;
        let pagesChecked = 0;
        let foundInChannel = false;

        while (pagesChecked < 20) {
          pagesChecked++;
          const rawRows = await client.listListingsPage(ch.id, lastId);
          if (!rawRows || rawRows.length === 0) break;

          for (const raw of rawRows) {
            const rowId = Number(raw.id || raw.listing_row_id || 0);
            if (rowId > lastId) lastId = rowId;

            const mapped = mapListingRow(raw);
            if (!mapped) continue;

            const rowStyleKey = mapped.sku_key.replace(/_[^_]*$/, '');
            if (mapped.sku_key === skuKey || rowStyleKey === styleKey) {
              await pool.query(
                `INSERT INTO omsguru_listings (organization_id, channel_id, listing_row_id, sku_name, sku_key, match_key, oms_sku_id, title, image_url, marketplace, seen_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
                 ON CONFLICT (organization_id, channel_id, listing_row_id) DO UPDATE SET
                   sku_name = EXCLUDED.sku_name,
                   image_url = EXCLUDED.image_url,
                   updated_at = NOW()`,
                [
                  organizationId,
                  ch.id,
                  mapped.listing_row_id,
                  mapped.sku_name,
                  mapped.sku_key,
                  mapped.match_key,
                  mapped.oms_sku_id,
                  mapped.title,
                  mapped.image_url,
                  ch.name.split(' - ').pop() || ch.channel,
                ]
              );

              if (mapped.image_url && !isColorConflicting(cleanSku, mapped.title, mapped.image_url)) {
                verifiedUrl = mapped.image_url;
                verifiedTitle = mapped.title;
                verifiedMarketplace = ch.name.split(' - ').pop() || ch.channel;
                result.source = 'omsguru_api';
                foundInChannel = true;
                break;
              }
            }
          }
          if (foundInChannel) break;
        }
        if (verifiedUrl) break;
      }
    } catch (apiErr) {
      console.warn('[sku-images] live OMSGuru API search failed for single SKU:', apiErr);
    }
  }

  // 4. If verifiedUrl found, upsert into sku_images and update orders
  if (verifiedUrl) {
    result.found = true;
    result.verifiedImageUrl = verifiedUrl;

    const targetPairs = [
      { sku: cleanSku, key: skuKey },
      { sku: cleanSku.replace(/_[^_]*$/, ''), key: styleKey },
    ];

    for (const target of targetPairs) {
      for (const src of ['manual', 'omsguru'] as const) {
        await pool.query(
          `INSERT INTO sku_images (organization_id, sku, sku_key, title, image_url, marketplace, source, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (organization_id, sku_key, source) DO UPDATE SET
             image_url = EXCLUDED.image_url,
             title = COALESCE(EXCLUDED.title, sku_images.title),
             updated_at = NOW()`,
          [organizationId, target.sku, target.key, verifiedTitle, verifiedUrl, verifiedMarketplace, src]
        );
      }
    }

    const ordersRes = await pool.query(
      `SELECT tracking_id, items
       FROM marketplace_orders
       WHERE organization_id = $1 AND items::text ILIKE '%' || $2 || '%'`,
      [organizationId, cleanSku]
    );

    for (const order of ordersRes.rows) {
      const items = Array.isArray(order.items) ? order.items : [];
      let changed = false;
      for (const item of items) {
        if (typeof item.sku === 'string' && item.sku.toLowerCase() === cleanSku.toLowerCase()) {
          if (item.imageUrl !== verifiedUrl) {
            item.imageUrl = verifiedUrl;
            changed = true;
          }
        }
      }
      if (changed) {
        await pool.query(
          `UPDATE marketplace_orders SET items = $3, updated_at = NOW()
           WHERE organization_id = $1 AND tracking_id = $2`,
          [organizationId, order.tracking_id, JSON.stringify(items)]
        );
        result.ordersUpdatedCount++;
      }
    }
  } else {
    // If no verified photo found, clear conflicting images from marketplace_orders
    const ordersRes = await pool.query(
      `SELECT tracking_id, items
       FROM marketplace_orders
       WHERE organization_id = $1 AND items::text ILIKE '%' || $2 || '%'`,
      [organizationId, cleanSku]
    );

    for (const order of ordersRes.rows) {
      const items = Array.isArray(order.items) ? order.items : [];
      let changed = false;
      for (const item of items) {
        if (typeof item.sku === 'string' && item.sku.toLowerCase() === cleanSku.toLowerCase()) {
          if (item.imageUrl && isColorConflicting(item.sku, item.title, item.imageUrl)) {
            delete item.imageUrl;
            delete item.image_url;
            changed = true;
          }
        }
      }
      if (changed) {
        await pool.query(
          `UPDATE marketplace_orders SET items = $3, updated_at = NOW()
           WHERE organization_id = $1 AND tracking_id = $2`,
          [organizationId, order.tracking_id, JSON.stringify(items)]
        );
        result.ordersUpdatedCount++;
      }
    }
  }

  return result;
}

export async function runSkuImageSync(pool: Pool, options: SkuImageSyncOptions): Promise<SkuImageSyncResult> {
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // One attempt per call: this runner pauses on throttling itself.
  const client = options.client || createOMSGuruClient(options.creds, { attempts: 1 });
  const snapshot = options.rateSnapshot || (() => omsguruRateSnapshot(options.creds));
  const minInterval = Math.max(0, options.minIntervalMs ?? minCallIntervalMs(options.reserve));
  const org = options.organizationId;
  const startedAt = now();
  const result: SkuImageSyncResult = {
    organizationId: org,
    ok: false,
    stoppedBy: 'done',
    calls: 0,
    listingsSeen: 0,
    listingsStored: 0,
    imagesWritten: 0,
    channelsCompleted: 0,
    channelsTotal: 0,
    channelErrors: 0,
    rowsSkipped: 0,
    durationMs: 0,
  };
  const channelErrors: string[] = [];

  const runRes = await pool.query(
    `INSERT INTO sku_image_sync_runs (organization_id, trigger, status) VALUES ($1, $2, 'running') RETURNING id`,
    [org, options.trigger]
  );
  const runId = runRes.rows[0]?.id;

  let lastCallAt = 0;
  // false = the wait would cross the deadline: stop for tonight.
  const waitTurn = async (): Promise<boolean> => {
    const t = now();
    const wait = Math.max(minInterval - (t - lastCallAt), budgetWaitMs(snapshot(), options.reserve, t));
    if (t + Math.max(0, wait) >= options.deadlineMs) return false;
    if (wait > 0) await sleep(wait);
    lastCallAt = now();
    return true;
  };

  try {
    if (!(await waitTurn())) {
      result.stoppedBy = 'deadline';
    } else {
      result.calls += 1;
      const channels = orderChannelsForSync(await client.listActiveChannels(), options.excludedMarketplaces);
      result.channelsTotal = channels.length;
      const stateRes = await pool.query(
        `SELECT channel_id, last_id, pass_started_at, pass_completed_at FROM omsguru_listing_sync_state WHERE organization_id = $1`,
        [org]
      );
      const states = new Map<number, any>(stateRes.rows.map((row: any) => [Number(row.channel_id), row]));

      // Plan every channel, then take turns (PAGES_PER_TURN each) so the
      // first nights fill every marketplace instead of finishing one.
      const jobs: Array<{ channel: ChannelInfo; cursor: number; passOpen: boolean; marketplace: string | null }> = [];
      for (const channel of channels) {
        const plan = planChannelPass(states.get(channel.id) || null, now(), options.fullRefreshDays);
        if (plan.newPass) {
          await pool.query(
            `INSERT INTO omsguru_listing_sync_state (organization_id, channel_id, channel_name, last_id, pass_started_at, pass_completed_at, pages_read, updated_at)
             VALUES ($1, $2, $3, $4, NOW(), NULL, 0, NOW())
             ON CONFLICT (organization_id, channel_id) DO UPDATE SET
               channel_name = EXCLUDED.channel_name, last_id = EXCLUDED.last_id,
               pass_started_at = NOW(), pass_completed_at = NULL, pages_read = 0, updated_at = NOW()`,
            [org, channel.id, channel.name, plan.lastId]
          );
        }
        jobs.push({
          channel,
          cursor: plan.lastId,
          // Pass still open = this walk started from the first listing and
          // has not reached the end yet (vs. a nightly top-up of new ones).
          passOpen: plan.newPass || !states.get(channel.id)?.pass_completed_at,
          marketplace: channelMarketplace(channel),
        });
      }

      let pending = jobs;
      rounds:
      while (pending.length > 0) {
        const stillPending: typeof jobs = [];
        for (const job of pending) {
          let caughtUp = false;
          let failed = false;
          for (let turn = 0; turn < PAGES_PER_TURN && !caughtUp; ) {
            if (!(await waitTurn())) {
              result.stoppedBy = 'deadline';
              break rounds;
            }
            let page: any[];
            result.calls += 1;
            try {
              page = await client.listListingsPage(job.channel.id, job.cursor);
            } catch (err) {
              if (err instanceof OMSGuruThrottledError) {
                // Give Forward Scan the window, then retry this page.
                if (now() + THROTTLE_PAUSE_MS >= options.deadlineMs) {
                  result.stoppedBy = 'deadline';
                  break rounds;
                }
                await sleep(THROTTLE_PAUSE_MS);
                continue;
              }
              if (isAuthFailure(err)) throw err;
              // This channel only: keep its cursor, note why, move on.
              failed = true;
              result.channelErrors += 1;
              channelErrors.push(`${job.channel.name}: ${errorText(err)}`);
              await pool.query(
                `UPDATE omsguru_listing_sync_state SET last_error = $3, updated_at = NOW()
                 WHERE organization_id = $1 AND channel_id = $2`,
                [org, job.channel.id, errorText(err)]
              );
              break;
            }
            turn += 1;

            const rows = dedupeRows(page.map(mapListingRow).filter((row): row is ListingRow => Boolean(row)));
            const stored = await storeListingPage(pool, org, job.channel.id, job.marketplace, rows);
            result.listingsSeen += page.length;
            result.listingsStored += stored.stored;
            result.rowsSkipped += stored.skipped;

            const next = nextListingCursor(page, job.cursor);
            // Only an empty page ends a pass (a short page may not be the
            // last one); a page that does not move the cursor ends it too.
            caughtUp = page.length === 0 || next <= job.cursor;
            await pool.query(
              `UPDATE omsguru_listing_sync_state SET
                 channel_name = $3, last_id = $4, pages_read = pages_read + 1, updated_at = NOW(), last_error = NULL,
                 pass_completed_at = CASE WHEN $5 THEN COALESCE(pass_completed_at, NOW()) ELSE pass_completed_at END,
                 caught_up_at = CASE WHEN $5 THEN NOW() ELSE caught_up_at END
               WHERE organization_id = $1 AND channel_id = $2`,
              [org, job.channel.id, job.channel.name, next, caughtUp]
            );
            job.cursor = next;
          }
          if (failed) continue;
          if (!caughtUp) {
            stillPending.push(job);
            continue;
          }
          if (job.passOpen) {
            // A full pass just finished: listings it never saw were removed
            // from OMSGuru, so drop them (their photos stay in sku_images).
            await pool.query(
              `DELETE FROM omsguru_listings l
               USING omsguru_listing_sync_state s
               WHERE l.organization_id = $1 AND l.channel_id = $2
                 AND s.organization_id = l.organization_id AND s.channel_id = l.channel_id
                 AND s.pass_started_at IS NOT NULL
                 AND l.seen_at < s.pass_started_at`,
              [org, job.channel.id]
            );
          }
          result.channelsCompleted += 1;
        }
        pending = stillPending;
      }
    }
    result.ok = true;
  } catch (err) {
    result.stoppedBy = 'error';
    result.error = errorText(err);
  }

  // Partial progress is still worth publishing to the packing page.
  try {
    result.imagesWritten = await rebuildSkuImagesFromListings(pool, org);
    result.reconciled = await auditAndReconcileSkuImages(pool, org);
  } catch (err) {
    result.ok = false;
    result.stoppedBy = 'error';
    result.error = result.error || `photo rebuild failed: ${errorText(err)}`;
  }

  if (!result.error && channelErrors.length > 0) {
    result.error = `${channelErrors.length} channel(s) skipped: ${channelErrors.join('; ')}`.slice(0, 500);
  }
  const status = !result.ok ? 'error' : channelErrors.length > 0 ? 'partial' : 'ok';
  result.durationMs = now() - startedAt;
  if (runId !== undefined) {
    await pool.query(
      `UPDATE sku_image_sync_runs SET finished_at = NOW(), status = $2, stopped_by = $3, calls = $4,
         listings_seen = $5, listings_stored = $6, images_written = $7, channels_completed = $8,
         channels_total = $9, error = $10
       WHERE id = $1`,
      [runId, status, result.stoppedBy, result.calls, result.listingsSeen,
        result.listingsStored, result.imagesWritten, result.channelsCompleted, result.channelsTotal,
        result.error ? result.error.slice(0, 500) : null]
    ).catch((err) => console.warn('[sku-images] run ledger update failed:', errorText(err)));
  }
  return result;
}
