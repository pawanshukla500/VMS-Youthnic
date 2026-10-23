import type { Pool, PoolClient } from 'pg';
import { isAdmin } from './middleware/auth';
import {
  AdminQueueCursor,
  buildAdminQueueQuery,
  buildAdminRetryCommandQuery,
  buildQueueStatusBatchUpsert,
  buildQueueStatusUpsert,
  buildRetryCommandAckQuery,
  buildRetryCommandClaimQuery,
  buildUploadAttemptFenceQuery,
  decodeAdminQueueCursor,
  encodeAdminQueueCursor,
  normalizeQueueSyncRequest,
  sanitizeQueueError,
} from './videoUploadQueue';

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export interface QueueActor {
  user_id?: string;
  organization_id?: string | null;
  role?: unknown;
}

export interface QueueServiceResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

function actorScope(actor: QueueActor) {
  if (!actor.user_id || !actor.organization_id) return null;
  return { userId: actor.user_id, organizationId: actor.organization_id };
}

function safeError(value: unknown): string | null {
  return sanitizeQueueError(value, 500);
}

export async function syncUploadQueueStatus(
  pool: Pool,
  actor: QueueActor,
  body: unknown,
): Promise<QueueServiceResponse> {
  const sync = normalizeQueueSyncRequest(body);
  if (!sync) return { statusCode: 400, body: { error: 'Invalid upload queue sync payload' } };
  const scope = actorScope(actor);
  if (!scope) return { statusCode: 403, body: { error: 'Organization membership required' } };

  if (sync.recordings.length > 0) {
    const upsert = buildQueueStatusBatchUpsert(
      sync.recordings,
      scope.userId,
      scope.organizationId,
      sync.deviceId,
    );
    await pool.query(upsert.text, upsert.values);
  }

  const commandQuery = buildRetryCommandClaimQuery(scope.organizationId, scope.userId, sync.deviceId);
  const claimed = await pool.query(commandQuery.text, commandQuery.values);
  return { statusCode: 200, body: { ok: true, commands: claimed.rows } };
}

export async function registerUploadAttempt(
  pool: Pool,
  actor: QueueActor,
  body: unknown,
): Promise<QueueServiceResponse> {
  if (!body || typeof body !== 'object') return { statusCode: 400, body: { error: 'Invalid upload attempt registration' } };
  const value = body as Record<string, unknown>;
  if (
    typeof value.uploadAttemptGeneration !== 'number'
    || !Number.isSafeInteger(value.uploadAttemptGeneration)
    || value.uploadAttemptGeneration < 1
    || typeof value.uploadAttemptToken !== 'string'
    || !UUID_RE.test(value.uploadAttemptToken)
  ) return { statusCode: 400, body: { error: 'Invalid upload attempt fence' } };

  const sync = normalizeQueueSyncRequest({ deviceId: value.deviceId, recordings: [value.recording] });
  const report = sync?.recordings[0];
  if (!sync || !report || report.status !== 'uploading') {
    return { statusCode: 400, body: { error: 'An uploading recording report is required' } };
  }
  const scope = actorScope(actor);
  if (!scope) return { statusCode: 403, body: { error: 'Organization membership required' } };

  const fencedReport = {
    ...report,
    uploadAttemptGeneration: value.uploadAttemptGeneration,
    uploadAttemptToken: value.uploadAttemptToken,
  };
  const upsert = buildQueueStatusUpsert(
    fencedReport,
    scope.userId,
    scope.organizationId,
    sync.deviceId,
    { allowNewAttempt: true },
  );
  const result = await pool.query(upsert.text, upsert.values);
  const row = result.rows[0] as { upload_attempt_generation?: unknown; upload_attempt_token?: unknown } | undefined;
  if (
    !row
    || Number(row.upload_attempt_generation) !== value.uploadAttemptGeneration
    || String(row.upload_attempt_token).toLowerCase() !== value.uploadAttemptToken.toLowerCase()
  ) return { statusCode: 409, body: { error: 'Upload attempt was superseded by a newer attempt' } };

  return { statusCode: 200, body: { ok: true, uploadAttemptGeneration: value.uploadAttemptGeneration } };
}

export interface CompletedUploadReplay {
  recordingId: string;
  organizationId: string;
  userId: string;
  storagePath: string;
  sizeBytes: number;
}

/** Confirm a lost-response replay against the same tenant, owner, object path, and size. */
export async function isCompletedUploadReplay(pool: Pool, replay: CompletedUploadReplay): Promise<boolean> {
  const result = await pool.query(
    `SELECT va.id
     FROM video_assets va
     JOIN recording_sessions rs
       ON rs.id = va.recording_session_id AND rs.organization_id = va.organization_id
     WHERE va.id = $1::uuid
       AND va.organization_id = $2::uuid
       AND rs.operator_user_id = $3::uuid
       AND va.storage_path = $4::text
       AND va.size_bytes = $5::bigint
       AND va.upload_status IN ('completed', 'uploaded')
     LIMIT 1`,
    [replay.recordingId, replay.organizationId, replay.userId, replay.storagePath, replay.sizeBytes],
  );
  return result.rows.length > 0;
}

export interface LegacyUploadAttemptFence {
  recordingId: string;
  organizationId: string;
  userId: string;
  trackingId: string;
  sizeBytes: number;
  recordedAtMs: number;
}

/** Serialize an old client without attempt fields against any registered modern attempt. */
export async function withLegacyUploadAttemptFence<T>(
  pool: Pool,
  fence: LegacyUploadAttemptFence,
  work: (client: PoolClient) => Promise<T>,
): Promise<{ accepted: true; value: T } | { accepted: false }> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query(
      `INSERT INTO video_upload_queue_status (
         recording_id, organization_id, operator_user_id, device_id, tracking_id,
         status, retry_count, progress_percent, size_bytes, recorded_at, last_seen_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, gen_random_uuid(), $4::text, 'uploading'::varchar, 0, 100, $5::bigint, to_timestamp($6::double precision / 1000.0), NOW(), NOW())
       ON CONFLICT (recording_id) DO NOTHING`,
      [fence.recordingId, fence.organizationId, fence.userId, fence.trackingId, fence.sizeBytes, fence.recordedAtMs],
    );
    const locked = await client.query(
      `SELECT recording_id FROM video_upload_queue_status
       WHERE recording_id = $1::uuid AND organization_id = $2::uuid AND operator_user_id = $3::uuid
         AND upload_attempt_generation = 0 AND upload_attempt_token IS NULL
       FOR UPDATE`,
      [fence.recordingId, fence.organizationId, fence.userId],
    );
    if (locked.rows.length === 0) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return { accepted: false };
    }
    const value = await work(client);
    await client.query('COMMIT');
    transactionOpen = false;
    return { accepted: true, value };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface UploadAttemptFence {
  recordingId: string;
  organizationId: string;
  userId: string;
  deviceId: string;
  uploadAttemptGeneration: number;
  uploadAttemptToken: string;
}

/** Hold the attempt row lock from token validation through metadata writes and queue cleanup. */
export async function withUploadAttemptFence<T>(
  pool: Pool,
  fence: UploadAttemptFence,
  work: (client: PoolClient) => Promise<T>,
): Promise<{ accepted: true; value: T } | { accepted: false }> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const query = buildUploadAttemptFenceQuery(
      fence.recordingId,
      fence.organizationId,
      fence.userId,
      fence.deviceId,
      fence.uploadAttemptGeneration,
      fence.uploadAttemptToken,
    );
    const locked = await client.query(query.text, query.values);
    if (locked.rows.length === 0) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return { accepted: false };
    }
    const value = await work(client);
    await client.query('COMMIT');
    transactionOpen = false;
    return { accepted: true, value };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function acknowledgeUploadRetryCommand(
  pool: Pool,
  actor: QueueActor,
  body: unknown,
): Promise<QueueServiceResponse> {
  if (!body || typeof body !== 'object') return { statusCode: 400, body: { error: 'Invalid retry acknowledgement' } };
  const value = body as Record<string, unknown>;
  if (typeof value.commandId !== 'string' || !UUID_RE.test(value.commandId)) {
    return { statusCode: 400, body: { error: 'Invalid retry command id' } };
  }
  if (typeof value.deviceId !== 'string' || !UUID_RE.test(value.deviceId)) {
    return { statusCode: 400, body: { error: 'Invalid upload device id' } };
  }
  if (value.result !== 'accepted' && value.result !== 'unavailable') {
    return { statusCode: 400, body: { error: 'Invalid retry command result' } };
  }
  const error = safeError(value.error);
  if (value.error != null && value.error !== '' && error === null) {
    return { statusCode: 400, body: { error: 'Invalid retry command error' } };
  }
  const scope = actorScope(actor);
  if (!scope) return { statusCode: 403, body: { error: 'Organization membership required' } };

  const query = buildRetryCommandAckQuery(
    value.commandId,
    scope.organizationId,
    scope.userId,
    value.deviceId,
    value.result,
    error,
  );
  const result = await pool.query(query.text, query.values);
  if (result.rows.length === 0) return { statusCode: 404, body: { error: 'Retry command not found or expired' } };
  return { statusCode: 200, body: { ok: true } };
}

export async function listAdminUploadQueue(
  pool: Pool,
  actor: QueueActor,
  limitValue?: string,
  cursorValue?: string,
): Promise<QueueServiceResponse> {
  if (!isAdmin(actor)) return { statusCode: 403, body: { error: 'Admin access required' } };
  const scope = actorScope(actor);
  if (!scope) return { statusCode: 403, body: { error: 'Organization membership required' } };
  const parsedLimit = limitValue === undefined ? 200 : Number.parseInt(limitValue, 10);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 500)) : 200;
  const cursor: AdminQueueCursor | null = cursorValue === undefined ? null : decodeAdminQueueCursor(cursorValue);
  if (cursorValue !== undefined && !cursor) {
    return { statusCode: 400, body: { error: 'Invalid admin upload queue cursor' } };
  }
  const query = buildAdminQueueQuery(scope.organizationId, limit, cursor);
  const result = await pool.query(query.text, query.values);
  const hasMore = result.rows.length > limit;
  const rawPage = result.rows.slice(0, limit);
  const lastRow = rawPage[rawPage.length - 1] as (Record<string, unknown> & { created_at_cursor?: unknown; recording_id?: unknown }) | undefined;
  const nextCursor = hasMore && lastRow
    ? encodeAdminQueueCursor({ createdAt: String(lastRow.created_at_cursor), recordingId: String(lastRow.recording_id) })
    : null;
  const items = rawPage.map((row) => {
    const { created_at_cursor: _cursorTimestamp, ...item } = row as Record<string, unknown>;
    return item;
  });
  return {
    statusCode: 200,
    body: { items, count: items.length, limit, nextCursor, hasMore },
  };
}

export async function requestAdminUploadRetry(
  pool: Pool,
  actor: QueueActor,
  recordingId: string,
): Promise<QueueServiceResponse> {
  if (!isAdmin(actor)) return { statusCode: 403, body: { error: 'Admin access required' } };
  if (!UUID_RE.test(recordingId)) return { statusCode: 400, body: { error: 'Invalid recording id' } };
  const scope = actorScope(actor);
  if (!scope) return { statusCode: 403, body: { error: 'Organization membership required' } };
  const query = buildAdminRetryCommandQuery(recordingId, scope.organizationId, scope.userId);
  const result = await pool.query(query.text, query.values);
  const command = result.rows[0] as { retry_command_id?: string; retry_command_status?: string } | undefined;
  if (!command?.retry_command_id) {
    return {
      statusCode: 409,
      body: { error: 'A retry is already pending, the source is active, or the recording is no longer stuck in this organization' },
    };
  }
  return {
    statusCode: 202,
    body: { recordingId, commandId: command.retry_command_id, status: command.retry_command_status },
  };
}
