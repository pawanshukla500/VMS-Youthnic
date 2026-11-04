-- Shopify order copy state tracking per organization
CREATE TABLE IF NOT EXISTS shopify_sync_state (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  last_run_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  last_orders_seen INTEGER NOT NULL DEFAULT 0,
  last_orders_written INTEGER NOT NULL DEFAULT 0,
  last_photos_written INTEGER NOT NULL DEFAULT 0,
  last_purged INTEGER NOT NULL DEFAULT 0,
  last_duration_ms INTEGER,
  source TEXT,
  source_can_write BOOLEAN,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
