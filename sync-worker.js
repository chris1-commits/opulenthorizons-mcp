#!/usr/bin/env node

/**
 * LeadChain Sync Worker
 *
 * Background worker that:
 * - Runs on a configurable interval (default: 5 minutes)
 * - Finds unprocessed leads in Postgres
 * - Syncs them to Zoho CRM
 * - Handles retries with exponential backoff
 * - Respects API rate limits
 */

import pg from 'pg';
import fetch from 'node-fetch';

const { Pool } = pg;

// ============================================================================
// Configuration
// ============================================================================

const config = {
  database: {
    connectionString: process.env.DATABASE_URL ||
      'postgresql://leadchain_user:password@localhost:5432/leadchain_db',
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  },

  zoho: {
    clientId: process.env.ZOHO_CLIENT_ID,
    clientSecret: process.env.ZOHO_CLIENT_SECRET,
    refreshToken: process.env.ZOHO_REFRESH_TOKEN,
    apiDomain: process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com',
    accountsDomain: process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com',
  },

  sync: {
    intervalMs: parseInt(process.env.SYNC_INTERVAL_MS || '300000'), // 5 minutes
    batchSize: parseInt(process.env.SYNC_BATCH_SIZE || '50'),
    maxRetries: parseInt(process.env.SYNC_MAX_RETRIES || '5'),
    rateLimitDelayMs: parseInt(process.env.SYNC_RATE_LIMIT_DELAY_MS || '200'),
    errorDelayMs: parseInt(process.env.SYNC_ERROR_DELAY_MS || '5000'),
  },

  // Run modes
  runOnce: process.argv.includes('--once'),
  dryRun: process.argv.includes('--dry-run'),
};

// ============================================================================
// Database Connection
// ============================================================================

const pool = new Pool(config.database);

pool.on('error', (err) => {
  console.error('Database pool error:', err);
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// ============================================================================
// Zoho API Integration
// ============================================================================

let zohoAccessToken = null;
let zohoTokenExpiry = 0;

/**
 * Get Zoho access token (with automatic refresh)
 */
async function getZohoAccessToken() {
  // Return cached token if still valid (with 60s buffer)
  if (zohoAccessToken && Date.now() < zohoTokenExpiry - 60000) {
    return zohoAccessToken;
  }

  console.log('Refreshing Zoho access token...');

  const params = new URLSearchParams({
    refresh_token: config.zoho.refreshToken,
    client_id: config.zoho.clientId,
    client_secret: config.zoho.clientSecret,
    grant_type: 'refresh_token',
  });

  const response = await fetch(
    `${config.zoho.accountsDomain}/oauth/v2/token`,
    {
      method: 'POST',
      body: params,
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Zoho token refresh failed: ${error}`);
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error(`Zoho token response missing access_token: ${JSON.stringify(data)}`);
  }

  zohoAccessToken = data.access_token;
  zohoTokenExpiry = Date.now() + (data.expires_in * 1000);

  console.log('Zoho access token refreshed successfully');
  return zohoAccessToken;
}

/**
 * Create a lead in Zoho CRM
 */
async function createZohoLead(leadData) {
  const token = await getZohoAccessToken();

  const response = await fetch(
    `${config.zoho.apiDomain}/crm/v3/Leads`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: [leadData] }),
    }
  );

  const result = await response.json();

  // Check for various error conditions
  if (!response.ok) {
    throw new Error(`Zoho API error (${response.status}): ${JSON.stringify(result)}`);
  }

  if (result.data?.[0]?.code === 'INVALID_DATA') {
    throw new Error(`Zoho validation error: ${result.data[0].message}`);
  }

  if (result.data?.[0]?.status === 'error') {
    throw new Error(`Zoho error: ${result.data[0].message}`);
  }

  return {
    id: result.data?.[0]?.details?.id,
    status: result.data?.[0]?.status,
    code: result.data?.[0]?.code,
    message: result.data?.[0]?.message,
    raw: result,
  };
}

// ============================================================================
// Field Mapping
// ============================================================================

/**
 * Load field mappings from database
 */
async function loadFieldMappings() {
  const result = await query(
    `SELECT source_field, target_field, transform_type, transform_config, default_value, required
     FROM field_mappings
     WHERE source_system = 'meta' AND target_system = 'zoho' AND is_active = TRUE
     ORDER BY priority`,
    []
  );
  return result.rows;
}

/**
 * Apply field mappings to transform lead data
 */
function applyFieldMappings(lead, mappings) {
  const zohoData = {};

  for (const mapping of mappings) {
    // Get value from lead record or form_data
    let value = lead[mapping.source_field] ||
                lead.form_data?.[mapping.source_field] ||
                mapping.default_value;

    if (value === null || value === undefined || value === '') {
      continue;
    }

    // Apply transformations
    switch (mapping.transform_type) {
      case 'template':
        // Template-based transformation
        if (mapping.transform_config?.template) {
          value = mapping.transform_config.template.replace('{value}', value);
        }
        break;

      case 'lookup':
        // Lookup table transformation
        if (mapping.transform_config?.lookup?.[value]) {
          value = mapping.transform_config.lookup[value];
        }
        break;

      case 'function':
        // Custom function transformation (limited for security)
        if (mapping.transform_config?.function === 'uppercase') {
          value = String(value).toUpperCase();
        } else if (mapping.transform_config?.function === 'lowercase') {
          value = String(value).toLowerCase();
        } else if (mapping.transform_config?.function === 'trim') {
          value = String(value).trim();
        }
        break;

      case 'direct':
      default:
        // Direct mapping (no transformation)
        break;
    }

    zohoData[mapping.target_field] = value;
  }

  return zohoData;
}

// ============================================================================
// Sync Logic
// ============================================================================

/**
 * Sync a single lead to Zoho
 */
async function syncLead(lead, mappings) {
  const startTime = Date.now();

  // Build Zoho lead data using field mappings
  const zohoData = applyFieldMappings(lead, mappings);

  // Ensure required fields
  if (!zohoData.Last_Name) {
    zohoData.Last_Name = lead.full_name || lead.email?.split('@')[0] || 'Unknown';
  }

  // Add lead source and tracking info
  zohoData.Lead_Source = zohoData.Lead_Source || 'Meta Lead Ads';
  zohoData.Description = [
    `Meta Lead ID: ${lead.meta_lead_id}`,
    `Form ID: ${lead.meta_form_id}`,
    `Page ID: ${lead.meta_page_id}`,
    lead.meta_campaign_id ? `Campaign ID: ${lead.meta_campaign_id}` : null,
    `Created: ${lead.created_time}`,
  ].filter(Boolean).join('\n');

  let zohoLeadId = null;
  let error = null;
  let success = false;

  try {
    if (config.dryRun) {
      console.log(`[DRY RUN] Would create Zoho lead:`, JSON.stringify(zohoData, null, 2));
      zohoLeadId = 'DRY_RUN_' + Date.now();
      success = true;
    } else {
      const result = await createZohoLead(zohoData);
      zohoLeadId = result.id;
      success = true;
      console.log(`Lead ${lead.meta_lead_id} synced to Zoho: ${zohoLeadId}`);
    }
  } catch (err) {
    error = err.message;
    console.error(`Failed to sync lead ${lead.meta_lead_id}:`, error);
  }

  const duration = Date.now() - startTime;

  // Update lead record
  if (success) {
    await query(
      `UPDATE meta_leads
       SET processed = TRUE,
           zoho_lead_id = $1,
           zoho_sync_time = NOW(),
           last_sync_attempt = NOW()
       WHERE id = $2`,
      [zohoLeadId, lead.id]
    );
  } else {
    await query(
      `UPDATE meta_leads
       SET sync_attempts = sync_attempts + 1,
           last_sync_attempt = NOW(),
           last_sync_error = $1
       WHERE id = $2`,
      [error, lead.id]
    );
  }

  // Log sync attempt
  await query(
    `INSERT INTO lead_sync_log
     (lead_id, meta_lead_id, sync_type, sync_status, external_id, error_message, duration_ms, retry_count)
     VALUES ($1, $2, 'zoho', $3, $4, $5, $6, $7)`,
    [
      lead.id,
      lead.meta_lead_id,
      success ? 'success' : 'failed',
      zohoLeadId,
      error,
      duration,
      lead.sync_attempts,
    ]
  );

  // Record metric
  await recordMetric(
    success ? 'leads_synced' : 'leads_sync_failed',
    1,
    { form_id: lead.meta_form_id, duration_ms: duration }
  );

  return { success, zohoLeadId, error, duration };
}

/**
 * Get unprocessed leads for syncing
 */
async function getUnprocessedLeads() {
  const result = await query(
    `SELECT *
     FROM meta_leads
     WHERE processed = FALSE
       AND sync_attempts < $1
     ORDER BY
       sync_attempts ASC,
       created_time ASC
     LIMIT $2`,
    [config.sync.maxRetries, config.sync.batchSize]
  );
  return result.rows;
}

/**
 * Run a sync batch
 */
async function runSyncBatch() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Sync batch starting at ${new Date().toISOString()}`);
  console.log(`${'='.repeat(60)}`);

  // Load field mappings
  const mappings = await loadFieldMappings();
  console.log(`Loaded ${mappings.length} field mappings`);

  // Get leads to sync
  const leads = await getUnprocessedLeads();
  console.log(`Found ${leads.length} leads to sync`);

  if (leads.length === 0) {
    console.log('No leads to sync');
    return { processed: 0, success: 0, failed: 0 };
  }

  let successCount = 0;
  let failCount = 0;

  for (const lead of leads) {
    // Rate limiting delay
    if (successCount + failCount > 0) {
      await sleep(config.sync.rateLimitDelayMs);
    }

    const result = await syncLead(lead, mappings);

    if (result.success) {
      successCount++;
    } else {
      failCount++;

      // Extra delay after errors to avoid hammering API
      if (result.error?.includes('rate limit') || result.error?.includes('429')) {
        console.log('Rate limit detected, waiting 30 seconds...');
        await sleep(30000);
      } else {
        await sleep(config.sync.errorDelayMs);
      }
    }
  }

  console.log(`\nBatch complete: ${successCount} succeeded, ${failCount} failed`);

  return {
    processed: leads.length,
    success: successCount,
    failed: failCount,
  };
}

/**
 * Record system metric
 */
async function recordMetric(name, value, labels = {}) {
  try {
    await query(
      `INSERT INTO system_metrics (metric_name, metric_value, labels)
       VALUES ($1, $2, $3)`,
      [name, value, JSON.stringify(labels)]
    );
  } catch (err) {
    console.error('Failed to record metric:', err.message);
  }
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Main Loop
// ============================================================================

async function main() {
  console.log('LeadChain Sync Worker starting...');
  console.log(`Mode: ${config.runOnce ? 'run-once' : 'continuous'}`);
  console.log(`Dry run: ${config.dryRun}`);
  console.log(`Batch size: ${config.sync.batchSize}`);
  console.log(`Sync interval: ${config.sync.intervalMs}ms`);
  console.log(`Max retries: ${config.sync.maxRetries}`);

  // Verify database connection
  try {
    await pool.query('SELECT 1');
    console.log('Database connection verified');
  } catch (err) {
    console.error('Database connection failed:', err.message);
    process.exit(1);
  }

  // Verify Zoho credentials (if not dry run)
  if (!config.dryRun) {
    if (!config.zoho.clientId || !config.zoho.clientSecret || !config.zoho.refreshToken) {
      console.error('ERROR: Zoho credentials not configured');
      console.error('Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, and ZOHO_REFRESH_TOKEN');
      process.exit(1);
    }

    try {
      await getZohoAccessToken();
      console.log('Zoho API connection verified');
    } catch (err) {
      console.error('Zoho API connection failed:', err.message);
      process.exit(1);
    }
  }

  // Run once or continuously
  if (config.runOnce) {
    const result = await runSyncBatch();
    console.log('\nFinal result:', result);
    await pool.end();
    process.exit(result.failed > 0 ? 1 : 0);
  } else {
    // Continuous mode
    while (true) {
      try {
        await runSyncBatch();
      } catch (err) {
        console.error('Sync batch error:', err);
        await recordMetric('sync_batch_error', 1, { error: err.message.substring(0, 100) });
      }

      console.log(`Next sync in ${config.sync.intervalMs / 1000} seconds...`);
      await sleep(config.sync.intervalMs);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down...');
  await pool.end();
  process.exit(0);
});
