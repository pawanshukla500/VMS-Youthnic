-- Transient, metadata-only view of browser-local upload queue rows.
-- The video bytes remain in the originating browser's IndexedDB/Firebase path.
CREATE TABLE IF NOT EXISTS video_upload_queue_status (
  recording_id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  operator_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL,
  tracking_id TEXT NOT NULL,
  order_id TEXT,
  marketplace TEXT,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'uploading', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  progress_percent SMALLINT NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  recorded_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retry_command_id UUID UNIQUE,
  retry_command_status VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (retry_command_status IN ('none', 'requested', 'delivered', 'accepted', 'unavailable')),
  retry_requested_at TIMESTAMPTZ,
  retry_command_delivered_at TIMESTAMPTZ,
  retry_command_completed_at TIMESTAMPTZ,
  retry_command_error TEXT,
  retry_requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  upload_attempt_generation BIGINT NOT NULL DEFAULT 0 CHECK (upload_attempt_generation >= 0),
  upload_attempt_token UUID
);

CREATE INDEX IF NOT EXISTS idx_video_upload_queue_status_org
  ON video_upload_queue_status (organization_id, status, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_upload_queue_status_device
  ON video_upload_queue_status (organization_id, operator_user_id, device_id, retry_command_status, retry_requested_at);

ALTER TABLE video_upload_queue_status
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS upload_attempt_generation BIGINT NOT NULL DEFAULT 0 CHECK (upload_attempt_generation >= 0),
  ADD COLUMN IF NOT EXISTS upload_attempt_token UUID;

CREATE INDEX IF NOT EXISTS idx_video_upload_queue_status_admin_cursor
  ON video_upload_queue_status (organization_id, created_at, recording_id);
