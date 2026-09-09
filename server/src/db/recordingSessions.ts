// Builder for the recording_sessions upsert used by POST /api/videos/upload.
//
// Why a builder: the column list and VALUES list must stay in lockstep (25
// and 25). A previous edit added columns without matching expressions and
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
  // Meesho flyer-bag barcode scanned at pack time (nullable: only captured
  // when the station's flyer-scan toggle is on).
  flyerId: string | null;
  timestampMs: number;
  width: number;
  height: number;
  fps: number;
  mimeType: string;
  videoBitrate: number | null;
  // Resolved in JS (Date.now() when an order mapping applied, else null) so
  // the SQL needs no CASE over order/marketplace params. Reusing a param in
  // two type contexts (varchar target + ::text cast) once made Postgres fail
  // the whole statement with "inconsistent types deduced for parameter $8".
  orderMappingImportedAtMs: number | null;
}

export function buildRecordingSessionUpsert(meta: RecordingSessionMetadata): { text: string; values: unknown[] } {
  const text = `INSERT INTO recording_sessions (
          id, organization_id, tracking_id, station_id, operator_user_id,
          started_at, ended_at, duration_ms, status, order_id, marketplace,
          order_mapping_imported_at, data_retention_until, camera_device_id, camera_label,
          requested_width, requested_height, actual_width, actual_height, actual_fps,
          mime_type, video_bitrate, created_at, updated_at, flyer_id
        )
        VALUES ($1, $2, $3, $4, $5, to_timestamp($10 / 1000.0), to_timestamp($10 / 1000.0) + INTERVAL '1 second', $6, $7, $8, $9, to_timestamp($16 / 1000.0), NULL, NULL, NULL, $11, $12, $11, $12, $13, $14, $15, to_timestamp($10 / 1000.0), NOW(), $17)
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
          flyer_id = COALESCE(EXCLUDED.flyer_id, recording_sessions.flyer_id),
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
    meta.orderMappingImportedAtMs,
    meta.flyerId,
  ];

  return { text, values };
}

// --- Manual remap (unmapped recordings) ---------------------------------

export interface UnmappedStatus {
  renamed: boolean;
  moved: boolean;
}

function safePathSegment(value: string): string {
  const segment = value.trim() || 'unknown';
  return segment.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// Storage layout (mirrors the upload worker):
// packing-videos/{org}/{yyyy}/{m}/{d}/{orderOrTracking}/{file}
export function mappingStatusForRecording(row: {
  order_id?: string | null;
  marketplace?: string | null;
  storage_path?: string | null;
}): UnmappedStatus {
  const renamed = Boolean(row.order_id?.trim() && row.marketplace?.trim());
  let moved = false;
  if (renamed && row.storage_path) {
    const segments = row.storage_path.split('/');
    moved = segments.length >= 7 && segments[5] === safePathSegment(row.order_id as string);
  }
  return { renamed, moved };
}

// New home for a recording's file when manually assigned to an order.
// Returns null when there is nothing to move (no file or already there).
export function buildMovedStoragePath(storagePath: string | null, orderId: string): string | null {
  if (!storagePath) return null;
  const segments = storagePath.split('/');
  if (segments.length < 7) return null;
  const orderSegment = safePathSegment(orderId);
  if (segments[5] === orderSegment) return null;
  return [...segments.slice(0, 5), orderSegment, ...segments.slice(6)].join('/');
}
