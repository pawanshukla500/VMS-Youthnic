export const MAX_QUEUE_SYNC_ITEMS = 200;
const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const QUEUE_STATUSES = new Set(['pending', 'uploading', 'failed']);
const POSTGRES_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

function isValidQueueCursorTimestamp(value: string): boolean {
  return POSTGRES_TIMESTAMP_RE.test(value) && Number.isFinite(Date.parse(value));
}

export interface AdminQueueCursor {
  createdAt: string;
  recordingId: string;
}

export function encodeAdminQueueCursor(cursor: AdminQueueCursor): string {
  if (!UUID_RE.test(cursor.recordingId) || !isValidQueueCursorTimestamp(cursor.createdAt)) {
    throw new Error('Invalid admin queue cursor');
  }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeAdminQueueCursor(value: unknown): AdminQueueCursor | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      typeof parsed.createdAt !== 'string'
      || parsed.createdAt.length > 64
      || !isValidQueueCursorTimestamp(parsed.createdAt)
      || typeof parsed.recordingId !== 'string'
      || !UUID_RE.test(parsed.recordingId)
    ) return null;
    return { createdAt: parsed.createdAt, recordingId: parsed.recordingId };
  } catch {
    return null;
  }
}

export type UploadQueueStatus = 'pending' | 'uploading' | 'failed';

export interface UploadQueueReport {
  recordingId: string;
  trackingId: string;
  status: UploadQueueStatus;
  retryCount: number;
  progressPercent: number;
  sizeBytes: number;
  recordedAtMs: number;
  orderId: string | null;
  marketplace: string | null;
  error: string | null;
  uploadAttemptGeneration?: number;
  uploadAttemptToken?: string | null;
}

export interface NormalizedQueueSyncRequest {
  deviceId: string;
  recordings: UploadQueueReport[];
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : null;
}

function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return boundedText(value, max);
}

export function sanitizeQueueError(value: unknown, max = 500): string | null {
  const text = optionalText(value, max);
  if (!text) return null;
  return text
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b((?:api[-_ ]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(0, max);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Validate the small metadata-only client sync body; never accept blobs or identity fields. */
export function normalizeQueueSyncRequest(input: unknown): NormalizedQueueSyncRequest | null {
  if (!input || typeof input !== 'object') return null;
  const body = input as Record<string, unknown>;
  if (typeof body.deviceId !== 'string' || !UUID_RE.test(body.deviceId)) return null;
  if (!Array.isArray(body.recordings) || body.recordings.length > MAX_QUEUE_SYNC_ITEMS) return null;

  const recordings: UploadQueueReport[] = [];
  const seenRecordingIds = new Set<string>();
  for (const value of body.recordings) {
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    if (typeof row.id !== 'string' || !UUID_RE.test(row.id)) return null;
    const recordingIdKey = row.id.toLowerCase();
    if (seenRecordingIds.has(recordingIdKey)) return null;
    seenRecordingIds.add(recordingIdKey);
    if (typeof row.status !== 'string' || !QUEUE_STATUSES.has(row.status)) return null;
    if (!isIntegerInRange(row.retryCount, 0, 1_000_000)) return null;
    if (!isIntegerInRange(row.uploadProgress, 0, 100)) return null;
    if (!isIntegerInRange(row.sizeBytes, 0, Number.MAX_SAFE_INTEGER)) return null;
    if (!isIntegerInRange(row.timestamp, 1, Date.now() + 24 * 60 * 60 * 1000)) return null;
    const trackingId = boundedText(row.trackingId, 1000);
    if (!trackingId) return null;
    const orderId = optionalText(row.orderId, 1000);
    const marketplace = optionalText(row.marketplace, 100);
    const error = sanitizeQueueError(row.error, 500);
    if (row.orderId != null && row.orderId !== '' && orderId === null) return null;
    if (row.marketplace != null && row.marketplace !== '' && marketplace === null) return null;
    if (row.error != null && row.error !== '' && error === null) return null;
    const uploadAttemptGeneration = row.uploadAttemptGeneration;
    const uploadAttemptToken = row.uploadAttemptToken;
    const hasAttemptFence = uploadAttemptGeneration != null || uploadAttemptToken != null;
    if (hasAttemptFence && (
      typeof uploadAttemptGeneration !== 'number'
      || !Number.isSafeInteger(uploadAttemptGeneration)
      || uploadAttemptGeneration < 1
      || typeof uploadAttemptToken !== 'string'
      || !UUID_RE.test(uploadAttemptToken)
    )) return null;

    recordings.push({
      recordingId: row.id,
      trackingId,
      status: row.status as UploadQueueStatus,
      retryCount: row.retryCount,
      progressPercent: row.uploadProgress,
      sizeBytes: row.sizeBytes,
      recordedAtMs: row.timestamp,
      orderId,
      marketplace,
      error,
      ...(hasAttemptFence ? {
        uploadAttemptGeneration: uploadAttemptGeneration as number,
        uploadAttemptToken: uploadAttemptToken as string,
      } : {}),
    });
  }

  return { deviceId: body.deviceId, recordings };
}

export function buildQueueStatusBatchUpsert(
  reports: UploadQueueReport[],
  userId: string,
  organizationId: string,
  deviceId: string,
  options: { allowNewAttempt?: boolean } = {},
): { text: string; values: unknown[] } {
  if (reports.length === 0) throw new Error('Queue status batch cannot be empty');
  const allowNewAttempt = options.allowNewAttempt === true ? 'TRUE' : 'FALSE';
  const values: unknown[] = [];
  const seen = new Set<string>();
  const tuples = reports.map((report) => {
    const key = report.recordingId.toLowerCase();
    if (seen.has(key)) throw new Error('Queue status batch contains duplicate recording ids');
    seen.add(key);
    const first = values.length + 1;
    values.push(
      report.recordingId,
      organizationId,
      userId,
      deviceId,
      report.trackingId,
      report.orderId,
      report.marketplace,
      report.status,
      report.retryCount,
      report.progressPercent,
      report.sizeBytes,
      report.recordedAtMs,
      report.error,
      report.uploadAttemptGeneration ?? 0,
      report.uploadAttemptToken ?? null,
    );
    const p = (offset: number) => `$${first + offset - 1}`;
    return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)},
      to_timestamp(${p(12)} / 1000.0), CASE WHEN ${p(8)} = 'uploading' THEN NOW() ELSE NULL END,
      ${p(13)}, ${p(14)}, ${p(15)}, NOW(), NOW())`;
  });

  return {
    text: `INSERT INTO video_upload_queue_status (
      recording_id, organization_id, operator_user_id, device_id,
      tracking_id, order_id, marketplace, status, retry_count,
      progress_percent, size_bytes, recorded_at, last_attempt_at, last_error,
      upload_attempt_generation, upload_attempt_token, last_seen_at, updated_at
    ) VALUES ${tuples.join(',\n')}
    ON CONFLICT (recording_id) DO UPDATE SET
      tracking_id = EXCLUDED.tracking_id,
      order_id = EXCLUDED.order_id,
      marketplace = EXCLUDED.marketplace,
      device_id = EXCLUDED.device_id,
      status = EXCLUDED.status,
      retry_count = EXCLUDED.retry_count,
      progress_percent = EXCLUDED.progress_percent,
      size_bytes = EXCLUDED.size_bytes,
      recorded_at = EXCLUDED.recorded_at,
      last_attempt_at = CASE
        WHEN ${allowNewAttempt} AND EXCLUDED.upload_attempt_token IS NOT NULL
          AND EXCLUDED.upload_attempt_generation > video_upload_queue_status.upload_attempt_generation THEN NOW()
        WHEN video_upload_queue_status.upload_attempt_token IS NULL
          AND EXCLUDED.upload_attempt_token IS NULL AND EXCLUDED.status = 'uploading' THEN NOW()
        ELSE video_upload_queue_status.last_attempt_at
      END,
      last_error = EXCLUDED.last_error,
      upload_attempt_generation = CASE
        WHEN ${allowNewAttempt} AND EXCLUDED.upload_attempt_token IS NOT NULL
          AND EXCLUDED.upload_attempt_generation > video_upload_queue_status.upload_attempt_generation
        THEN EXCLUDED.upload_attempt_generation
        ELSE video_upload_queue_status.upload_attempt_generation
      END,
      upload_attempt_token = CASE
        WHEN ${allowNewAttempt} AND EXCLUDED.upload_attempt_token IS NOT NULL
          AND EXCLUDED.upload_attempt_generation > video_upload_queue_status.upload_attempt_generation
        THEN EXCLUDED.upload_attempt_token
        WHEN EXCLUDED.upload_attempt_token = video_upload_queue_status.upload_attempt_token
          AND EXCLUDED.upload_attempt_generation = video_upload_queue_status.upload_attempt_generation
          AND EXCLUDED.status IN ('pending', 'failed')
        THEN NULL
        ELSE video_upload_queue_status.upload_attempt_token
      END,
      last_seen_at = NOW(),
      updated_at = NOW()
    WHERE video_upload_queue_status.organization_id = EXCLUDED.organization_id
      AND video_upload_queue_status.operator_user_id = EXCLUDED.operator_user_id
      AND (
        (EXCLUDED.upload_attempt_token IS NULL AND video_upload_queue_status.upload_attempt_token IS NULL)
        OR (EXCLUDED.upload_attempt_token IS NOT NULL
          AND EXCLUDED.upload_attempt_generation = video_upload_queue_status.upload_attempt_generation
          AND EXCLUDED.upload_attempt_token = video_upload_queue_status.upload_attempt_token
          AND EXCLUDED.device_id = video_upload_queue_status.device_id)
        OR (${allowNewAttempt} AND EXCLUDED.upload_attempt_token IS NOT NULL
          AND EXCLUDED.upload_attempt_generation > video_upload_queue_status.upload_attempt_generation)
      )
    RETURNING recording_id, upload_attempt_generation, upload_attempt_token`,
    values,
  };
}

export function buildQueueStatusUpsert(
  report: UploadQueueReport,
  userId: string,
  organizationId: string,
  deviceId: string,
  options?: { allowNewAttempt?: boolean },
): { text: string; values: unknown[] } {
  return buildQueueStatusBatchUpsert([report], userId, organizationId, deviceId, options);
}

export function buildUploadAttemptFenceQuery(
  recordingId: string,
  organizationId: string,
  userId: string,
  deviceId: string,
  uploadAttemptGeneration: number,
  uploadAttemptToken: string,
): { text: string; values: unknown[] } {
  return {
    text: `SELECT recording_id FROM video_upload_queue_status
      WHERE recording_id = $1
        AND organization_id = $2
        AND operator_user_id = $3
        AND device_id = $4
        AND upload_attempt_generation = $5
        AND upload_attempt_token = $6
      FOR UPDATE`,
    values: [recordingId, organizationId, userId, deviceId, uploadAttemptGeneration, uploadAttemptToken],
  };
}

/** Remove only transient queue telemetry after the video metadata write succeeds. */
export function buildCompletedQueueDelete(
  recordingId: string,
  organizationId: string,
  userId: string,
): { text: string; values: unknown[] } {
  return {
    text: `DELETE FROM video_upload_queue_status
       WHERE recording_id = $1 AND organization_id = $2 AND operator_user_id = $3`,
    values: [recordingId, organizationId, userId],
  };
}

export function buildAdminQueueQuery(
  organizationId: string,
  limit: number,
  cursor?: AdminQueueCursor | null,
): { text: string; values: unknown[] } {
  return {
    text: `WITH queue_rows AS (
         SELECT q.recording_id, q.operator_user_id, q.device_id,
                COALESCE(NULLIF(u.name, ''), u.email, 'Unknown packer') AS packer_name,
                u.email AS packer_email, q.tracking_id, q.order_id, q.marketplace,
                q.status, q.retry_count, q.progress_percent, q.size_bytes,
                q.recorded_at, q.created_at, q.created_at::text AS created_at_cursor,
                q.last_error, q.last_attempt_at, q.last_seen_at,
                q.retry_command_status, q.retry_requested_at, q.retry_command_error,
                (q.last_seen_at >= NOW() - INTERVAL '2 minutes') AS device_online,
                (q.status = 'failed'
                  OR (q.status = 'uploading' AND q.last_seen_at < NOW() - INTERVAL '5 minutes')
                  OR (q.status = 'pending' AND q.recorded_at < NOW() - INTERVAL '15 minutes')) AS is_stuck,
                (q.retry_command_status IN ('requested', 'delivered')
                  OR (q.retry_command_status = 'accepted'
                    AND q.retry_command_completed_at >= NOW() - INTERVAL '5 minutes')) AS retry_command_active
         FROM video_upload_queue_status q
         JOIN users u ON u.id = q.operator_user_id
         WHERE q.organization_id = $1
           AND ($3::timestamptz IS NULL OR (q.created_at, q.recording_id) > ($3::timestamptz, $4::uuid))
           AND NOT EXISTS (
             SELECT 1 FROM video_assets va
             WHERE va.recording_session_id = q.recording_id
               AND va.organization_id = q.organization_id
               AND va.upload_status IN ('completed', 'uploaded')
           )
       )
       SELECT * FROM queue_rows
       ORDER BY created_at ASC, recording_id ASC
       LIMIT $2`,
    values: [organizationId, limit + 1, cursor?.createdAt ?? null, cursor?.recordingId ?? null],
  };
}

export function buildAdminRetryCommandQuery(
  recordingId: string,
  organizationId: string,
  adminUserId: string,
): { text: string; values: unknown[] } {
  return {
    text: `UPDATE video_upload_queue_status
       SET retry_command_id = gen_random_uuid(),
           retry_command_status = 'requested',
           retry_requested_at = NOW(),
           retry_command_delivered_at = NULL,
           retry_command_completed_at = NULL,
           retry_command_error = NULL,
           retry_requested_by = $3,
           updated_at = NOW()
       WHERE recording_id = $1 AND organization_id = $2 AND status <> 'completed'
         AND (
           retry_command_id IS NULL
           OR retry_command_status IN ('none', 'unavailable')
           OR (retry_command_status = 'accepted'
             AND (retry_command_completed_at IS NULL
               OR retry_command_completed_at < NOW() - INTERVAL '5 minutes'))
         )
         AND (
           status = 'failed'
           OR (status = 'uploading' AND last_seen_at < NOW() - INTERVAL '5 minutes')
           OR (status = 'pending' AND recorded_at < NOW() - INTERVAL '15 minutes')
         )
         AND NOT EXISTS (
           SELECT 1 FROM video_assets va
           WHERE va.recording_session_id = video_upload_queue_status.recording_id
             AND va.organization_id = video_upload_queue_status.organization_id
             AND va.upload_status IN ('completed', 'uploaded')
         )
       RETURNING retry_command_id, retry_command_status`,
    values: [recordingId, organizationId, adminUserId],
  };
}

export function buildRetryCommandClaimQuery(
  organizationId: string,
  userId: string,
  deviceId: string,
): { text: string; values: unknown[] } {
  return {
    text: `WITH claimable AS (
         SELECT recording_id FROM video_upload_queue_status
         WHERE organization_id = $1 AND operator_user_id = $2 AND device_id = $3
           AND retry_command_status IN ('requested', 'delivered')
           AND (retry_command_status = 'requested'
             OR retry_command_delivered_at IS NULL
             OR retry_command_delivered_at < NOW() - INTERVAL '1 minute')
         ORDER BY retry_requested_at ASC NULLS FIRST
         LIMIT 20
         FOR UPDATE SKIP LOCKED
       )
       UPDATE video_upload_queue_status q
       SET retry_command_status = 'delivered',
           retry_command_delivered_at = NOW(),
           updated_at = NOW()
       FROM claimable
       WHERE q.recording_id = claimable.recording_id
       RETURNING q.retry_command_id AS "commandId", q.recording_id AS "recordingId"`,
    values: [organizationId, userId, deviceId],
  };
}

export function buildRetryCommandAckQuery(
  commandId: string,
  organizationId: string,
  userId: string,
  deviceId: string,
  result: 'accepted' | 'unavailable',
  error: string | null,
): { text: string; values: unknown[] } {
  return {
    text: `UPDATE video_upload_queue_status
       SET retry_command_status = $5,
           retry_command_completed_at = NOW(),
           retry_command_error = $6,
           last_seen_at = NOW(),
           updated_at = NOW()
       WHERE retry_command_id = $1
         AND organization_id = $2
         AND operator_user_id = $3
         AND device_id = $4
         AND retry_command_status = 'delivered'
       RETURNING recording_id`,
    values: [commandId, organizationId, userId, deviceId, result, error],
  };
}
