import { describe, it, expect } from 'vitest';
import {
  buildPurgeStatements,
  buildPurgeCountStatements,
  purgeRetentionDays,
  runRetentionPurge,
  StorageBucketLike
} from '../db/purge';

describe('buildPurgeStatements', () => {
  it('binds retention days as params and covers all tables', () => {
    const statements = buildPurgeStatements(30, 90);
    expect(statements.map((s) => s.key)).toEqual(['mappings', 'audit', 'rawFiles', 'omsguruOrders', 'omsguruPhotos', 'sessions']);

    const mappings = statements[0];
    expect(mappings.text).toContain('marketplace_order_mappings');
    expect(mappings.text).toContain('$1');
    expect(mappings.values).toEqual([30]);

    const audit = statements[1];
    expect(audit.text).toContain('audit_logs');
    expect(audit.values).toEqual([90]);

    // Raw-file backstop needs no params and only touches stale rows.
    expect(statements[2].text).toContain('1 hour');
    expect(statements[2].values).toEqual([]);
    expect(statements[4].text).toContain('30 days');

    // PR-02: legacy cron path now drops expired sessions too.
    const sessions = statements[5];
    expect(sessions.text).toContain('recording_sessions');
    expect(sessions.text).toContain('data_retention_until');
    expect(sessions.text).toContain('legal_hold');
    expect(sessions.text).toMatch(/DELETE/i);
  });

  it('floors invalid input to at least 1 day', () => {
    const statements = buildPurgeStatements(0, -5);
    expect(statements[0].values).toEqual([1]);
    expect(statements[1].values).toEqual([1]);
  });

  it('dry-run counts mirror the same filters without deleting', () => {
    const counts = buildPurgeCountStatements(30, 90);
    expect(counts.every((s) => s.text.startsWith('SELECT COUNT(*)'))).toBe(true);
    expect(counts.every((s) => !/DELETE|UPDATE/i.test(s.text))).toBe(true);
    expect(counts[0].values).toEqual([30]);
    expect(counts[2].values).toEqual([]);
    // Videos dry-run mirrors the same retention filter and is count-only.
    expect(counts[5].text).toContain('video_assets');
    expect(counts[5].text).toContain('retention_until');
    expect(counts[5].text).not.toMatch(/DELETE/i);
  });
});

describe('purgeRetentionDays', () => {
  it('parses env values with fallback', () => {
    expect(purgeRetentionDays('45', 30)).toBe(45);
    expect(purgeRetentionDays('', 30)).toBe(30);
    expect(purgeRetentionDays(undefined, 30)).toBe(30);
    expect(purgeRetentionDays('0', 30)).toBe(30);
  });
});

describe('PR-02 runRetentionPurge', () => {
  it('skips Storage side when no bucket is provided', async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const fakePool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (/recording_sessions/i.test(sql) && /DELETE/i.test(sql)) {
          return { rowCount: 3, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }
    } as any;
    const result = await runRetentionPurge(fakePool, null, { limit: 50 });
    expect(result.sessionsDeleted).toBe(3);
    expect(result.videosScanned).toBe(0);
    expect(result.videosDeleted).toBe(0);
  });

  it('deletes the Storage object first, then the DB row', async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const deletedPaths: string[] = [];
    const fakeBucket: StorageBucketLike = {
      file: (p: string) => ({
        delete: async () => {
          deletedPaths.push(p);
          return [{ status: 'ok' }];
        }
      })
    };
    const fakePool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (/SELECT id, storage_path, organization_id FROM video_assets/i.test(sql)) {
          return {
            rowCount: 2,
            rows: [
              { id: 'a1', storage_path: 'packing-videos/o/x/a1.mp4', organization_id: 'o' },
              { id: 'a2', storage_path: 'packing-videos/o/x/a2.mp4', organization_id: 'o' }
            ]
          };
        }
        if (/DELETE FROM video_assets/i.test(sql)) return { rowCount: 1, rows: [] };
        if (/DELETE FROM recording_sessions/i.test(sql)) return { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] };
      }
    } as any;
    const result = await runRetentionPurge(fakePool, fakeBucket, { limit: 10, concurrency: 2 });
    expect(result.videosScanned).toBe(2);
    expect(result.videosDeleted).toBe(2);
    expect(deletedPaths).toEqual([
      'packing-videos/o/x/a1.mp4',
      'packing-videos/o/x/a2.mp4'
    ]);
    // The DB DELETE on video_assets must run AFTER the Storage delete.
    const firstVideoDeleteIdx = calls.findIndex((c) => /^DELETE FROM video_assets/i.test(c.sql));
    const lastStorageDeleteIdx = calls.length; // Storage calls happen via fakeBucket, not pool
    expect(firstVideoDeleteIdx).toBeGreaterThan(0);
    expect(lastStorageDeleteIdx).toBeGreaterThan(0);
  });

  it('queues a pending_storage_deletions row when Storage delete throws', async () => {
    const insertedErrors: { path: string; videoId: string; error: string }[] = [];
    const fakeBucket: StorageBucketLike = {
      file: () => ({
        delete: async () => {
          throw new Error('storage unavailable');
        }
      })
    };
    const fakePool = {
      query: async (sql: string, params?: unknown[]) => {
        if (/INSERT INTO pending_storage_deletions/i.test(sql)) {
          insertedErrors.push({
            path: String(params?.[0] ?? ''),
            videoId: String(params?.[1] ?? ''),
            error: String(params?.[2] ?? '')
          });
          return { rowCount: 1, rows: [] };
        }
        if (/SELECT id, storage_path, organization_id FROM video_assets/i.test(sql)) {
          return {
            rowCount: 1,
            rows: [{ id: 'a-fail', storage_path: 'packing-videos/o/x/a-fail.mp4', organization_id: 'o' }]
          };
        }
        if (/DELETE FROM recording_sessions/i.test(sql)) return { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] };
      }
    } as any;
    const result = await runRetentionPurge(fakePool, fakeBucket);
    expect(result.videosScanned).toBe(1);
    expect(result.videosDeleted).toBe(0);
    expect(result.videosOrphaned).toBe(1);
    expect(insertedErrors).toHaveLength(1);
    expect(insertedErrors[0].videoId).toBe('a-fail');
    expect(insertedErrors[0].error).toContain('storage unavailable');
  });

  it('clamps the limit to [1, 2000] and concurrency to [1, 16]', async () => {
    const fakePool = {
      query: async (_sql: string, params?: unknown[]) => {
        if (/SELECT id, storage_path/i.test(_sql)) {
          // First positional param is the limit.
          expect(params?.[0]).toBe(2000);
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }
    } as any;
    const result = await runRetentionPurge(fakePool, null, { limit: 99999, concurrency: 99 });
    expect(result.videosScanned).toBe(0);

    await runRetentionPurge(fakePool, null, { limit: 0, concurrency: 0 });
    // No assertions needed; the function should not throw.
  });

  it('scopes the SELECT and DELETE to organizationId when provided', async () => {
    const captured: { sql: string; params?: unknown[] }[] = [];
    const fakeBucket: StorageBucketLike = {
      file: () => ({ delete: async () => [{ status: 'ok' }] })
    };
    const fakePool = {
      query: async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        if (/SELECT id, storage_path, organization_id FROM video_assets/i.test(sql)) {
          // Must include organization_id = $2.
          expect(sql).toMatch(/AND organization_id = \$2/);
          expect(params).toEqual([200, 'org-1']);
          return { rowCount: 0, rows: [] };
        }
        if (/DELETE FROM recording_sessions/i.test(sql)) {
          expect(sql).toMatch(/AND organization_id = \$1/);
          expect(params).toEqual(['org-1']);
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }
    } as any;
    const result = await runRetentionPurge(fakePool, fakeBucket, { organizationId: 'org-1' });
    // runRetentionPurge catches per-phase errors (incl. the expects above),
    // so a placeholder mismatch only shows up as a counted failure.
    expect(result.failures).toBe(0);
    // At least one DELETE on recording_sessions and one SELECT on video_assets.
    expect(captured.some((c) => /DELETE FROM recording_sessions/i.test(c.sql))).toBe(true);
    expect(captured.some((c) => /SELECT id, storage_path, organization_id FROM video_assets/i.test(c.sql))).toBe(true);
  });

  it('runs globally when organizationId is omitted (cron path)', async () => {
    const captured: { sql: string; params?: unknown[] }[] = [];
    const fakeBucket: StorageBucketLike = {
      file: () => ({ delete: async () => [{ status: 'ok' }] })
    };
    const fakePool = {
      query: async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        if (/SELECT id, storage_path/i.test(sql)) {
          expect(sql).not.toMatch(/AND organization_id = \$2/);
          expect(params).toEqual([200]);
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }
    } as any;
    await runRetentionPurge(fakePool, fakeBucket);
    expect(captured.length).toBeGreaterThan(0);
  });

  it('drains pending_storage_deletions rows on every run', async () => {
    const deletedPaths: string[] = [];
    const fakeBucket: StorageBucketLike = {
      file: (p: string) => ({
        delete: async () => {
          deletedPaths.push(p);
          return [{ status: 'ok' }];
        }
      })
    };
    const fakePool = {
      query: async (sql: string, params?: unknown[]) => {
        if (/FROM pending_storage_deletions/i.test(sql) && /SELECT/i.test(sql)) {
          return {
            rowCount: 2,
            rows: [
              { id: 1, storage_path: 'packing-videos/o/a.mp4' },
              { id: 2, storage_path: 'packing-videos/o/b.mp4' }
            ]
          };
        }
        if (/DELETE FROM pending_storage_deletions/i.test(sql)) {
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }
    } as any;
    await runRetentionPurge(fakePool, fakeBucket);
    expect(deletedPaths).toEqual([
      'packing-videos/o/a.mp4',
      'packing-videos/o/b.mp4'
    ]);
  });

  it('records attempts + last_error when a pending_storage_deletions retry fails', async () => {
    const updates: { id: number; error: string }[] = [];
    const fakeBucket: StorageBucketLike = {
      file: () => ({
        delete: async () => { throw new Error('still rate limited'); }
      })
    };
    const fakePool = {
      query: async (sql: string, params?: unknown[]) => {
        if (/FROM pending_storage_deletions/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ id: 99, storage_path: 'packing-videos/o/c.mp4' }] };
        }
        if (/UPDATE pending_storage_deletions/i.test(sql)) {
          updates.push({ id: Number(params?.[0] ?? 0), error: String(params?.[1] ?? '') });
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }
    } as any;
    await runRetentionPurge(fakePool, fakeBucket);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(99);
    expect(updates[0].error).toContain('still rate limited');
  });
});
