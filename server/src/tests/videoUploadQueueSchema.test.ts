import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(__dirname, '..', 'db', 'migrations', '005_video_upload_queue_status.sql');
const runtimeSchema = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');

describe('durable upload queue telemetry schema', () => {
  it('creates tenant- and user-owned queue state with bounded retry commands', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS video_upload_queue_status/i);
    expect(migration).toMatch(/recording_id UUID PRIMARY KEY/i);
    expect(migration).toMatch(/organization_id UUID NOT NULL REFERENCES organizations/i);
    expect(migration).toMatch(/operator_user_id UUID NOT NULL REFERENCES users/i);
    expect(migration).toMatch(/device_id UUID NOT NULL/i);
    expect(migration).toMatch(/upload_attempt_generation BIGINT NOT NULL DEFAULT 0/i);
    expect(migration).toMatch(/upload_attempt_token UUID/i);
    expect(migration).toMatch(/retry_command_status[^,]*CHECK/i);
    expect(migration).toMatch(/requested[^\n]*delivered[^\n]*accepted[^\n]*unavailable/i);
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS[^;]*organization_id[^;]*status/i);
    expect(migration).not.toMatch(/\b(DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
    expect(migration).not.toMatch(/\b(blob|bytea|credential|bearer|password|secret)\b/i);
  });

  it('creates the status table at application startup for existing installations', () => {
    expect(runtimeSchema).toMatch(/CREATE TABLE IF NOT EXISTS video_upload_queue_status/i);
    expect(runtimeSchema).toMatch(/CREATE INDEX IF NOT EXISTS idx_video_upload_queue_status_org/i);
    expect(runtimeSchema).toMatch(/ALTER TABLE video_upload_queue_status ADD COLUMN IF NOT EXISTS upload_attempt_generation/i);
    expect(runtimeSchema).toMatch(/ALTER TABLE video_upload_queue_status ADD COLUMN IF NOT EXISTS upload_attempt_token/i);
  });

  it('adds an immutable creation timestamp and keyset index for stable admin pagination', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toMatch(/created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
    expect(migration).toMatch(/ALTER TABLE video_upload_queue_status[\s\S]*ADD COLUMN IF NOT EXISTS created_at/i);
    expect(migration).toMatch(/idx_video_upload_queue_status_admin_cursor[\s\S]*organization_id, created_at, recording_id/i);
    expect(runtimeSchema).toMatch(/ALTER TABLE video_upload_queue_status ADD COLUMN IF NOT EXISTS created_at/i);
    expect(runtimeSchema).toMatch(/idx_video_upload_queue_status_admin_cursor[^`]*organization_id, created_at, recording_id/i);
  });
});
