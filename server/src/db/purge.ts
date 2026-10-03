// Retention purge for import bookkeeping (unit-tested).
//
// Raw upload bytes are already nulled immediately after each import; this
// job ages out what accumulates anyway:
//  1. marketplace_order_mappings older than N days — recordings are renamed
//     at import/reconcile time, so old mappings only bloat the table.
//  2. audit_logs older than M days.
//  3. Any order_import_batches.raw_file that survived a crashed import
//     (backstop: older than 1 hour gets nulled).
//  4. OMSGuru order and image cache rows older than 24 hours.
//  5. video_assets whose retention_until is in the past and legal_hold = FALSE
//     (Storage object deleted first; DB row then removed).
//  6. recording_sessions whose data_retention_until is in the past and
//     legal_hold = FALSE (DB row only — no bytes).
// Interval params are bound (never interpolated) — safe from injection.

import type { Pool } from 'pg';

// Minimal structural type for a Firebase Storage bucket — keeps the test
// environment free of firebase-admin (which the server bundle imports) and
// avoids leaking firebase-admin into the public type surface here.
export interface StorageBucketLike {
  file(path: string): {
    delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
  };
}

export interface PurgeStatement {
  key: 'mappings' | 'audit' | 'rawFiles' | 'omsguruOrders' | 'omsguruPhotos' | 'videos' | 'sessions';
  text: string;
  values: unknown[];
}

export function buildPurgeStatements(mappingRetentionDays: number, auditRetentionDays: number): PurgeStatement[] {
  const mappings = Math.max(1, Math.floor(mappingRetentionDays));
  const audit = Math.max(1, Math.floor(auditRetentionDays));

  return [
    {
      key: 'mappings',
      text: `DELETE FROM marketplace_order_mappings WHERE imported_at < NOW() - ($1 * INTERVAL '1 day')`,
      values: [mappings],
    },
    {
      key: 'audit',
      text: `DELETE FROM audit_logs WHERE created_at < NOW() - ($1 * INTERVAL '1 day')`,
      values: [audit],
    },
    {
      key: 'rawFiles',
      text: `UPDATE order_import_batches
             SET raw_file = NULL, raw_purged_at = NOW()
             WHERE raw_file IS NOT NULL AND created_at < NOW() - INTERVAL '1 hour'`,
      values: [],
    },
    {
      key: 'omsguruOrders',
      text: `DELETE FROM omsguru_order_cache WHERE fetched_at < NOW() - INTERVAL '24 hours'`,
      values: [],
    },
    {
      key: 'omsguruPhotos',
      text: `DELETE FROM omsguru_sku_photos WHERE fetched_at < NOW() - INTERVAL '30 days'`,
      values: [],
    },
    {
      key: 'sessions',
      text: `DELETE FROM recording_sessions
             WHERE data_retention_until IS NOT NULL
               AND data_retention_until < NOW()
               AND COALESCE(legal_hold, FALSE) = FALSE`,
      values: [],
    },
  ];
}

// Read-only previews for ?dryRun=1 (same WHERE clauses, COUNT instead).
export function buildPurgeCountStatements(mappingRetentionDays: number, auditRetentionDays: number): PurgeStatement[] {
  const mappings = Math.max(1, Math.floor(mappingRetentionDays));
  const audit = Math.max(1, Math.floor(auditRetentionDays));

  return [
    {
      key: 'mappings',
      text: `SELECT COUNT(*) as count FROM marketplace_order_mappings WHERE imported_at < NOW() - ($1 * INTERVAL '1 day')`,
      values: [mappings],
    },
    {
      key: 'audit',
      text: `SELECT COUNT(*) as count FROM audit_logs WHERE created_at < NOW() - ($1 * INTERVAL '1 day')`,
      values: [audit],
    },
    {
      key: 'rawFiles',
      text: `SELECT COUNT(*) as count FROM order_import_batches WHERE raw_file IS NOT NULL AND created_at < NOW() - INTERVAL '1 hour'`,
      values: [],
    },
    {
      key: 'omsguruOrders',
      text: `SELECT COUNT(*) as count FROM omsguru_order_cache WHERE fetched_at < NOW() - INTERVAL '24 hours'`,
      values: [],
    },
    {
      key: 'omsguruPhotos',
      text: `SELECT COUNT(*) as count FROM omsguru_sku_photos WHERE fetched_at < NOW() - INTERVAL '30 days'`,
      values: [],
    },
    {
      key: 'videos',
      text: `SELECT COUNT(*) as count FROM video_assets
             WHERE retention_until IS NOT NULL
               AND retention_until < NOW()
               AND COALESCE(legal_hold, FALSE) = FALSE`,
      values: [],
    },
    {
      key: 'sessions',
      text: `SELECT COUNT(*) as count FROM recording_sessions
             WHERE data_retention_until IS NOT NULL
               AND data_retention_until < NOW()
               AND COALESCE(legal_hold, FALSE) = FALSE`,
      values: [],
    },
  ];
}

export interface RetentionPurgeResult {
  videosScanned: number;
  videosDeleted: number;
  videosOrphaned: number;
  sessionsDeleted: number;
  failures: number;
}

/**
 * Apply the `marketplace_retention_policies` retention window to real
 * Firebase Storage objects + DB rows. The two phases MUST be split:
 *
 *   1. SELECT up to `limit` expired video_assets (legal_hold = FALSE).
 *   2. For each: delete the Storage object; only DELETE the DB row if the
 *      Storage delete succeeded.
 *   3. On Storage failure: INSERT into `pending_storage_deletions` so a
 *      future run retries. The DB row stays put so the bytes aren't lost.
 *
 * Idempotent, parallelised with a small concurrency cap so a single run
 * never monopolises the Storage API quota.
 */
export async function runRetentionPurge(
  pool: Pool,
  bucket: StorageBucketLike | null,
  options: { organizationId?: string | null; limit?: number; concurrency?: number } = {}
): Promise<RetentionPurgeResult> {
  const limit = Math.max(1, Math.min(2000, Math.floor(options.limit ?? 200)));
  const concurrency = Math.max(1, Math.min(16, Math.floor(options.concurrency ?? 4)));
  // null organizationId = global purge (cron only). A non-null value scopes
  // every SELECT / DELETE to that organization so an org admin cannot
  // reach into another org's expired data via this endpoint.
  const orgId = typeof options.organizationId === 'string' && options.organizationId.length > 0
    ? options.organizationId
    : null;
  const orgFilterVideo = orgId ? ' AND organization_id = $2' : '';
  const orgFilterSession = orgId ? ' AND organization_id = $2' : '';
  const selectParams: unknown[] = orgId ? [limit, orgId] : [limit];
  const deleteParams: unknown[] = orgId ? [orgId] : [];

  const result: RetentionPurgeResult = {
    videosScanned: 0,
    videosDeleted: 0,
    videosOrphaned: 0,
    sessionsDeleted: 0,
    failures: 0,
  };

  // Phase 0: drain any pending_storage_deletions rows that accumulated
  // from previous failures (manual delete, retention purge, etc.). These
  // are Storage-only: no DB row to delete afterwards, only a successful
  // DELETE on the queue table.
  if (bucket) {
    const pending = await pool.query<{ id: number; storage_path: string }>(
      `SELECT id, storage_path FROM pending_storage_deletions
       ORDER BY last_attempt_at ASC
       LIMIT $1`,
      [Math.max(1, limit)]
    );
    for (const row of pending.rows) {
      try {
        await bucket.file(row.storage_path).delete({ ignoreNotFound: true });
        await pool.query(`DELETE FROM pending_storage_deletions WHERE id = $1`, [row.id]);
      } catch (err) {
        try {
          await pool.query(
            `UPDATE pending_storage_deletions
                SET attempts = attempts + 1,
                    last_attempt_at = NOW(),
                    last_error = $2
              WHERE id = $1`,
            [row.id, String((err as Error)?.message ?? err).slice(0, 500)]
          );
        } catch (updErr) {
          console.error('[retention] pending_storage_deletions update failed:', updErr);
          result.failures += 1;
        }
      }
    }
  }

  // Phase 1: drop expired recording_sessions (no Storage side effect).
  try {
    const sessionRes = await pool.query(
      `DELETE FROM recording_sessions
       WHERE data_retention_until IS NOT NULL
         AND data_retention_until < NOW()
         AND COALESCE(legal_hold, FALSE) = FALSE
         ${orgFilterSession}`,
      deleteParams
    );
    result.sessionsDeleted = sessionRes.rowCount ?? 0;
  } catch (err) {
    console.error('[retention] recording_sessions purge failed:', err);
    result.failures += 1;
  }

  if (!bucket) {
    // No Firebase bucket available (dev / misconfigured) — skip bytes.
    return result;
  }

  // Phase 2: walk expired video_assets.
  const expired = await pool.query<{
    id: string;
    storage_path: string;
    organization_id: string;
  }>(
    `SELECT id, storage_path, organization_id FROM video_assets
     WHERE retention_until IS NOT NULL
       AND retention_until < NOW()
       AND COALESCE(legal_hold, FALSE) = FALSE
       ${orgFilterVideo}
     LIMIT $1`,
    selectParams
  );
  result.videosScanned = expired.rowCount ?? 0;

  const queue = [...expired.rows];
  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < concurrency; i += 1) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const row = queue.shift();
          if (!row) return;
          try {
            await bucket.file(row.storage_path).delete({ ignoreNotFound: true });
            await pool.query(`DELETE FROM video_assets WHERE id = $1`, [row.id]);
            result.videosDeleted += 1;
          } catch (err) {
            console.error(
              `[retention] Storage delete failed for video_assets.id=${row.id}; queuing retry:`,
              err
            );
            try {
              await pool.query(
                `INSERT INTO pending_storage_deletions (storage_path, video_asset_id, last_error)
                 VALUES ($1, $2, $3)`,
                [row.storage_path, row.id, String((err as Error)?.message ?? err).slice(0, 500)]
              );
              result.videosOrphaned += 1;
            } catch (insertErr) {
              console.error('[retention] pending_storage_deletions insert failed:', insertErr);
              result.failures += 1;
            }
          }
        }
      })()
    );
  }
  await Promise.all(workers);

  return result;
}

export function purgeRetentionDays(value: unknown, fallback: number): number {
  const days = Number(value);
  return Number.isFinite(days) && days >= 1 ? Math.floor(days) : fallback;
}
