-- LeadChain MCP Database Schema
-- Meta Lead Ads → Postgres → Zoho CRM Pipeline

-- Enable UUID extension for unique identifiers
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Meta leads table: stores raw lead data from Meta Lead Ads
CREATE TABLE IF NOT EXISTS meta_leads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meta_lead_id VARCHAR(64) UNIQUE NOT NULL,
    meta_form_id VARCHAR(64) NOT NULL,
    meta_page_id VARCHAR(64) NOT NULL,
    meta_ad_id VARCHAR(64),
    meta_adgroup_id VARCHAR(64),
    meta_campaign_id VARCHAR(64),

    -- Contact information (fetched from Meta Graph API)
    email VARCHAR(255),
    phone VARCHAR(50),
    full_name VARCHAR(255),
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    company VARCHAR(255),
    job_title VARCHAR(255),

    -- Additional form fields stored as JSONB for flexibility
    form_data JSONB DEFAULT '{}',

    -- Processing status
    processed BOOLEAN DEFAULT FALSE,
    sync_attempts INTEGER DEFAULT 0,
    last_sync_attempt TIMESTAMPTZ,
    last_sync_error TEXT,

    -- Zoho integration
    zoho_lead_id VARCHAR(64),
    zoho_sync_time TIMESTAMPTZ,

    -- Timestamps
    created_time TIMESTAMPTZ NOT NULL,
    fetched_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sync log table: tracks every sync attempt for debugging and analytics
CREATE TABLE IF NOT EXISTS lead_sync_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    lead_id UUID NOT NULL REFERENCES meta_leads(id) ON DELETE CASCADE,
    meta_lead_id VARCHAR(64) NOT NULL,

    -- Sync details
    sync_type VARCHAR(20) NOT NULL DEFAULT 'zoho', -- 'zoho', 'notion', etc.
    sync_status VARCHAR(20) NOT NULL, -- 'success', 'failed', 'pending', 'skipped'

    -- Response tracking
    external_id VARCHAR(64), -- zoho_lead_id or other external system ID
    response_code INTEGER,
    response_body JSONB,
    error_message TEXT,
    error_code VARCHAR(50),

    -- Performance metrics
    duration_ms INTEGER,
    retry_count INTEGER DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Field mappings table: configures Meta → Zoho/Notion field transformations
CREATE TABLE IF NOT EXISTS field_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mapping_name VARCHAR(100) NOT NULL,
    source_system VARCHAR(50) NOT NULL DEFAULT 'meta', -- 'meta'
    target_system VARCHAR(50) NOT NULL, -- 'zoho', 'notion', 'hubspot'

    -- Field mapping configuration
    source_field VARCHAR(100) NOT NULL,
    target_field VARCHAR(100) NOT NULL,

    -- Transformation rules
    transform_type VARCHAR(50) DEFAULT 'direct', -- 'direct', 'template', 'lookup', 'function'
    transform_config JSONB DEFAULT '{}',

    -- Validation
    required BOOLEAN DEFAULT FALSE,
    default_value TEXT,

    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    priority INTEGER DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(mapping_name, source_system, target_system, source_field)
);

-- Webhook events table: raw webhook payloads for audit/replay
CREATE TABLE IF NOT EXISTS webhook_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Event identification
    event_type VARCHAR(50) NOT NULL, -- 'leadgen', 'page', etc.
    source VARCHAR(50) NOT NULL DEFAULT 'meta',

    -- Payload
    raw_payload JSONB NOT NULL,
    signature VARCHAR(255),
    signature_valid BOOLEAN,

    -- Processing status
    processed BOOLEAN DEFAULT FALSE,
    processing_error TEXT,

    -- Timestamps
    received_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- System health metrics table: tracks pipeline health
CREATE TABLE IF NOT EXISTS system_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    metric_name VARCHAR(100) NOT NULL,
    metric_value NUMERIC NOT NULL,
    metric_unit VARCHAR(50),
    labels JSONB DEFAULT '{}',
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Meta leads indexes
CREATE INDEX IF NOT EXISTS idx_meta_leads_processed ON meta_leads(processed) WHERE processed = FALSE;
CREATE INDEX IF NOT EXISTS idx_meta_leads_sync_attempts ON meta_leads(sync_attempts) WHERE processed = FALSE;
CREATE INDEX IF NOT EXISTS idx_meta_leads_created_time ON meta_leads(created_time DESC);
CREATE INDEX IF NOT EXISTS idx_meta_leads_meta_lead_id ON meta_leads(meta_lead_id);
CREATE INDEX IF NOT EXISTS idx_meta_leads_zoho_lead_id ON meta_leads(zoho_lead_id) WHERE zoho_lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meta_leads_email ON meta_leads(email) WHERE email IS NOT NULL;

-- Sync log indexes
CREATE INDEX IF NOT EXISTS idx_sync_log_lead_id ON lead_sync_log(lead_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_status ON lead_sync_log(sync_status);
CREATE INDEX IF NOT EXISTS idx_sync_log_created_at ON lead_sync_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_log_sync_type ON lead_sync_log(sync_type);

-- Field mappings indexes
CREATE INDEX IF NOT EXISTS idx_field_mappings_systems ON field_mappings(source_system, target_system) WHERE is_active = TRUE;

-- Webhook events indexes
CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_processed ON webhook_events(processed) WHERE processed = FALSE;

-- System metrics indexes
CREATE INDEX IF NOT EXISTS idx_system_metrics_name ON system_metrics(metric_name, recorded_at DESC);

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
DROP TRIGGER IF EXISTS meta_leads_updated_at ON meta_leads;
CREATE TRIGGER meta_leads_updated_at
    BEFORE UPDATE ON meta_leads
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS field_mappings_updated_at ON field_mappings;
CREATE TRIGGER field_mappings_updated_at
    BEFORE UPDATE ON field_mappings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- DEFAULT FIELD MAPPINGS (Meta → Zoho CRM)
-- ============================================================================

INSERT INTO field_mappings (mapping_name, source_system, target_system, source_field, target_field, required, priority)
VALUES
    ('email_mapping', 'meta', 'zoho', 'email', 'Email', TRUE, 1),
    ('phone_mapping', 'meta', 'zoho', 'phone', 'Phone', FALSE, 2),
    ('first_name_mapping', 'meta', 'zoho', 'first_name', 'First_Name', FALSE, 3),
    ('last_name_mapping', 'meta', 'zoho', 'last_name', 'Last_Name', TRUE, 4),
    ('company_mapping', 'meta', 'zoho', 'company', 'Company', FALSE, 5),
    ('job_title_mapping', 'meta', 'zoho', 'job_title', 'Designation', FALSE, 6),
    ('lead_source_mapping', 'meta', 'zoho', 'meta_form_id', 'Lead_Source', FALSE, 10)
ON CONFLICT (mapping_name, source_system, target_system, source_field) DO NOTHING;

-- ============================================================================
-- VIEWS FOR COMMON QUERIES
-- ============================================================================

-- Unprocessed leads view (what MCP tool queries)
CREATE OR REPLACE VIEW v_unprocessed_leads AS
SELECT
    id,
    meta_lead_id,
    email,
    phone,
    full_name,
    first_name,
    last_name,
    company,
    job_title,
    form_data,
    sync_attempts,
    last_sync_error,
    created_time,
    fetched_at
FROM meta_leads
WHERE processed = FALSE
  AND sync_attempts < 5
ORDER BY created_time DESC;

-- Sync status summary view
CREATE OR REPLACE VIEW v_sync_status AS
SELECT
    DATE_TRUNC('hour', created_at) AS hour,
    sync_type,
    sync_status,
    COUNT(*) AS count,
    AVG(duration_ms) AS avg_duration_ms
FROM lead_sync_log
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY DATE_TRUNC('hour', created_at), sync_type, sync_status
ORDER BY hour DESC;

-- Failed syncs view
CREATE OR REPLACE VIEW v_failed_syncs AS
SELECT
    ml.id,
    ml.meta_lead_id,
    ml.email,
    ml.sync_attempts,
    ml.last_sync_error,
    ml.last_sync_attempt,
    lsl.error_code,
    lsl.response_code
FROM meta_leads ml
LEFT JOIN LATERAL (
    SELECT error_code, response_code
    FROM lead_sync_log
    WHERE lead_id = ml.id
    ORDER BY created_at DESC
    LIMIT 1
) lsl ON TRUE
WHERE ml.processed = FALSE
  AND ml.sync_attempts > 0
ORDER BY ml.last_sync_attempt DESC;

-- ============================================================================
-- GRANTS (adjust role names as needed)
-- ============================================================================

-- Example grants (uncomment and modify for your setup):
-- GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO leadchain_app;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO leadchain_app;
-- GRANT SELECT ON ALL TABLES IN SCHEMA public TO leadchain_readonly;
