import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  acknowledgeUploadRetryCommand,
  isCompletedUploadReplay,
  listAdminUploadQueue,
  registerUploadAttempt,
  requestAdminUploadRetry,
  syncUploadQueueStatus,
  withLegacyUploadAttemptFence,
  withUploadAttemptFence,
} from '../videoUploadQueueService';
import { encodeAdminQueueCursor } from '../videoUploadQueue';

const ORG_ID = '3678d80c-1234-4abc-8def-1234567890ab';
const USER_ID = '4678d80c-1234-4abc-8def-1234567890ab';
const DEVICE_ID = '2678d80c-1234-4abc-8def-1234567890ab';
const RECORDING_ID = '1678d80c-1234-4abc-8def-1234567890ab';
const COMMAND_ID = '5678d80c-1234-4abc-8def-1234567890ab';
const ATTEMPT_TOKEN = '6678d80c-1234-4abc-8def-1234567890ab';
const NEXT_ATTEMPT_TOKEN = '7678d80c-1234-4abc-8def-1234567890ab';

function fakePool(result: { rows?: unknown[]; rowCount?: number } = { rows: [], rowCount: 1 }) {
  return { query: vi.fn().mockResolvedValue(result) };
}

const packer = { user_id: USER_ID, organization_id: ORG_ID, role: 'PACKER' };
const admin = { user_id: USER_ID, organization_id: ORG_ID, role: 'ADMIN' };

const syncBody = {
  deviceId: DEVICE_ID,
  recordings: [{
    id: RECORDING_ID,
    trackingId: 'SYN-123',
    status: 'failed',
    retryCount: 22,
    uploadProgress: 0,
    sizeBytes: 2_048_000,
    timestamp: Date.now() - 60_000,
    operatorUserId: 'forged-user',
    organizationId: 'forged-org',
  }],
};

describe('upload queue API service authorization', () => {
  it('recognizes a committed metadata replay only for the same owner, path, and byte size', async () => {
    const pool = fakePool({ rows: [{ id: RECORDING_ID }], rowCount: 1 });
    const result = await isCompletedUploadReplay(pool as never, {
      recordingId: RECORDING_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      storagePath: `packing-videos/${ORG_ID}/2026/10/22/ORDER-1/${RECORDING_ID}.webm`,
      sizeBytes: 2_048_000,
    });

    expect(result).toBe(true);
    const [sql, values] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('va.upload_status IN (\'completed\', \'uploaded\')');
    expect(sql).toContain('rs.operator_user_id = $3');
    expect(sql).toContain('va.storage_path = $4');
    expect(sql).toContain('va.size_bytes = $5');
    expect(values).toEqual([
      RECORDING_ID,
      ORG_ID,
      USER_ID,
      `packing-videos/${ORG_ID}/2026/10/22/ORDER-1/${RECORDING_ID}.webm`,
      2_048_000,
    ]);
  });

  it('does not acknowledge a replay when the completed asset does not match', async () => {
    const pool = fakePool({ rows: [], rowCount: 0 });
    const result = await isCompletedUploadReplay(pool as never, {
      recordingId: RECORDING_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      storagePath: `packing-videos/${ORG_ID}/2026/10/22/ORDER-1/${RECORDING_ID}.webm`,
      sizeBytes: 2_048_000,
    });
    expect(result).toBe(false);
  });

  it('stores sync rows under the verified user/org, ignoring client identity', async () => {
    const pool = fakePool();
    const response = await syncUploadQueueStatus(pool as never, packer, syncBody);
    expect(response.statusCode).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(2);
    const [upsertSql, values] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(upsertSql).toContain('ON CONFLICT (recording_id) DO UPDATE');
    expect(values).toContain(USER_ID);
    expect(values).toContain(ORG_ID);
    expect(values).toContain(DEVICE_ID);
    expect(values).not.toContain('forged-user');
    expect(values).not.toContain('forged-org');
  });

  it('rejects malformed sync bodies before reaching the database', async () => {
    const pool = fakePool();
    const response = await syncUploadQueueStatus(pool as never, packer, { deviceId: 'bad', recordings: [] });
    expect(response.statusCode).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('registers an upload attempt under the authenticated scope and returns its stored fence', async () => {
    const pool = fakePool({ rows: [{ recording_id: RECORDING_ID, upload_attempt_generation: 7, upload_attempt_token: ATTEMPT_TOKEN }], rowCount: 1 });
    const response = await registerUploadAttempt(pool as never, packer, {
      deviceId: DEVICE_ID,
      uploadAttemptGeneration: 7,
      uploadAttemptToken: ATTEMPT_TOKEN,
      recording: {
        id: RECORDING_ID,
        trackingId: 'SYN-123',
        status: 'uploading',
        retryCount: 2,
        uploadProgress: 0,
        sizeBytes: 2_048_000,
        timestamp: Date.now() - 60_000,
        operatorUserId: 'forged-user',
        organizationId: 'forged-org',
      },
    });

    expect(response.statusCode).toBe(200);
    const [sql, values] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('upload_attempt_generation');
    expect(sql).toContain('upload_attempt_token');
    expect(values).toContain(7);
    expect(values).toContain(ATTEMPT_TOKEN);
    expect(values).toContain(USER_ID);
    expect(values).toContain(ORG_ID);
    expect(values).not.toContain('forged-user');
    expect(values).not.toContain('forged-org');
  });

  it('accepts uppercase client token matching lowercase postgres uuid return', async () => {
    const uppercaseToken = ATTEMPT_TOKEN.toUpperCase();
    const pool = fakePool({ rows: [{ recording_id: RECORDING_ID, upload_attempt_generation: 7, upload_attempt_token: ATTEMPT_TOKEN.toLowerCase() }], rowCount: 1 });
    const response = await registerUploadAttempt(pool as never, packer, {
      deviceId: DEVICE_ID,
      uploadAttemptGeneration: 7,
      uploadAttemptToken: uppercaseToken,
      recording: {
        id: RECORDING_ID,
        trackingId: 'SYN-123',
        status: 'uploading',
        retryCount: 2,
        uploadProgress: 0,
        sizeBytes: 2_048_000,
        timestamp: 1_700_000_000_000,
      },
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a stale attempt registration when a newer generation already owns the row', async () => {
    const pool = fakePool({ rows: [], rowCount: 0 });
    const response = await registerUploadAttempt(pool as never, packer, {
      deviceId: DEVICE_ID,
      uploadAttemptGeneration: 1,
      uploadAttemptToken: ATTEMPT_TOKEN,
      recording: {
        id: RECORDING_ID,
        trackingId: 'SYN-123',
        status: 'uploading',
        retryCount: 2,
        uploadProgress: 0,
        sizeBytes: 2_048_000,
        timestamp: Date.now() - 60_000,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed or non-uploading attempt registrations before querying', async () => {
    const pool = fakePool();
    const response = await registerUploadAttempt(pool as never, packer, {
      deviceId: DEVICE_ID,
      uploadAttemptGeneration: 0,
      uploadAttemptToken: 'bad',
      recording: { ...syncBody.recordings[0], status: 'failed' },
    });
    expect(response.statusCode).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('serializes metadata writes behind the matching locked server attempt', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        return sql.includes('FOR UPDATE')
          ? { rows: [{ recording_id: RECORDING_ID }], rowCount: 1 }
          : { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const work = vi.fn(async (tx: PoolClient) => {
      await tx.query('WRITE metadata');
      return 'committed';
    });

    const result = await withUploadAttemptFence(pool as never, {
      recordingId: RECORDING_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      uploadAttemptGeneration: 2,
      uploadAttemptToken: NEXT_ATTEMPT_TOKEN,
    }, work);

    expect(result).toEqual({ accepted: true, value: 'committed' });
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toContain('FOR UPDATE');
    expect(statements[2]).toBe('WRITE metadata');
    expect(statements[3]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('serializes legacy metadata requests behind newer server attempts without requiring the new client fields', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        return sql.includes('FOR UPDATE')
          ? { rows: [{ recording_id: RECORDING_ID }], rowCount: 1 }
          : { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const work = vi.fn(async (tx: PoolClient) => {
      await tx.query('WRITE legacy metadata');
      return 'committed';
    });
    const result = await withLegacyUploadAttemptFence(pool as never, {
      recordingId: RECORDING_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      trackingId: 'SYN-123',
      sizeBytes: 2_048_000,
      recordedAtMs: Date.now() - 60_000,
    }, work);

    expect(result).toEqual({ accepted: true, value: 'committed' });
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toContain('ON CONFLICT (recording_id) DO NOTHING');
    expect(statements[1]).toContain('gen_random_uuid()');
    expect(statements[2]).toContain('upload_attempt_generation = 0');
    expect(statements[2]).toContain('FOR UPDATE');
    expect(statements[3]).toBe('WRITE legacy metadata');
    expect(statements[4]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rejects legacy metadata requests when an attempt token already owns the queue row', async () => {
    const client = {
      query: vi.fn(async (sql: string) => sql.includes('FOR UPDATE')
        ? { rows: [], rowCount: 0 }
        : { rows: [], rowCount: 1 }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const work = vi.fn();
    const result = await withLegacyUploadAttemptFence(pool as never, {
      recordingId: RECORDING_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      trackingId: 'SYN-123',
      sizeBytes: 2_048_000,
      recordedAtMs: Date.now() - 60_000,
    }, work);

    expect(result).toEqual({ accepted: false });
    expect(work).not.toHaveBeenCalled();
    expect(client.query.mock.calls[client.query.mock.calls.length - 1][0]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rejects a superseded metadata attempt without running its writes', async () => {
    const client = {
      query: vi.fn(async (sql: string) => sql.includes('FOR UPDATE')
        ? { rows: [], rowCount: 0 }
        : { rows: [], rowCount: 1 }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const work = vi.fn();
    const result = await withUploadAttemptFence(pool as never, {
      recordingId: RECORDING_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      uploadAttemptGeneration: 1,
      uploadAttemptToken: ATTEMPT_TOKEN,
    }, work);

    expect(result).toEqual({ accepted: false });
    expect(work).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[2][0]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('denies packers from the admin queue', async () => {
    const pool = fakePool();
    const response = await listAdminUploadQueue(pool as never, packer);
    expect(response.statusCode).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns keyset-paginated admin queue pages without exposing the internal timestamp cursor', async () => {
    const createdAt = '2026-10-22 11:30:00.123456+00';
    const nextCreatedAt = '2026-10-22 12:00:00.654321+00';
    const cursor = encodeAdminQueueCursor({ createdAt, recordingId: RECORDING_ID });
    const pool = fakePool({ rows: [
      { recording_id: RECORDING_ID, created_at_cursor: nextCreatedAt, packer_email: 'packer@example.test' },
      { recording_id: DEVICE_ID, created_at_cursor: '2026-10-22 12:01:00.000001+00' },
    ] });
    const response = await listAdminUploadQueue(pool as never, admin, '1', cursor);

    expect(response.statusCode).toBe(200);
    expect(response.body.items).toEqual([{ recording_id: RECORDING_ID, packer_email: 'packer@example.test' }]);
    expect(response.body.count).toBe(1);
    expect(response.body.limit).toBe(1);
    expect(response.body.hasMore).toBe(true);
    expect(response.body.nextCursor).toBe(encodeAdminQueueCursor({ createdAt: nextCreatedAt, recordingId: RECORDING_ID }));
    const [sql, values] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('(q.created_at, q.recording_id) > ($3::timestamptz, $4::uuid)');
    expect(values).toEqual([ORG_ID, 2, createdAt, RECORDING_ID]);
  });

  it('rejects malformed admin queue cursors before querying the database', async () => {
    const pool = fakePool();
    const response = await listAdminUploadQueue(pool as never, admin, '200', 'not-a-cursor');
    expect(response.statusCode).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('lets only an admin issue an org-scoped retry command', async () => {
    const deniedPool = fakePool();
    expect((await requestAdminUploadRetry(deniedPool as never, packer, RECORDING_ID)).statusCode).toBe(403);
    expect(deniedPool.query).not.toHaveBeenCalled();

    const pool = fakePool({ rows: [{ retry_command_id: COMMAND_ID, retry_command_status: 'requested' }], rowCount: 1 });
    const response = await requestAdminUploadRetry(pool as never, admin, RECORDING_ID);
    expect(response.statusCode).toBe(202);
    const [, values] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual([RECORDING_ID, ORG_ID, USER_ID]);
  });

  it('does not replace a retry command that is already pending or active', async () => {
    const pool = fakePool({ rows: [], rowCount: 0 });
    const response = await requestAdminUploadRetry(pool as never, admin, RECORDING_ID);
    expect(response.statusCode).toBe(409);
    expect(response.body.error).toMatch(/pending|active/i);
  });

  it('accepts a retry acknowledgement only from its owner and originating device', async () => {
    const pool = fakePool({ rows: [{ recording_id: RECORDING_ID }], rowCount: 1 });
    const response = await acknowledgeUploadRetryCommand(pool as never, packer, {
      commandId: COMMAND_ID,
      deviceId: DEVICE_ID,
      result: 'accepted',
    });
    expect(response.statusCode).toBe(200);
    const [, values] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual([COMMAND_ID, ORG_ID, USER_ID, DEVICE_ID, 'accepted', null]);
  });
});
