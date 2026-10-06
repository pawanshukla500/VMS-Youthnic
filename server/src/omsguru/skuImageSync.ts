// Nightly SKU photo sync runner: walks OMSGuru channel listings with a
// persisted cursor per channel and turns them into sku_images rows
// (source 'omsguru'). See skuImages.ts for why and how SKUs are matched.
//
// Budget: one call at a time, at most one per `minIntervalMs`, and never
// while the shared 5-minute window has `reserve` calls or fewer left — so
// Forward Scan (same OMSGuru account) keeps working through the night.
// Stops at `deadlineMs`; the next night resumes from the saved cursors.
import type { Pool } from 'pg';
import { createOMSGuruClient, omsguruRateSnapshot, OMSGuruCreds, OMSGuruThrottledError, OMSGuruRateSnapshot } from './client';
import {
  budgetWaitMs,
  ChannelInfo,
  LISTING_PAGE_SIZE,
  ListingRow,
  mapListingRow,
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
  minIntervalMs?: number;
  // Test seams.
  client?: ListingClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rateSnapshot?: () => OMSGuruRateSnapshot | null;
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
  durationMs: number;
  error?: string;
}

const THROTTLE_PAUSE_MS = 60_000;
// Pages one channel reads before the next channel's turn (~100 s).
export const PAGES_PER_TURN = 20;

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
//   2/3 the same for listings sharing its oms_sku_id (2XL/XXL, Ajio names).
// Only changed rows are written (manual links live in their own rows).
export const REBUILD_SKU_IMAGES_SQL = `
  WITH photo AS (
    SELECT listing_row_id, sku_name, sku_key, match_key, oms_sku_id, title, image_url, marketplace, updated_at
    FROM omsguru_listings
    WHERE organization_id = $1 AND image_url IS NOT NULL
  ),
  candidate AS (
    SELECT sku_key AS key, sku_name AS sku, 0 AS rank, title, image_url, marketplace, updated_at, listing_row_id
    FROM photo
    UNION ALL
    SELECT match_key, match_key, 1, title, image_url, marketplace, updated_at, listing_row_id
    FROM photo WHERE match_key <> sku_key
    UNION ALL
    SELECT s.sku_key, s.sku_name, 2, p.title, p.image_url, p.marketplace, p.updated_at, p.listing_row_id
    FROM omsguru_listings s JOIN photo p ON p.oms_sku_id = s.oms_sku_id
    WHERE s.organization_id = $1 AND s.oms_sku_id IS NOT NULL AND s.sku_key <> p.sku_key
    UNION ALL
    SELECT s.match_key, s.match_key, 3, p.title, p.image_url, p.marketplace, p.updated_at, p.listing_row_id
    FROM omsguru_listings s JOIN photo p ON p.oms_sku_id = s.oms_sku_id
    WHERE s.organization_id = $1 AND s.oms_sku_id IS NOT NULL AND s.match_key <> s.sku_key AND s.match_key <> p.sku_key
  ),
  best AS (
    SELECT DISTINCT ON (key) key, sku, title, image_url, marketplace, updated_at
    FROM candidate
    WHERE key <> ''
    ORDER BY key, rank, updated_at DESC, listing_row_id DESC
  )
  INSERT INTO sku_images (organization_id, sku, sku_key, title, image_url, marketplace, source, source_updated_at, updated_at)
  SELECT $1, sku, key, title, image_url, marketplace, 'omsguru', updated_at, NOW() FROM best
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

export async function rebuildSkuImagesFromListings(pool: Pool, organizationId: string): Promise<number> {
  const res = await pool.query(REBUILD_SKU_IMAGES_SQL, [organizationId]);
  return res.rowCount ?? 0;
}

export async function runSkuImageSync(pool: Pool, options: SkuImageSyncOptions): Promise<SkuImageSyncResult> {
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const client = options.client || createOMSGuruClient(options.creds);
  const snapshot = options.rateSnapshot || (() => omsguruRateSnapshot(options.creds));
  const minInterval = Math.max(0, options.minIntervalMs ?? 5000);
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
    durationMs: 0,
  };

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
      const channels = orderChannelsForSync(await client.listActiveChannels(), options.excludedMarketplaces);
      result.calls += 1;
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
          for (let turn = 0; turn < PAGES_PER_TURN && !caughtUp; ) {
            if (!(await waitTurn())) {
              result.stoppedBy = 'deadline';
              break rounds;
            }
            let page: any[];
            try {
              page = await client.listListingsPage(job.channel.id, job.cursor);
              result.calls += 1;
            } catch (err) {
              result.calls += 1;
              if (err instanceof OMSGuruThrottledError) {
                // The client already backed off; give Forward Scan the window.
                if (now() + THROTTLE_PAUSE_MS >= options.deadlineMs) {
                  result.stoppedBy = 'deadline';
                  break rounds;
                }
                await sleep(THROTTLE_PAUSE_MS);
                continue;
              }
              throw err;
            }
            turn += 1;

            const rows = dedupeRows(page.map(mapListingRow).filter((row): row is ListingRow => Boolean(row)));
            if (rows.length > 0) {
              await pool.query(UPSERT_LISTINGS_SQL, [org, job.channel.id, job.marketplace, JSON.stringify(rows)]);
            }
            result.listingsSeen += page.length;
            result.listingsStored += rows.length;

            const next = nextListingCursor(page, job.cursor);
            caughtUp = page.length < LISTING_PAGE_SIZE || next <= job.cursor;
            await pool.query(
              `UPDATE omsguru_listing_sync_state SET
                 channel_name = $3, last_id = $4, pages_read = pages_read + 1, updated_at = NOW(),
                 pass_completed_at = CASE WHEN $5 THEN COALESCE(pass_completed_at, NOW()) ELSE pass_completed_at END,
                 caught_up_at = CASE WHEN $5 THEN NOW() ELSE caught_up_at END
               WHERE organization_id = $1 AND channel_id = $2`,
              [org, job.channel.id, job.channel.name, next, caughtUp]
            );
            job.cursor = next;
          }
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
    result.error = err instanceof Error ? err.message : String(err);
  }

  // Partial progress is still worth publishing to the packing page.
  try {
    result.imagesWritten = await rebuildSkuImagesFromListings(pool, org);
  } catch (err) {
    result.ok = false;
    result.stoppedBy = 'error';
    result.error = result.error || `photo rebuild failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  result.durationMs = now() - startedAt;
  if (runId !== undefined) {
    await pool.query(
      `UPDATE sku_image_sync_runs SET finished_at = NOW(), status = $2, stopped_by = $3, calls = $4,
         listings_seen = $5, listings_stored = $6, images_written = $7, channels_completed = $8,
         channels_total = $9, error = $10
       WHERE id = $1`,
      [runId, result.ok ? 'ok' : 'error', result.stoppedBy, result.calls, result.listingsSeen,
        result.listingsStored, result.imagesWritten, result.channelsCompleted, result.channelsTotal,
        result.error ? result.error.slice(0, 500) : null]
    ).catch((err) => console.warn('[sku-images] run ledger update failed:', err instanceof Error ? err.message : err));
  }
  return result;
}
