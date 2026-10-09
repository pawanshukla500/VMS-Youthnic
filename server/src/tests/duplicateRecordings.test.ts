import { describe, it, expect } from 'vitest';
import {
  buildDeleteDuplicateStatement,
  buildDuplicateCandidatesQuery,
  cleanupDuplicateRecordings,
  summarizeDuplicateCleanup,
  DuplicateCleanupBucket,
  DUPLICATE_HOLD_REASONS,
  DEFAULT_MAX_GAP_DAYS,
  DEFAULT_MIN_KEEPER_DURATION_MS,
} from '../db/duplicateRecordings';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const KEEPER_PATH = `packing-videos/${ORG}/2026/10/9/AWB1/new-1.mp4`;

function candidateRow(over: Record<string, unknown> = {}) {
  return {
    tracking_id: 'AWB1',
    keeper_id: 'new-1',
    keeper_path: KEEPER_PATH,
    keeper_at: '2026-10-09 12:00:00+05:30',
    recording_id: 'old-1',
    recorded_at: '2026-10-09 10:00:00+05:30',
    hold_reason: null,
    ...over,
  };
}

// Mock pool: the scan returns the candidate rows; each guarded delete
// removes the row and hands back its files unless told otherwise.
function mockPool(
  candidates: any[],
  opts: { skipped?: Set<string>; throws?: Set<string>; files?: Record<string, any[]>; queueFails?: boolean } = {}
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes('WITH repacked')) return { rows: candidates, rowCount: candidates.length };
      if (text.includes('WITH k AS')) {
        const id = String(values[0]);
        if (opts.throws?.has(id)) throw new Error('db down');
        if (opts.skipped?.has(id)) return { rows: [{ deleted: 0, files: [] }], rowCount: 1 };
        const files = opts.files?.[id] ?? [{ id, path: `packing-videos/${ORG}/old/${id}.mp4` }];
        return { rows: [{ deleted: 1, files }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO pending_storage_deletions')) {
        if (opts.queueFails) throw new Error('queue down');
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  return { pool: pool as any, calls };
}

function mockBucket(opts: { missing?: Set<string>; failDelete?: Set<string>; existsThrows?: boolean } = {}) {
  const deleted: string[] = [];
  const bucket: DuplicateCleanupBucket = {
    file: (path: string) => ({
      exists: async () => {
        if (opts.existsThrows) throw new Error('storage unavailable');
        return [!opts.missing?.has(path)] as [boolean];
      },
      delete: async () => {
        if (opts.failDelete?.has(path)) throw new Error('storage 503');
        deleted.push(path);
      },
    }),
  };
  return { bucket, deleted };
}

describe('buildDuplicateCandidatesQuery', () => {
  it('binds org, minimum length, limit and gap (never interpolated)', () => {
    const q = buildDuplicateCandidatesQuery(ORG, 5000, 500, 30);
    expect(q.values).toEqual([ORG, 5000, 500, 30]);
    expect(q.text).not.toContain(ORG);
    expect(q.text).toContain('LIMIT $3');
    expect(q.text).toContain("$4::int * INTERVAL '1 day'");
  });

  it('keeps the newest complete, long-enough video per AWB and only targets older ones', () => {
    const q = buildDuplicateCandidatesQuery(ORG, 5000, 500).text;
    expect(q).toContain("tracking_id NOT IN ('', 'UNKNOWN')");
    expect(q).toContain('HAVING COUNT(*) > 1');
    expect(q).toContain("upload_status IN ('completed', 'uploaded')");
    expect(q).toContain('>= $2');
    expect(q).toMatch(/DISTINCT ON \(rs\.tracking_id\)[\s\S]*ORDER BY rs\.tracking_id, rs\.created_at DESC/);
    expect(q).toContain('old.created_at < k.keeper_at');
    // Every lookup is scoped to the organization.
    expect(q.match(/organization_id = \$1/g)?.length).toBeGreaterThanOrEqual(8);
  });

  it('holds back evidence and uncertain re-packs', () => {
    const q = buildDuplicateCandidatesQuery(ORG, 5000, 500).text;
    for (const reason of DUPLICATE_HOLD_REASONS) expect(q).toContain(`'${reason}'`);
    expect(q).toContain('revoked_at IS NULL');
    expect(q).toContain("COALESCE(old.flyer_link_status, 'PENDING') = 'PENDING'");
    // Different order ids (case/space-insensitive) = different shipment.
    expect(q).toContain('UPPER(BTRIM(old.order_id)) <> UPPER(BTRIM(k.keeper_order_id))');
    // Server receive order must agree with the station clock order.
    expect(q).toContain('r.created_at > k.keeper_received_at');
    // Deletable rows first so held-back rows can never starve the limit.
    expect(q).toContain('ORDER BY (c.hold_reason IS NOT NULL), c.old_at');
  });
});

describe('buildDeleteDuplicateStatement', () => {
  it('re-checks keeper, ordering and every hold inside the delete itself', () => {
    const q = buildDeleteDuplicateStatement('old-1', ORG, 'AWB1', 'new-1', 30);
    expect(q.values).toEqual(['old-1', ORG, 'AWB1', 'new-1', 30]);
    expect(q.text).toContain('WHERE ks.id = $4 AND ks.organization_id = $2 AND ks.tracking_id = $3');
    expect(q.text).toContain('old.created_at < k.keeper_at');
    expect(q.text).toMatch(/\(CASE[\s\S]*END\) IS NULL/);
    for (const reason of DUPLICATE_HOLD_REASONS) expect(q.text).toContain(`'${reason}'`);
    // Files are read in the same statement, before the cascade removes them.
    expect(q.text).toMatch(/files AS \([\s\S]*gone AS \(\s*DELETE FROM recording_sessions/);
    expect(q.text).not.toContain(ORG);
  });
});

describe('cleanupDuplicateRecordings', () => {
  it('deletes the older recording (row, then file) and keeps the newest', async () => {
    const { pool, calls } = mockPool([candidateRow()]);
    const { bucket, deleted } = mockBucket();
    const result = await cleanupDuplicateRecordings(pool, bucket, { organizationId: ORG });

    expect(result.recordingsDeleted).toBe(1);
    expect(result.filesDeleted).toBe(1);
    expect(result.awbsWithDuplicates).toBe(1);
    expect(deleted).toEqual([`packing-videos/${ORG}/old/old-1.mp4`]);
    expect(result.deleted).toEqual([{ trackingId: 'AWB1', recordingId: 'old-1', keptRecordingId: 'new-1' }]);

    const del = calls.find((c) => c.text.includes('WITH k AS'))!;
    expect(del.values).toEqual(['old-1', ORG, 'AWB1', 'new-1', DEFAULT_MAX_GAP_DAYS]);
    expect(calls[0].values).toEqual([ORG, DEFAULT_MIN_KEEPER_DURATION_MS, 500, DEFAULT_MAX_GAP_DAYS]);
  });

  it('dry run reports what would go and touches nothing', async () => {
    const { pool, calls } = mockPool([candidateRow(), candidateRow({ recording_id: 'old-2' })]);
    const { bucket, deleted } = mockBucket();
    const result = await cleanupDuplicateRecordings(pool, bucket, { organizationId: ORG, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.recordingsDeleted).toBe(2);
    expect(deleted).toEqual([]);
    expect(calls.some((c) => c.text.includes('DELETE'))).toBe(false);
  });

  it('never deletes older videos when the newest video file is missing in Storage', async () => {
    const { pool, calls } = mockPool([candidateRow(), candidateRow({ recording_id: 'old-2' })]);
    const { bucket, deleted } = mockBucket({ missing: new Set([KEEPER_PATH]) });
    const result = await cleanupDuplicateRecordings(pool, bucket, { organizationId: ORG });
    expect(result.keeperMissing).toBe(1);
    expect(result.recordingsDeleted).toBe(0);
    expect(deleted).toEqual([]);
    expect(calls.some((c) => c.text.includes('WITH k AS'))).toBe(false);
  });

  it('treats a Storage check error as "not verified" (nothing deleted)', async () => {
    const { pool } = mockPool([candidateRow()]);
    const { bucket, deleted } = mockBucket({ existsThrows: true });
    const result = await cleanupDuplicateRecordings(pool, bucket, { organizationId: ORG });
    expect(result.recordingsDeleted).toBe(0);
    expect(result.failures).toBe(1);
    expect(deleted).toEqual([]);
  });

  it('counts held-back recordings by reason and leaves them alone', async () => {
    const { pool, calls } = mockPool([
      candidateRow({ recording_id: 'old-held-1', hold_reason: 'disputed' }),
      candidateRow({ recording_id: 'old-held-2', hold_reason: 'other_order' }),
      candidateRow({ recording_id: 'old-held-3', hold_reason: 'disputed' }),
    ]);
    const { bucket, deleted } = mockBucket();
    const result = await cleanupDuplicateRecordings(pool, bucket, { organizationId: ORG });
    expect(result.heldBack).toBe(3);
    expect(result.heldBackByReason).toEqual({ disputed: 2, other_order: 1 });
    expect(result.recordingsDeleted).toBe(0);
    expect(deleted).toEqual([]);
    expect(calls.some((c) => c.text.includes('WITH k AS'))).toBe(false);
  });

  it('a row that changed since the scan (held / kept video gone) is skipped and its file kept', async () => {
    const { pool } = mockPool([candidateRow()], { skipped: new Set(['old-1']) });
    const { bucket, deleted } = mockBucket();
    const result = await cleanupDuplicateRecordings(pool, bucket, { organizationId: ORG });
    expect(result.recordingsDeleted).toBe(0);
    expect(result.failures).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('a Storage delete failure after the row is gone queues the file for retry', async () => {
    const { pool, calls } = mockPool([candidateRow()]);
    const { bucket } = mockBucket({ failDelete: new Set([`packing-videos/${ORG}/old/old-1.mp4`]) });
    const result = await cleanupDuplicateRecordings(pool, bucket, { organizationId: ORG });
    expect(result.recordingsDeleted).toBe(1);
    expect(result.filesDeleted).toBe(0);
    expect(result.filesQueued).toBe(1);
    const queued = calls.find((c) => c.text.includes('pending_storage_deletions'))!;
    expect(queued.values.slice(0, 2)).toEqual([`packing-videos/${ORG}/old/old-1.mp4`, 'old-1']);
  });

  it('counts a failure when even the retry queue is down', async () => {
    const { pool } = mockPool([candidateRow()], { queueFails: true });
    const { bucket } = mockBucket({ failDelete: new Set([`packing-videos/${ORG}/old/old-1.mp4`]) });
    const result = await cleanupDuplicateRecordings(pool, bucket, { organizationId: ORG });
    expect(result.failures).toBe(1);
  });

  it("never deletes the kept video's own file even if an older row points at it", async () => {
    const { pool } = mockPool([candidateRow()], { files: { 'old-1': [{ id: 'old-1', path: KEEPER_PATH }] } });
    const { bucket, deleted } = mockBucket();
    const result = await cleanupDuplicateRecordings(pool, bucket, { organizationId: ORG });
    expect(deleted).toEqual([]);
    expect(result.recordingsDeleted).toBe(1);
  });

  it('accepts the files list as a JSON string too (driver differences)', async () => {
    const { pool } = mockPool([candidateRow()], {
      files: { 'old-1': JSON.stringify([{ id: 'old-1', path: 'p/old-1.mp4' }]) as any },
    });
    const { bucket, deleted } = mockBucket();
    await cleanupDuplicateRecordings(pool, bucket, { organizationId: ORG });
    expect(deleted).toEqual(['p/old-1.mp4']);
  });

  it('one failing row does not stop the others', async () => {
    const { pool } = mockPool(
      [candidateRow(), candidateRow({ recording_id: 'old-2' }), candidateRow({ recording_id: 'old-3' })],
      { throws: new Set(['old-2']) }
    );
    const { bucket } = mockBucket();
    const result = await cleanupDuplicateRecordings(pool, bucket, { organizationId: ORG, concurrency: 1 });
    expect(result.recordingsDeleted).toBe(2);
    expect(result.failures).toBe(1);
  });

  it('without Storage it deletes nothing (would orphan files) but a dry run still previews', async () => {
    const { pool, calls } = mockPool([candidateRow()]);
    const real = await cleanupDuplicateRecordings(pool, null, { organizationId: ORG });
    expect(real.recordingsDeleted).toBe(0);
    expect(calls).toHaveLength(0);

    const preview = await cleanupDuplicateRecordings(mockPool([candidateRow()]).pool, null, { organizationId: ORG, dryRun: true });
    expect(preview.recordingsDeleted).toBe(1);
  });

  it('clamps limit, minimum length and gap', async () => {
    const { pool, calls } = mockPool([]);
    await cleanupDuplicateRecordings(pool, mockBucket().bucket, {
      organizationId: ORG, limit: 1e9, minKeeperDurationMs: -5, maxGapDays: 0,
    });
    expect(calls[0].values).toEqual([ORG, 0, 5000, 1]);
  });

  it('summary line names deletions, retries, holds and missing videos', () => {
    const line = summarizeDuplicateCleanup({
      dryRun: false, awbsWithDuplicates: 3, recordingsDeleted: 4, filesDeleted: 3, filesQueued: 1, heldBack: 1,
      heldBackByReason: { shared: 1 }, keeperMissing: 1, failures: 0, deleted: [],
    });
    expect(line).toContain('deleted 4 older recording(s) across 3 re-packed AWB(s), 3 file(s) (+1 queued for retry)');
    expect(line).toContain('held back 1 (shared=1)');
    expect(line).toContain('newest video missing for 1 AWB(s)');
  });
});
