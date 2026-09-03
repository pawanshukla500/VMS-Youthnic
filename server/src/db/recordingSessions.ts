// Builder for the recording_sessions upsert used by POST /api/videos/upload.
//
// Why a builder: the column list and VALUES list must stay in lockstep (24
// and 24). A previous edit added columns without matching expressions and
// every metadata POST failed with
// "INSERT has more target columns than expressions" while the video file
// itself uploaded fine to Firebase. Unit-tested in
// src/tests/recordingSessions.test.ts — keep them in sync.

export interface RecordingSessionMetadata {
  id: string;
  organizationId: string;
  trackingId: string;
  stationId: string | null;
  operatorUserId: string;
  durationMs: number;
  status: string;
  orderId: string | null;
  marketplace: string | null;
  timestampMs: number;
  width: number;
  height: number;
  fps: number;
  mimeType: string;
  videoBitrate: number | null;
}

export function buildRecordingSessionUpsert(meta: RecordingSessionMetadata): { text: string; values: unknown[] } {
  const text = `INSERT INTO recording_sessions (
          id, organization_id, tracking_id, station_id, operator_user_id,
          started_at, ended_at, duration_ms, status, order_id, marketplace,
          order_mapping_imported_at, data_retention_until, camera_device_id, camera_label,
          requested_width, requested_height, actual_width, actual_height, actual_fps,
          mime_type, video_bitrate, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, to_timestamp($10 / 1000.0), to_timestamp($10 / 1000.0) + INTERVAL '1 second', $6, $7, $8, $9, CASE WHEN $8::text IS NULL AND $9::text IS NULL THEN NULL ELSE NOW() END, NULL, NULL, NULL, $11, $12, $11, $12, $13, $14, $15, to_timestamp($10 / 1000.0), NOW())
        ON CONFLICT (id) DO UPDATE SET
          tracking_id = EXCLUDED.tracking_id,
          station_id = EXCLUDED.station_id,
          operator_user_id = EXCLUDED.operator_user_id,
          started_at = COALESCE(EXCLUDED.started_at, recording_sessions.started_at),
          ended_at = COALESCE(EXCLUDED.ended_at, recording_sessions.ended_at),
          duration_ms = EXCLUDED.duration_ms,
          status = EXCLUDED.status,
          order_id = COALESCE(EXCLUDED.order_id, recording_sessions.order_id),
          marketplace = COALESCE(EXCLUDED.marketplace, recording_sessions.marketplace),
          order_mapping_imported_at = COALESCE(EXCLUDED.order_mapping_imported_at, recording_sessions.order_mapping_imported_at),
          data_retention_until = COALESCE(EXCLUDED.data_retention_until, recording_sessions.data_retention_until),
          camera_device_id = COALESCE(EXCLUDED.camera_device_id, recording_sessions.camera_device_id),
          camera_label = COALESCE(EXCLUDED.camera_label, recording_sessions.camera_label),
          requested_width = COALESCE(EXCLUDED.requested_width, recording_sessions.requested_width),
          requested_height = COALESCE(EXCLUDED.requested_height, recording_sessions.requested_height),
          actual_width = COALESCE(EXCLUDED.actual_width, recording_sessions.actual_width),
          actual_height = COALESCE(EXCLUDED.actual_height, recording_sessions.actual_height),
          actual_fps = COALESCE(EXCLUDED.actual_fps, recording_sessions.actual_fps),
          mime_type = COALESCE(EXCLUDED.mime_type, recording_sessions.mime_type),
          video_bitrate = COALESCE(EXCLUDED.video_bitrate, recording_sessions.video_bitrate),
          updated_at = NOW()`;

  const values = [
    meta.id,
    meta.organizationId,
    meta.trackingId,
    meta.stationId,
    meta.operatorUserId,
    meta.durationMs,
    meta.status,
    meta.orderId,
    meta.marketplace,
    meta.timestampMs,
    meta.width,
    meta.height,
    meta.fps,
    meta.mimeType,
    meta.videoBitrate,
  ];

  return { text, values };
}
