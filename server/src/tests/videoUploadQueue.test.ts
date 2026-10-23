import { describe, expect, it } from 'vitest';
import {
  MAX_QUEUE_SYNC_ITEMS,
  buildAdminQueueQuery,
  buildAdminRetryCommandQuery,
  buildCompletedQueueDelete,
  buildQueueStatusBatchUpsert,
  buildQueueStatusUpsert,
  buildUploadAttemptFenceQuery,
  buildRetryCommandAckQuery,
  buildRetryCommandClaimQuery,
  decodeAdminQueueCursor,
  encodeAdminQueueCursor,
  normalizeQueueSyncRequest,
} from '../videoUploadQueue';

const UUID_A = '1678d80c-1234-4abc-8def-1234567890ab';
const UUID_B = '2678d80c-1234-4abc-8def-1234567890ab';
const RECORDED_AT = Date.now() - 60_000;

const validReport = {
  id: UUID_A,
  trackingId: 'SYN-123456789',
  status: 'failed',
  retryCount: 22,
  uploadProgress: 37,
  sizeBytes: 2_048_000,
  timestamp: RECORDED_AT,
  orderId: 'ORDER-1',
  marketplace: 'Ajio',
  error: 'temporary network failure',
  storagePath: 'must-not-be-accepted',
  blob: 'must-not-be-accepted',
  operatorUserId: 'attacker-controlled',
};

describe('upload queue sync request validation', () => {
  it('accepts bounded queue metadata and drops client-controlled identity and file data', () => {
    const result = normalizeQueueSyncRequest({ deviceId: UUID_B, recordings: [validReport] });
    expect(result).not.toBeNull();
    expect(result?.recordings[0]).toEqual({
      recordingId: UUID_A,
      trackingId: 'SYN-123456789',
      status: 'failed',
      retryCount: 22,
      progressPercent: 37,
      sizeBytes: 2_048_000,
      recordedAtMs: RECORDED_AT,
      orderId: 'ORDER-1',
      marketplace: 'Ajio',
      error: 'temporary network failure',
    });
    expect(JSON.stringify(result)).not.toContain('attacker-controlled');
    expect(JSON.stringify(result)).not.toContain('must-not-be-accepted');
  });

  it('redacts credential-shaped text from queue errors before admin storage', () => {
    const result = normalizeQueueSyncRequest({
      deviceId: UUID_B,
      recordings: [{ ...validReport, error: 'Bearer bearer-secret token=api-secret password:pw-secret' }],
    });
    const error = result?.recordings[0].error || '';
    expect(error).not.toContain('bearer-secret');
    expect(error).not.toContain('api-secret');
    expect(error).not.toContain('pw-secret');
    expect(error).toContain('[REDACTED]');
  });

  it('rejects malformed ids, unsupported statuses, invalid progress, and oversized batches', () => {
    expect(normalizeQueueSyncRequest({ deviceId: 'bad', recordings: [] })).toBeNull();
    expect(normalizeQueueSyncRequest({ deviceId: UUID_B, recordings: [{ ...validReport, id: 'bad' }] })).toBeNull();
    expect(normalizeQueueSyncRequest({ deviceId: UUID_B, recordings: [{ ...validReport, status: 'cancelled' }] })).toBeNull();
    expect(normalizeQueueSyncRequest({ deviceId: UUID_B, recordings: [{ ...validReport, status: 'completed' }] })).toBeNull();
    expect(normalizeQueueSyncRequest({ deviceId: UUID_B, recordings: [{ ...validReport, uploadProgress: 101 }] })).toBeNull();
    expect(normalizeQueueSyncRequest({ deviceId: UUID_B, recordings: [validReport, validReport] })).toBeNull();
    const oversized = Array.from({ length: MAX_QUEUE_SYNC_ITEMS + 1 }, (_, index) => ({ ...validReport, id: `${index}` }));
    expect(normalizeQueueSyncRequest({ deviceId: UUID_B, recordings: oversized })).toBeNull();
  });
});

describe('upload queue persistence and tenant-scoped administration', () => {
  it('allows the same user and organization to rebind queue rows after a profile storage fallback', () => {
    const query = buildQueueStatusUpsert(
      { recordingId: UUID_A, trackingId: 'SYN-123456789', status: 'failed', retryCount: 22, progressPercent: 37, sizeBytes: 2048, recordedAtMs: 1_800_000_000_000, orderId: null, marketplace: null, error: null },
      'user-id', 'org-id', UUID_B,
    );
    expect(query.text).toContain('ON CONFLICT (recording_id) DO UPDATE');
    expect(query.text).toContain('video_upload_queue_status.organization_id = EXCLUDED.organization_id');
    expect(query.text).toContain('video_upload_queue_status.operator_user_id = EXCLUDED.operator_user_id');
    expect(query.text).toContain('device_id = EXCLUDED.device_id');
    expect(query.text).not.toMatch(/created_at\s*=\s*EXCLUDED/i);
    expect(query.text).not.toContain('video_upload_queue_status.device_id = EXCLUDED.device_id');
    expect(query.values).toContain('user-id');
    expect(query.values).toContain('org-id');
    expect(query.values).toContain(UUID_B);
  });

  it('builds a single parameterized batch upsert for multiple client rows', () => {
    const report = normalizeQueueSyncRequest({ deviceId: UUID_B, recordings: [validReport] })!.recordings[0];
    const query = buildQueueStatusBatchUpsert(
      [report, { ...report, recordingId: UUID_B, status: 'pending' }],
      'user-id', 'org-id', UUID_B,
    );
    expect(query.text).toContain('VALUES (');
    expect(query.text).toMatch(/\),\s+\(/);
    expect(query.text).toContain('ON CONFLICT (recording_id) DO UPDATE');
    expect(query.values).toHaveLength(30);
    expect(query.values.slice(15, 18)).toEqual([UUID_B, 'org-id', 'user-id']);
    // Parameter types must be cast explicitly so PostgreSQL does not deduce inconsistent types (42P08)
    expect(query.text).toContain('$1::uuid');
    expect(query.text).toContain('$8::varchar');
    expect(query.text).toContain('to_timestamp($12::double precision / 1000.0)');
    // Status parameter $8 must not be reused in last_attempt_at expression
    const dollar8Matches = query.text.match(/\$8\b/g);
    expect(dollar8Matches).toHaveLength(1);
  });

  it('builds an attempt-aware queue upsert that cannot regress a newer server fence', () => {
    const base = normalizeQueueSyncRequest({ deviceId: UUID_B, recordings: [validReport] })!.recordings[0];
    const report = {
      ...base,
      uploadAttemptGeneration: 2,
      uploadAttemptToken: '6678d80c-1234-4abc-8def-1234567890ab',
    };
    const query = buildQueueStatusUpsert(report, 'user-id', 'org-id', UUID_B);
    expect(query.text).toContain('upload_attempt_generation');
    expect(query.text).toContain('upload_attempt_token');
    expect(query.text).toContain('EXCLUDED.upload_attempt_generation > video_upload_queue_status.upload_attempt_generation');
    expect(query.text).toContain('EXCLUDED.upload_attempt_token IS NULL');
    expect(query.text).toContain('EXCLUDED.upload_attempt_generation = video_upload_queue_status.upload_attempt_generation');
    expect(query.text).toContain('EXCLUDED.upload_attempt_token = video_upload_queue_status.upload_attempt_token');
    expect(query.values).toContain(2);
    expect(query.values).toContain('6678d80c-1234-4abc-8def-1234567890ab');
  });

  it('builds a row-lock query bound to owner, organization, device, generation and token', () => {
    const query = buildUploadAttemptFenceQuery(
      UUID_A, 'org-id', 'user-id', UUID_B, 2, '6678d80c-1234-4abc-8def-1234567890ab',
    );
    expect(query.text).toContain('FOR UPDATE');
    expect(query.text).toContain('upload_attempt_generation = $5');
    expect(query.text).toContain('upload_attempt_token = $6');
    expect(query.values).toEqual([UUID_A, 'org-id', 'user-id', UUID_B, 2, '6678d80c-1234-4abc-8def-1234567890ab']);
  });

  it('removes only the scoped queue-status row after the metadata upload succeeds', () => {
    const query = buildCompletedQueueDelete(UUID_A, 'org-id', 'user-id');
    expect(query.text).toContain('DELETE FROM video_upload_queue_status');
    expect(query.text).toContain('recording_id = $1');
    expect(query.text).toContain('organization_id = $2');
    expect(query.text).toContain('operator_user_id = $3');
    expect(query.values).toEqual([UUID_A, 'org-id', 'user-id']);
  });

  it('limits admin list results to the signed-in admin organization and joins packer labels', () => {
    const query = buildAdminQueueQuery('org-id', 200);
    expect(query.text).toContain('WHERE q.organization_id = $1');
    expect(query.text).toContain('JOIN users u ON u.id = q.operator_user_id');
    expect(query.text).toContain('NOT EXISTS');
    expect(query.text).toContain('FROM video_assets va');
    expect(query.text).toContain("va.upload_status IN ('completed', 'uploaded')");
    expect(query.text).not.toContain('FROM recording_sessions');
    expect(query.text).toContain('q.created_at::text AS created_at_cursor');
    expect(query.text).toContain('retry_command_active');
    expect(query.text).toContain("q.retry_command_completed_at >= NOW() - INTERVAL '5 minutes'");
    expect(query.text).toContain('ORDER BY created_at ASC, recording_id ASC');
    expect(query.text).toContain('LIMIT $2');
    expect(query.text).not.toContain('OFFSET');
    expect(query.text).not.toContain('ROW_NUMBER');
    expect(query.values).toEqual(['org-id', 201, null, null]);
  });

  it('uses an immutable keyset cursor so live queue changes cannot shift later pages', () => {
    const createdAt = '2026-10-22 11:30:00.123456+00';
    const query = buildAdminQueueQuery('org-id', 200, { createdAt, recordingId: UUID_A });
    expect(query.text).toContain('(q.created_at, q.recording_id) > ($3::timestamptz, $4::uuid)');
    expect(query.text).toContain('ORDER BY created_at ASC, recording_id ASC');
    expect(query.text).not.toContain('OFFSET');
    expect(query.values).toEqual(['org-id', 201, createdAt, UUID_A]);
  });

  it('round-trips a keyset cursor without losing timestamp precision and rejects invalid tokens', () => {
    const cursor = { createdAt: '2026-10-22 11:30:00.123456+00', recordingId: UUID_A };
    const token = encodeAdminQueueCursor(cursor);
    expect(decodeAdminQueueCursor(token)).toEqual(cursor);
    expect(decodeAdminQueueCursor('not-a-cursor')).toBeNull();
    const invalidTimestampToken = Buffer.from(JSON.stringify({ createdAt: '1', recordingId: UUID_A }), 'utf8').toString('base64url');
    expect(decodeAdminQueueCursor(invalidTimestampToken)).toBeNull();
    expect(() => encodeAdminQueueCursor({ createdAt: '1', recordingId: UUID_A })).toThrow('Invalid admin queue cursor');
    expect(() => encodeAdminQueueCursor({ createdAt: '2026-02-31 11:30:00+00', recordingId: UUID_A })).toThrow('Invalid admin queue cursor');
  });

  it('claims retry commands only for the authenticated user and originating device', () => {
    const query = buildRetryCommandClaimQuery('org-id', 'user-id', UUID_B);
    expect(query.text).toContain('organization_id = $1');
    expect(query.text).toContain('operator_user_id = $2');
    expect(query.text).toContain('device_id = $3');
    expect(query.text).toContain('FOR UPDATE SKIP LOCKED');
    expect(query.values).toEqual(['org-id', 'user-id', UUID_B]);
  });

  it('scopes retry requests and acknowledgements to the user organization and device', () => {
    const request = buildAdminRetryCommandQuery(UUID_A, 'org-id', 'admin-id');
    expect(request.text).toContain('recording_id = $1');
    expect(request.text).toContain('organization_id = $2');
    expect(request.text).toContain('retry_command_status IN (\'none\', \'unavailable\')');
    expect(request.text).toContain("retry_command_status = 'accepted'");
    expect(request.text).toContain("retry_command_completed_at < NOW() - INTERVAL '5 minutes'");
    expect(request.text).not.toContain("retry_command_status = 'accepted' AND last_seen_at");
    expect(request.text).toContain('retry_requested_by = $3');
    expect(request.text).toContain('NOT EXISTS');
    expect(request.text).toContain("va.upload_status IN ('completed', 'uploaded')");
    expect(request.values).toEqual([UUID_A, 'org-id', 'admin-id']);

    const ack = buildRetryCommandAckQuery(UUID_A, 'org-id', 'user-id', UUID_B, 'accepted', null);
    expect(ack.text).toContain('retry_command_id = $1');
    expect(ack.text).toContain('organization_id = $2');
    expect(ack.text).toContain('operator_user_id = $3');
    expect(ack.text).toContain('device_id = $4');
    expect(ack.values).toEqual([UUID_A, 'org-id', 'user-id', UUID_B, 'accepted', null]);
  });
});
