CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    firebase_uid VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organization_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'PACKER',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS warehouses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    location TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recording_sessions (
    id UUID PRIMARY KEY,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    tracking_id VARCHAR(255),
    order_id VARCHAR(255),
    marketplace VARCHAR(100),
    flyer_id VARCHAR(255),
    order_mapping_imported_at TIMESTAMPTZ,
    station_id UUID REFERENCES stations(id) ON DELETE SET NULL,
    operator_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    duration_ms BIGINT,
    
    status VARCHAR(50),
    data_retention_until TIMESTAMPTZ,
    
    camera_device_id TEXT,
    camera_label TEXT,
    
    requested_width INTEGER,
    requested_height INTEGER,
    actual_width INTEGER,
    actual_height INTEGER,
    actual_fps NUMERIC,
    
    mime_type VARCHAR(100),
    video_bitrate INTEGER,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS video_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    recording_session_id UUID REFERENCES recording_sessions(id) ON DELETE CASCADE,
    
    storage_provider VARCHAR(50) DEFAULT 'firebase',
    storage_bucket TEXT,
    storage_path TEXT,
    
    mime_type VARCHAR(100),
    size_bytes BIGINT,
    
    width INTEGER,
    height INTEGER,
    fps NUMERIC,
    duration_ms BIGINT,
    
    upload_status VARCHAR(50),
    
    uploaded_at TIMESTAMPTZ,
    verified_at TIMESTAMPTZ,
    
    retention_until TIMESTAMPTZ,
    legal_hold BOOLEAN DEFAULT FALSE,
    review_status VARCHAR(50) DEFAULT 'none',
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    resource VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS marketplace_order_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    tracking_id VARCHAR(255) NOT NULL,
    order_id VARCHAR(255) NOT NULL,
    marketplace VARCHAR(100) NOT NULL,
    source_file VARCHAR(255),
    imported_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(organization_id, tracking_id)
);

CREATE TABLE IF NOT EXISTS order_import_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    source_file VARCHAR(255),
    mime_type VARCHAR(255),
    raw_file BYTEA,
    imported_rows INTEGER DEFAULT 0,
    skipped_rows INTEGER DEFAULT 0,
    status VARCHAR(50) DEFAULT 'processing',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    raw_purged_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS marketplace_retention_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    marketplace VARCHAR(100) NOT NULL,
    video_retention_days INTEGER,
    data_retention_days INTEGER,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(organization_id, marketplace)
);

CREATE INDEX IF NOT EXISTS idx_recording_sessions_order_id ON recording_sessions(organization_id, order_id);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_marketplace ON recording_sessions(organization_id, marketplace);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_data_retention ON recording_sessions(organization_id, data_retention_until);
CREATE INDEX IF NOT EXISTS idx_marketplace_order_mappings_marketplace ON marketplace_order_mappings(organization_id, marketplace);
CREATE INDEX IF NOT EXISTS idx_marketplace_order_mappings_order_id ON marketplace_order_mappings(organization_id, order_id);
CREATE INDEX IF NOT EXISTS idx_video_assets_retention_until ON video_assets(organization_id, retention_until);

-- Legacy mapping (To transition existing records slowly if needed)
-- Instead of deleting the old videos table, we'll keep it for now but we will use it for the old UI 
-- if they haven't fully transitioned to the new schema. 
-- However, for the new architecture we will rely on recording_sessions and video_assets.
