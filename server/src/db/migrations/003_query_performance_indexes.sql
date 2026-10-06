-- 003_query_performance_indexes.sql
-- Composite indexes for the query shapes the application actually runs.
-- Idempotent (IF NOT EXISTS) so ensureRuntimeTables() can run them safely
-- and migrate.ts can replay them without harm.
--
-- Rationale (only indexes for queries that are reachable from a real route
-- and order by an indexed column):

-- video_assets: listing API filters by organization_id + upload_status
-- (e.g. failed-uploads counter, retention preview, purge job). Without this
-- composite, every dashboard load does a full scan on video_assets.
CREATE INDEX IF NOT EXISTS idx_video_assets_org_status_uploaded
  ON video_assets (organization_id, upload_status, uploaded_at);

-- video_assets: same composite but for the create-time dimension
-- (failed-by-day counter, growth chart on the System Health page).
CREATE INDEX IF NOT EXISTS idx_video_assets_org_created
  ON video_assets (organization_id, created_at);

-- recording_sessions: Video Library + Reports filter by station.
-- Covers the user-grouped dashboard query that uses
-- station_id IS NOT NULL ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_recording_sessions_org_station_created
  ON recording_sessions (organization_id, station_id, created_at DESC);

-- recording_sessions: operator-user ("packer") filtering on Reports +
-- admin user view. Required for COUNT(DISTINCT operator_user_id) and
-- per-operator breakdown without sequential scan.
CREATE INDEX IF NOT EXISTS idx_recording_sessions_org_operator_created
  ON recording_sessions (organization_id, operator_user_id, created_at DESC);

-- recording_sessions: tracking_id lookups (resolve-order-context uses
-- (tracking_id = $1 OR tracking_id = $2) with a UNIQUE on the mapping
-- table, but the session side has no covering index, so it scans).
CREATE INDEX IF NOT EXISTS idx_recording_sessions_org_tracking
  ON recording_sessions (organization_id, tracking_id);

-- marketplace_order_mappings: tracking_id is already covered by the
-- UNIQUE(organization_id, tracking_id) constraint, but the LISTING flow
-- uses ILIKE on tracking_id/order_id for the search box. A btree won't
-- help ILIKE directly, but the marketplace-filtered slice is the common
-- case before the user types anything — index it explicitly.
CREATE INDEX IF NOT EXISTS idx_marketplace_order_mappings_org_imported
  ON marketplace_order_mappings (organization_id, imported_at DESC);

-- omsguru_order_cache: status polling refreshes by (status_checked_at)
-- every 5 minutes. Without an index the SELECT WHERE expires becomes a
-- sequential scan on every cron tick.
CREATE INDEX IF NOT EXISTS idx_omsguru_order_cache_org_status_checked
  ON omsguru_order_cache (organization_id, status_checked_at DESC);

-- omsguru_sku_photos: SKU lookup during packing. The UNIQUE(organization_id,
-- sku) covers equality, but the packing page joins by sku alone across
-- warehouses — this gives a covering index for the join target.
CREATE INDEX IF NOT EXISTS idx_omsguru_sku_photos_org_sku
  ON omsguru_sku_photos (organization_id, sku);

-- ajio_wfr_requests: incident id is covered by UNIQUE, but listing the
-- status-pending queue runs ORDER BY requested_at DESC. Index that.
CREATE INDEX IF NOT EXISTS idx_ajio_wfr_requests_org_status_requested
  ON ajio_wfr_requests (organization_id, status, requested_at DESC);

-- audit_logs: every admin "show last 100 events" list orders by created_at.
-- Cheap to maintain, expensive to scan without an index.
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created
  ON audit_logs (organization_id, created_at DESC);