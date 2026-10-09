// Nightly clean-up of re-packed AWBs (unit-tested).
//
// When the same tracking id (AWB) is packed again, the newest recording is
// the one that counts: every older recording of that AWB in the same
// organization is deleted (DB row first, re-checked in the same statement,
// then its Storage file; video_assets and share links cascade). Runs every
// night at 02:00 IST and from the admin button (with a dry run).
//
// The newest recording only replaces the older ones when it is a real video:
// upload completed, a Storage path that still exists, and at least
// minKeeperDurationMs long (a 2-second accidental re-scan never wipes the
// real packing video). Older recordings are kept (held back) while they are
// evidence or in use, or when "re-pack" is not certain:
//   legal_hold     legal hold on the recording or its video
//   disputed       video review status 'disputed'
//   shared         an active public share link
//   ajio_wfr       used for an Ajio WFR (CCTV) request
//   flyer_pending  Meesho flyer link-up still PENDING (cleaned a later night)
//   other_order    both recordings carry different order ids
//   far_apart      recorded more than maxGapDays before the newest one
//   order_unclear  the server received it after the newest one (station
//                  clock wrong or offline upload): which is newer is unclear
//
// A Storage delete failure goes to pending_storage_deletions (drained by the
// retention purge), the same retry queue the manual delete uses.

import type { Pool } from 'pg';

export interface DuplicateCleanupBucket {
  file(path: string): {
    delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
    exists(): Promise<[boolean] | boolean[]>;
  };
}

export const DUPLICATE_HOLD_REASONS = [
  'legal_hold', 'disputed', 'shared', 'ajio_wfr', 'flyer_pending', 'other_order', 'far_apart', 'order_unclear',
] as const;
export type DuplicateHoldReason = typeof DUPLICATE_HOLD_REASONS[number];

export interface DuplicateCandidate {
  trackingId: string;
  recordingId: string;
  recordedAt: string | null;
  keptRecordingId: string;
  keptRecordedAt: string | null;
  keptStoragePath: string;
  holdReason: DuplicateHoldReason | null;
}

export interface DuplicateCleanupOptions {
  organizationId: string;
  // Newest recording shorter than this is not treated as the replacement.
  minKeeperDurationMs?: number;
  // Older recordings further back than this are a different shipment.
  maxGapDays?: number;
  // Max older recordings deleted in one run (the next night continues).
  limit?: number;
  concurrency?: number;
  dryRun?: boolean;
}

export interface DuplicateCleanupResult {
  dryRun: boolean;
  awbsWithDuplicates: number;
  recordingsDeleted: number;
  filesDeleted: number;
  // Storage deletes that failed after the row was removed: queued for retry.
  filesQueued: number;
  // Older recordings kept on purpose (see DuplicateHoldReason).
  heldBack: number;
  heldBackByReason: Partial<Record<DuplicateHoldReason, number>>;
  // AWBs skipped because the newest video's file is not in Storage.
  keeperMissing: number;
  failures: number;
  // First 200 deletions (or would-be deletions on a dry run), for the audit log.
  deleted: Array<{ trackingId: string; recordingId: string; keptRecordingId: string }>;
}

export const DEFAULT_MIN_KEEPER_DURATION_MS = 5_000;
export const DEFAULT_MAX_GAP_DAYS = 30;
export const DUPLICATE_CLEANUP_MAX_LIMIT = 5_000;

// Why an older recording `old` must stay, or NULL when it may go. Shared by
// the candidate query and the delete (re-checked at delete time, so a video
// disputed or shared during the run is never removed).
export function holdReasonSql(p: {
  org: string;
  gapDays: string;
  keeperOrderId: string;
  keeperAt: string;
  keeperReceivedAt: string;
}): string {
  return `CASE
             WHEN COALESCE(old.legal_hold, FALSE)
               OR EXISTS (SELECT 1 FROM video_assets h
                          WHERE h.recording_session_id = old.id AND h.organization_id = ${p.org}
                            AND COALESCE(h.legal_hold, FALSE)) THEN 'legal_hold'
             WHEN EXISTS (SELECT 1 FROM video_assets d
                          WHERE d.recording_session_id = old.id AND d.organization_id = ${p.org}
                            AND d.review_status = 'disputed') THEN 'disputed'
             WHEN EXISTS (SELECT 1 FROM video_share_links l
                          JOIN video_assets s ON s.id = l.video_asset_id
                          WHERE s.recording_session_id = old.id AND l.organization_id = ${p.org}
                            AND l.revoked_at IS NULL) THEN 'shared'
             WHEN EXISTS (SELECT 1 FROM ajio_wfr_requests w
                          WHERE w.recording_session_id = old.id AND w.organization_id = ${p.org}) THEN 'ajio_wfr'
             WHEN COALESCE(old.flyer_id, '') <> ''
               AND COALESCE(old.flyer_link_status, 'PENDING') = 'PENDING' THEN 'flyer_pending'
             WHEN COALESCE(BTRIM(old.order_id), '') <> ''
               AND COALESCE(BTRIM(${p.keeperOrderId}), '') <> ''
               AND UPPER(BTRIM(old.order_id)) <> UPPER(BTRIM(${p.keeperOrderId})) THEN 'other_order'
             WHEN old.created_at < ${p.keeperAt} - (${p.gapDays}::int * INTERVAL '1 day') THEN 'far_apart'
             WHEN EXISTS (SELECT 1 FROM video_assets r
                          WHERE r.recording_session_id = old.id AND r.organization_id = ${p.org}
                            AND r.created_at > ${p.keeperReceivedAt}) THEN 'order_unclear'
             ELSE NULL
           END`;
}

// One statement: AWBs recorded more than once, the newest complete video per
// AWB (the keeper), and every older recording of that AWB with the reason it
// must be kept (NULL = deletable). Deletable rows come first, oldest first,
// so the limit never starves on rows that are held back.
export function buildDuplicateCandidatesQuery(
  organizationId: string,
  minKeeperDurationMs: number,
  limit: number,
  maxGapDays: number = DEFAULT_MAX_GAP_DAYS
): { text: string; values: unknown[] } {
  const text = `
    WITH repacked AS (
      SELECT tracking_id
      FROM recording_sessions
      WHERE organization_id = $1
        AND tracking_id IS NOT NULL
        AND tracking_id NOT IN ('', 'UNKNOWN')
      GROUP BY tracking_id
      HAVING COUNT(*) > 1
    ),
    keepers AS (
      SELECT DISTINCT ON (rs.tracking_id)
             rs.tracking_id, rs.id AS keeper_id, rs.created_at AS keeper_at, rs.order_id AS keeper_order_id,
             va.storage_path AS keeper_path, va.created_at AS keeper_received_at
      FROM recording_sessions rs
      JOIN repacked r ON r.tracking_id = rs.tracking_id
      JOIN video_assets va ON va.recording_session_id = rs.id AND va.organization_id = rs.organization_id
      WHERE rs.organization_id = $1
        AND va.upload_status IN ('completed', 'uploaded')
        AND COALESCE(va.storage_path, '') <> ''
        AND COALESCE(va.duration_ms, rs.duration_ms, 0) >= $2
      ORDER BY rs.tracking_id, rs.created_at DESC, rs.id DESC
    )
    SELECT c.* FROM (
    SELECT k.tracking_id, k.keeper_id, k.keeper_path,
           CAST(k.keeper_at AS TEXT) AS keeper_at,
           old.id AS recording_id,
           old.created_at AS old_at,
           CAST(old.created_at AS TEXT) AS recorded_at,
           ${holdReasonSql({
             org: '$1',
             gapDays: '$4',
             keeperOrderId: 'k.keeper_order_id',
             keeperAt: 'k.keeper_at',
             keeperReceivedAt: 'k.keeper_received_at',
           })} AS hold_reason
    FROM keepers k
    JOIN recording_sessions old
      ON old.organization_id = $1
     AND old.tracking_id = k.tracking_id
     AND old.id <> k.keeper_id
     AND old.created_at < k.keeper_at
    ) c
    ORDER BY (c.hold_reason IS NOT NULL), c.old_at, c.recording_id
    LIMIT $3`;
  return { text, values: [organizationId, minKeeperDurationMs, limit, maxGapDays] };
}

// Deletes one older recording only if, at this moment, the kept recording of
// the same AWB still exists, still owns the completed video whose file was
// verified in Storage, is newer, and no hold applies. Returns the Storage
// files of the removed row (read in the same snapshot, before the cascade)
// so they can be deleted afterwards.
export function buildDeleteDuplicateStatement(
  recordingId: string,
  organizationId: string,
  trackingId: string,
  keptRecordingId: string,
  maxGapDays: number,
  keptStoragePath: string
): { text: string; values: unknown[] } {
  const text = `
    WITH k AS (
      SELECT ks.id, ks.order_id AS keeper_order_id, ks.created_at AS keeper_at,
             (SELECT MAX(kv.created_at) FROM video_assets kv
              WHERE kv.recording_session_id = ks.id AND kv.organization_id = $2) AS keeper_received_at
      FROM recording_sessions ks
      WHERE ks.id = $4 AND ks.organization_id = $2 AND ks.tracking_id = $3
        AND EXISTS (SELECT 1 FROM video_assets kf
                    WHERE kf.recording_session_id = ks.id AND kf.organization_id = $2
                      AND kf.upload_status IN ('completed', 'uploaded')
                      AND kf.storage_path = $6)
    ),
    target AS (
      SELECT old.id
      FROM recording_sessions old
      JOIN k ON TRUE
      WHERE old.id = $1 AND old.organization_id = $2 AND old.tracking_id = $3
        AND old.id <> k.id
        AND old.created_at < k.keeper_at
        AND (${holdReasonSql({
          org: '$2',
          gapDays: '$5',
          keeperOrderId: 'k.keeper_order_id',
          keeperAt: 'k.keeper_at',
          keeperReceivedAt: 'k.keeper_received_at',
        })}) IS NULL
    ),
    files AS (
      SELECT va.id, va.storage_path
      FROM video_assets va
      JOIN target t ON va.recording_session_id = t.id
      WHERE va.organization_id = $2 AND COALESCE(va.storage_path, '') <> ''
    ),
    gone AS (
      DELETE FROM recording_sessions r USING target t
      WHERE r.id = t.id AND r.organization_id = $2
      RETURNING r.id
    )
    SELECT (SELECT COUNT(*)::int FROM gone) AS deleted,
           COALESCE((SELECT json_agg(json_build_object('id', f.id, 'path', f.storage_path)) FROM files f), '[]'::json) AS files`;
  return { text, values: [recordingId, organizationId, trackingId, keptRecordingId, maxGapDays, keptStoragePath] };
}

function toCandidate(row: any): DuplicateCandidate {
  return {
    trackingId: String(row.tracking_id),
    recordingId: String(row.recording_id),
    recordedAt: row.recorded_at ?? null,
    keptRecordingId: String(row.keeper_id),
    keptRecordedAt: row.keeper_at ?? null,
    keptStoragePath: String(row.keeper_path || ''),
    holdReason: (row.hold_reason as DuplicateHoldReason | null) || null,
  };
}

async function fileExists(bucket: DuplicateCleanupBucket, path: string): Promise<boolean> {
  const res = await bucket.file(path).exists();
  return Array.isArray(res) ? Boolean(res[0]) : Boolean(res);
}

function parseFiles(value: unknown): Array<{ id: string | null; path: string }> {
  const list = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(list)) return [];
  return list
    .filter((f) => f && typeof f.path === 'string' && f.path)
    .map((f) => ({ id: f.id ? String(f.id) : null, path: String(f.path) }));
}

export async function cleanupDuplicateRecordings(
  pool: Pick<Pool, 'query'>,
  bucket: DuplicateCleanupBucket | null,
  options: DuplicateCleanupOptions
): Promise<DuplicateCleanupResult> {
  const organizationId = options.organizationId;
  const minKeeper = Math.max(0, Math.floor(options.minKeeperDurationMs ?? DEFAULT_MIN_KEEPER_DURATION_MS));
  const maxGapDays = Math.max(1, Math.min(3650, Math.floor(options.maxGapDays ?? DEFAULT_MAX_GAP_DAYS)));
  const limit = Math.max(1, Math.min(DUPLICATE_CLEANUP_MAX_LIMIT, Math.floor(options.limit ?? 500)));
  const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 4)));
  const dryRun = Boolean(options.dryRun);

  const result: DuplicateCleanupResult = {
    dryRun,
    awbsWithDuplicates: 0,
    recordingsDeleted: 0,
    filesDeleted: 0,
    filesQueued: 0,
    heldBack: 0,
    heldBackByReason: {},
    keeperMissing: 0,
    failures: 0,
    deleted: [],
  };
  if (!organizationId) return result;
  // Without Storage the older files could not be removed: deleting only the
  // rows would orphan the bytes. Dry runs still report what would go.
  if (!bucket && !dryRun) return result;

  const query = buildDuplicateCandidatesQuery(organizationId, minKeeper, limit, maxGapDays);
  const res = await pool.query(query.text, query.values);
  const candidates = (res.rows || []).map(toCandidate);
  result.awbsWithDuplicates = new Set(candidates.map((c) => c.trackingId)).size;

  const deletable: DuplicateCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.holdReason) {
      result.heldBack += 1;
      result.heldBackByReason[candidate.holdReason] = (result.heldBackByReason[candidate.holdReason] || 0) + 1;
    } else {
      deletable.push(candidate);
    }
  }

  // The replacement video must really be in Storage before anything older
  // goes (checked once per AWB).
  const keeperOk = new Map<string, boolean>();
  if (bucket) {
    for (const candidate of deletable) {
      if (keeperOk.has(candidate.keptRecordingId)) continue;
      try {
        keeperOk.set(candidate.keptRecordingId, await fileExists(bucket, candidate.keptStoragePath));
      } catch (err) {
        console.warn(`[duplicates] could not check video ${candidate.keptRecordingId} in Storage:`, (err as Error)?.message ?? err);
        keeperOk.set(candidate.keptRecordingId, false);
        result.failures += 1;
      }
    }
    for (const [keptId, ok] of keeperOk) {
      if (!ok) {
        result.keeperMissing += 1;
        console.warn(`[duplicates] newest video ${keptId} is missing in Storage; older recordings of that AWB kept`);
      }
    }
  }
  const toDelete = deletable.filter((c) => !bucket || keeperOk.get(c.keptRecordingId) === true);

  const note = (c: DuplicateCandidate) => {
    if (result.deleted.length < 200) {
      result.deleted.push({ trackingId: c.trackingId, recordingId: c.recordingId, keptRecordingId: c.keptRecordingId });
    }
  };

  if (dryRun || !bucket) {
    toDelete.forEach(note);
    result.recordingsDeleted = toDelete.length;
    return result;
  }

  const queue = [...toDelete];
  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < concurrency; i += 1) {
    workers.push((async () => {
      while (queue.length > 0) {
        const candidate = queue.shift();
        if (!candidate) return;
        let files: Array<{ id: string | null; path: string }> = [];
        try {
          const stmt = buildDeleteDuplicateStatement(
            candidate.recordingId, organizationId, candidate.trackingId, candidate.keptRecordingId, maxGapDays,
            candidate.keptStoragePath
          );
          const del = await pool.query(stmt.text, stmt.values);
          const row = del.rows?.[0];
          if (!row || Number(row.deleted) === 0) {
            // Something changed since the scan (held, kept video deleted, or
            // already gone): leave it for the next night to judge again.
            continue;
          }
          result.recordingsDeleted += 1;
          note(candidate);
          files = parseFiles(row.files);
        } catch (err) {
          result.failures += 1;
          console.error(
            `[duplicates] could not delete older recording ${candidate.recordingId} of ${candidate.trackingId}:`,
            (err as Error)?.message ?? err
          );
          continue;
        }
        for (const file of files) {
          // Never delete the replacement's own file (shared path guard).
          if (file.path === candidate.keptStoragePath) continue;
          try {
            await bucket.file(file.path).delete({ ignoreNotFound: true });
            result.filesDeleted += 1;
          } catch (err) {
            const message = String((err as Error)?.message ?? err).slice(0, 500);
            console.warn(`[duplicates] Storage delete failed for ${file.path}; queued for retry:`, message);
            try {
              await pool.query(
                `INSERT INTO pending_storage_deletions (storage_path, video_asset_id, last_error) VALUES ($1, $2, $3)`,
                [file.path, file.id, message]
              );
              result.filesQueued += 1;
            } catch (queueErr) {
              result.failures += 1;
              console.error('[duplicates] could not queue Storage retry:', (queueErr as Error)?.message ?? queueErr);
            }
          }
        }
      }
    })());
  }
  await Promise.all(workers);
  return result;
}

export function summarizeDuplicateCleanup(result: DuplicateCleanupResult): string {
  const held = Object.entries(result.heldBackByReason)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
  return (
    `${result.dryRun ? 'would delete' : 'deleted'} ${result.recordingsDeleted} older recording(s) ` +
    `across ${result.awbsWithDuplicates} re-packed AWB(s), ${result.filesDeleted} file(s)` +
    `${result.filesQueued ? ` (+${result.filesQueued} queued for retry)` : ''}; ` +
    `held back ${result.heldBack}${held ? ` (${held})` : ''}, ` +
    `newest video missing for ${result.keeperMissing} AWB(s), ${result.failures} failure(s)`
  );
}
