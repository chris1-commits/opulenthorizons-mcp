#!/usr/bin/env node

/**
 * LeadChain MCP Server
 *
 * Model Context Protocol server for Claude integration.
 * Exposes tools to manage Meta Lead Ads → Postgres → Zoho CRM pipeline.
 *
 * Tools:
 * - get_unprocessed_leads: List pending leads awaiting sync
 * - sync_lead_to_zoho: Sync a specific lead to Zoho CRM
 * - get_sync_status: Get pipeline health and statistics
 * - retry_failed_syncs: Bulk retry failed sync attempts
 * - get_lead_details: Get detailed info about a specific lead
 * - get_field_mappings: View current field mapping configuration
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
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
    max: 10,
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
    maxRetries: 5,
    defaultLimit: 50,
    rateLimitDelay: 200, // ms between API calls
  }
};

// ============================================================================
// Database Connection
// ============================================================================

const pool = new Pool(config.database);

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.error(`Slow query (${duration}ms):`, text.substring(0, 100));
    }
    return result;
  } catch (err) {
    console.error('Database query error:', err.message);
    throw err;
  }
}

// ============================================================================
// Zoho API Integration
// ============================================================================

let zohoAccessToken = null;
let zohoTokenExpiry = 0;

async function getZohoAccessToken() {
  // Return cached token if still valid
  if (zohoAccessToken && Date.now() < zohoTokenExpiry - 60000) {
    return zohoAccessToken;
  }

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
  zohoAccessToken = data.access_token;
  zohoTokenExpiry = Date.now() + (data.expires_in * 1000);

  return zohoAccessToken;
}

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

  if (!response.ok || result.data?.[0]?.code === 'INVALID_DATA') {
    throw new Error(
      result.data?.[0]?.message ||
      result.message ||
      `Zoho API error: ${response.status}`
    );
  }

  return result.data?.[0];
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Get unprocessed leads awaiting sync to Zoho
 */
async function getUnprocessedLeads(limit = config.sync.defaultLimit) {
  const result = await query(
    `SELECT
      id,
      meta_lead_id,
      email,
      phone,
      full_name,
      first_name,
      last_name,
      company,
      job_title,
      sync_attempts,
      last_sync_error,
      created_time,
      fetched_at
    FROM meta_leads
    WHERE processed = FALSE
      AND sync_attempts < $1
    ORDER BY created_time DESC
    LIMIT $2`,
    [config.sync.maxRetries, Math.min(limit, 200)]
  );

  return {
    count: result.rows.length,
    leads: result.rows.map(row => ({
      id: row.id,
      metaLeadId: row.meta_lead_id,
      email: row.email,
      phone: row.phone,
      name: row.full_name || `${row.first_name || ''} ${row.last_name || ''}`.trim(),
      company: row.company,
      jobTitle: row.job_title,
      syncAttempts: row.sync_attempts,
      lastError: row.last_sync_error,
      createdAt: row.created_time,
      fetchedAt: row.fetched_at,
    })),
    hasMore: result.rows.length === limit,
  };
}

/**
 * Sync a specific lead to Zoho CRM
 */
async function syncLeadToZoho(leadId) {
  const startTime = Date.now();

  // Fetch lead from database
  const leadResult = await query(
    `SELECT * FROM meta_leads WHERE id = $1`,
    [leadId]
  );

  if (leadResult.rows.length === 0) {
    return {
      success: false,
      error: 'Lead not found',
      leadId,
    };
  }

  const lead = leadResult.rows[0];

  // Check if already processed
  if (lead.processed && lead.zoho_lead_id) {
    return {
      success: true,
      message: 'Lead already synced to Zoho',
      leadId,
      zohoLeadId: lead.zoho_lead_id,
      alreadyProcessed: true,
    };
  }

  // Get field mappings
  const mappingsResult = await query(
    `SELECT source_field, target_field, transform_type, transform_config, default_value
     FROM field_mappings
     WHERE source_system = 'meta' AND target_system = 'zoho' AND is_active = TRUE
     ORDER BY priority`,
    []
  );

  // Build Zoho lead data
  const zohoData = {};
  for (const mapping of mappingsResult.rows) {
    let value = lead[mapping.source_field] ||
                lead.form_data?.[mapping.source_field] ||
                mapping.default_value;

    if (value) {
      zohoData[mapping.target_field] = value;
    }
  }

  // Add lead source tracking
  zohoData.Lead_Source = zohoData.Lead_Source || 'Meta Lead Ads';
  zohoData.Description = `Meta Lead ID: ${lead.meta_lead_id}\nForm ID: ${lead.meta_form_id}\nCreated: ${lead.created_time}`;

  // Ensure required fields
  if (!zohoData.Last_Name) {
    zohoData.Last_Name = lead.full_name || lead.email?.split('@')[0] || 'Unknown';
  }

  let syncResult;
  let error = null;
  let zohoLeadId = null;

  try {
    const zohoResponse = await createZohoLead(zohoData);
    zohoLeadId = zohoResponse.details?.id;

    // Update lead as processed
    await query(
      `UPDATE meta_leads
       SET processed = TRUE,
           zoho_lead_id = $1,
           zoho_sync_time = NOW(),
           last_sync_attempt = NOW()
       WHERE id = $2`,
      [zohoLeadId, leadId]
    );

    syncResult = {
      success: true,
      leadId,
      zohoLeadId,
      message: 'Lead successfully synced to Zoho CRM',
    };
  } catch (err) {
    error = err.message;

    // Increment sync attempts
    await query(
      `UPDATE meta_leads
       SET sync_attempts = sync_attempts + 1,
           last_sync_attempt = NOW(),
           last_sync_error = $1
       WHERE id = $2`,
      [error, leadId]
    );

    syncResult = {
      success: false,
      leadId,
      error,
      syncAttempts: lead.sync_attempts + 1,
    };
  }

  const duration = Date.now() - startTime;

  // Log sync attempt
  await query(
    `INSERT INTO lead_sync_log
     (lead_id, meta_lead_id, sync_type, sync_status, external_id, error_message, duration_ms, retry_count)
     VALUES ($1, $2, 'zoho', $3, $4, $5, $6, $7)`,
    [
      leadId,
      lead.meta_lead_id,
      syncResult.success ? 'success' : 'failed',
      zohoLeadId,
      error,
      duration,
      lead.sync_attempts,
    ]
  );

  return syncResult;
}

/**
 * Get sync status and statistics
 */
async function getSyncStatus(hours = 24) {
  const hoursInt = Math.min(Math.max(1, hours), 168); // 1 hour to 1 week

  // Get overall statistics
  const statsResult = await query(
    `SELECT
      COUNT(*) FILTER (WHERE processed = TRUE) AS synced_count,
      COUNT(*) FILTER (WHERE processed = FALSE) AS pending_count,
      COUNT(*) FILTER (WHERE processed = FALSE AND sync_attempts > 0) AS failed_count,
      COUNT(*) FILTER (WHERE processed = FALSE AND sync_attempts >= $1) AS abandoned_count,
      COUNT(*) AS total_count
    FROM meta_leads
    WHERE fetched_at > NOW() - INTERVAL '1 hour' * $2`,
    [config.sync.maxRetries, hoursInt]
  );

  // Get recent sync log statistics
  const syncStatsResult = await query(
    `SELECT
      sync_status,
      COUNT(*) AS count,
      AVG(duration_ms)::INTEGER AS avg_duration_ms,
      MAX(duration_ms) AS max_duration_ms
    FROM lead_sync_log
    WHERE created_at > NOW() - INTERVAL '1 hour' * $1
    GROUP BY sync_status`,
    [hoursInt]
  );

  // Get recent errors
  const errorsResult = await query(
    `SELECT
      ml.id,
      ml.meta_lead_id,
      ml.email,
      ml.last_sync_error,
      ml.sync_attempts,
      ml.last_sync_attempt
    FROM meta_leads ml
    WHERE ml.processed = FALSE
      AND ml.sync_attempts > 0
      AND ml.last_sync_attempt > NOW() - INTERVAL '1 hour' * $1
    ORDER BY ml.last_sync_attempt DESC
    LIMIT 10`,
    [hoursInt]
  );

  // Get throughput by hour
  const throughputResult = await query(
    `SELECT
      DATE_TRUNC('hour', created_at) AS hour,
      COUNT(*) FILTER (WHERE sync_status = 'success') AS success_count,
      COUNT(*) FILTER (WHERE sync_status = 'failed') AS failed_count
    FROM lead_sync_log
    WHERE created_at > NOW() - INTERVAL '1 hour' * $1
    GROUP BY DATE_TRUNC('hour', created_at)
    ORDER BY hour DESC
    LIMIT 24`,
    [hoursInt]
  );

  const stats = statsResult.rows[0];
  const syncStats = {};
  for (const row of syncStatsResult.rows) {
    syncStats[row.sync_status] = {
      count: parseInt(row.count),
      avgDurationMs: row.avg_duration_ms,
      maxDurationMs: row.max_duration_ms,
    };
  }

  const successCount = syncStats.success?.count || 0;
  const failedCount = syncStats.failed?.count || 0;
  const totalAttempts = successCount + failedCount;
  const successRate = totalAttempts > 0
    ? ((successCount / totalAttempts) * 100).toFixed(1)
    : 'N/A';

  return {
    period: `Last ${hoursInt} hours`,
    summary: {
      totalLeads: parseInt(stats.total_count),
      syncedLeads: parseInt(stats.synced_count),
      pendingLeads: parseInt(stats.pending_count),
      failedLeads: parseInt(stats.failed_count),
      abandonedLeads: parseInt(stats.abandoned_count),
      successRate: `${successRate}%`,
    },
    syncAttempts: syncStats,
    recentErrors: errorsResult.rows.map(row => ({
      id: row.id,
      metaLeadId: row.meta_lead_id,
      email: row.email,
      error: row.last_sync_error,
      attempts: row.sync_attempts,
      lastAttempt: row.last_sync_attempt,
    })),
    hourlyThroughput: throughputResult.rows.map(row => ({
      hour: row.hour,
      success: parseInt(row.success_count),
      failed: parseInt(row.failed_count),
    })),
    recommendations: generateRecommendations(stats, syncStats, errorsResult.rows),
  };
}

/**
 * Generate actionable recommendations based on status
 */
function generateRecommendations(stats, syncStats, errors) {
  const recommendations = [];

  const pendingCount = parseInt(stats.pending_count);
  const failedCount = parseInt(stats.failed_count);
  const abandonedCount = parseInt(stats.abandoned_count);

  if (pendingCount > 100) {
    recommendations.push({
      severity: 'warning',
      message: `High pending lead count (${pendingCount}). Consider checking if sync worker is running.`,
    });
  }

  if (failedCount > 10) {
    recommendations.push({
      severity: 'warning',
      message: `${failedCount} leads have failed sync attempts. Review errors and consider retry.`,
    });
  }

  if (abandonedCount > 0) {
    recommendations.push({
      severity: 'error',
      message: `${abandonedCount} leads have exceeded max retry attempts. Manual intervention needed.`,
    });
  }

  // Check for common error patterns
  const errorMessages = errors.map(e => e.last_sync_error).filter(Boolean);
  const authErrors = errorMessages.filter(e =>
    e.includes('INVALID_TOKEN') || e.includes('authentication') || e.includes('401')
  );
  if (authErrors.length > 0) {
    recommendations.push({
      severity: 'error',
      message: 'Authentication errors detected. Check Zoho API credentials.',
    });
  }

  const rateLimitErrors = errorMessages.filter(e =>
    e.includes('rate limit') || e.includes('429') || e.includes('TOO_MANY_REQUESTS')
  );
  if (rateLimitErrors.length > 0) {
    recommendations.push({
      severity: 'warning',
      message: 'Rate limit errors detected. Consider reducing sync frequency.',
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      severity: 'info',
      message: 'Pipeline is healthy. No immediate actions required.',
    });
  }

  return recommendations;
}

/**
 * Retry failed sync attempts
 */
async function retryFailedSyncs(maxAttempts = 3) {
  const maxAttemptsInt = Math.min(Math.max(1, maxAttempts), config.sync.maxRetries);

  // Get failed leads eligible for retry
  const failedResult = await query(
    `SELECT id, meta_lead_id, email, sync_attempts
     FROM meta_leads
     WHERE processed = FALSE
       AND sync_attempts > 0
       AND sync_attempts < $1
     ORDER BY last_sync_attempt ASC
     LIMIT 50`,
    [maxAttemptsInt]
  );

  if (failedResult.rows.length === 0) {
    return {
      message: 'No failed leads eligible for retry',
      retriedCount: 0,
      results: [],
    };
  }

  const results = [];
  let successCount = 0;
  let failCount = 0;

  for (const lead of failedResult.rows) {
    // Add delay to respect rate limits
    await new Promise(resolve => setTimeout(resolve, config.sync.rateLimitDelay));

    const syncResult = await syncLeadToZoho(lead.id);
    results.push({
      id: lead.id,
      metaLeadId: lead.meta_lead_id,
      email: lead.email,
      previousAttempts: lead.sync_attempts,
      ...syncResult,
    });

    if (syncResult.success) {
      successCount++;
    } else {
      failCount++;
    }
  }

  return {
    message: `Retry completed: ${successCount} succeeded, ${failCount} failed`,
    retriedCount: results.length,
    successCount,
    failCount,
    results,
  };
}

/**
 * Get detailed information about a specific lead
 */
async function getLeadDetails(leadId) {
  // Try to find by UUID or meta_lead_id
  const leadResult = await query(
    `SELECT * FROM meta_leads
     WHERE id::text = $1 OR meta_lead_id = $1`,
    [leadId]
  );

  if (leadResult.rows.length === 0) {
    return {
      found: false,
      error: 'Lead not found',
      searchedId: leadId,
    };
  }

  const lead = leadResult.rows[0];

  // Get sync history
  const historyResult = await query(
    `SELECT
      sync_status,
      external_id,
      error_message,
      duration_ms,
      retry_count,
      created_at
    FROM lead_sync_log
    WHERE lead_id = $1
    ORDER BY created_at DESC
    LIMIT 10`,
    [lead.id]
  );

  return {
    found: true,
    lead: {
      id: lead.id,
      metaLeadId: lead.meta_lead_id,
      metaFormId: lead.meta_form_id,
      metaPageId: lead.meta_page_id,
      metaAdId: lead.meta_ad_id,
      metaCampaignId: lead.meta_campaign_id,
      email: lead.email,
      phone: lead.phone,
      fullName: lead.full_name,
      firstName: lead.first_name,
      lastName: lead.last_name,
      company: lead.company,
      jobTitle: lead.job_title,
      formData: lead.form_data,
      processed: lead.processed,
      syncAttempts: lead.sync_attempts,
      lastSyncAttempt: lead.last_sync_attempt,
      lastSyncError: lead.last_sync_error,
      zohoLeadId: lead.zoho_lead_id,
      zohoSyncTime: lead.zoho_sync_time,
      createdTime: lead.created_time,
      fetchedAt: lead.fetched_at,
      updatedAt: lead.updated_at,
    },
    syncHistory: historyResult.rows.map(row => ({
      status: row.sync_status,
      zohoId: row.external_id,
      error: row.error_message,
      durationMs: row.duration_ms,
      retryCount: row.retry_count,
      timestamp: row.created_at,
    })),
  };
}

/**
 * Get current field mappings configuration
 */
async function getFieldMappings(targetSystem = 'zoho') {
  const result = await query(
    `SELECT
      id,
      mapping_name,
      source_field,
      target_field,
      transform_type,
      transform_config,
      required,
      default_value,
      is_active,
      priority
    FROM field_mappings
    WHERE source_system = 'meta'
      AND target_system = $1
    ORDER BY priority, mapping_name`,
    [targetSystem]
  );

  return {
    targetSystem,
    mappings: result.rows.map(row => ({
      id: row.id,
      name: row.mapping_name,
      source: row.source_field,
      target: row.target_field,
      transformType: row.transform_type,
      transformConfig: row.transform_config,
      required: row.required,
      defaultValue: row.default_value,
      active: row.is_active,
      priority: row.priority,
    })),
    count: result.rows.length,
  };
}

// ============================================================================
// MCP Server Setup
// ============================================================================

const server = new Server(
  {
    name: 'leadchain-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define available tools
const tools = [
  {
    name: 'get_unprocessed_leads',
    description: `List leads from Meta Lead Ads that are pending sync to Zoho CRM.

Returns leads where processed=FALSE and sync_attempts < max_retries.
Use this to see the backlog of leads waiting to be synced.

Example response includes: id, email, phone, name, company, syncAttempts, lastError.`,
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum number of leads to return (default: 50, max: 200)',
          minimum: 1,
          maximum: 200,
          default: 50,
        },
      },
    },
  },
  {
    name: 'sync_lead_to_zoho',
    description: `Sync a specific lead to Zoho CRM.

Takes a lead ID (UUID) and:
1. Fetches lead data from Postgres
2. Applies field mappings (Meta → Zoho)
3. Creates/updates lead in Zoho CRM via API
4. Updates database with result
5. Logs the sync attempt

Returns success status, Zoho lead ID if successful, or error details if failed.`,
    inputSchema: {
      type: 'object',
      properties: {
        lead_id: {
          type: 'string',
          description: 'UUID of the lead to sync (from get_unprocessed_leads)',
        },
      },
      required: ['lead_id'],
    },
  },
  {
    name: 'get_sync_status',
    description: `Get comprehensive pipeline health and statistics.

Returns:
- Summary: total/synced/pending/failed/abandoned lead counts
- Success rate percentage
- Sync attempt statistics (counts, avg/max duration)
- Recent errors (last 10 failed syncs with error messages)
- Hourly throughput breakdown
- Actionable recommendations based on current state

Use this for daily health checks and before doing bulk operations.`,
    inputSchema: {
      type: 'object',
      properties: {
        hours: {
          type: 'integer',
          description: 'Number of hours to look back (default: 24, max: 168)',
          minimum: 1,
          maximum: 168,
          default: 24,
        },
      },
    },
  },
  {
    name: 'retry_failed_syncs',
    description: `Bulk retry leads that have failed sync attempts.

Finds leads where:
- processed = FALSE
- sync_attempts > 0 (has been attempted)
- sync_attempts < max_attempts (not abandoned)

Retries each lead with rate limiting (200ms delay between calls).
Returns detailed results for each retry attempt.

IMPORTANT: Call get_sync_status first to understand failure patterns before bulk retry.`,
    inputSchema: {
      type: 'object',
      properties: {
        max_attempts: {
          type: 'integer',
          description: 'Only retry leads with fewer than this many attempts (default: 3, max: 5)',
          minimum: 1,
          maximum: 5,
          default: 3,
        },
      },
    },
  },
  {
    name: 'get_lead_details',
    description: `Get detailed information about a specific lead.

Accepts either:
- UUID (internal database ID)
- Meta Lead ID (from Facebook/Instagram)

Returns complete lead data including:
- All contact fields
- Meta ad tracking info (form, page, ad, campaign IDs)
- Processing status
- Zoho sync status
- Full sync history (last 10 attempts)

Use this to debug specific leads or verify sync success.`,
    inputSchema: {
      type: 'object',
      properties: {
        lead_id: {
          type: 'string',
          description: 'Lead ID (UUID or Meta Lead ID)',
        },
      },
      required: ['lead_id'],
    },
  },
  {
    name: 'get_field_mappings',
    description: `View current field mapping configuration.

Shows how Meta Lead Ads fields map to target system fields.
Useful for understanding the data transformation pipeline
and debugging field mapping issues.`,
    inputSchema: {
      type: 'object',
      properties: {
        target_system: {
          type: 'string',
          description: 'Target system to get mappings for (default: zoho)',
          enum: ['zoho', 'notion', 'hubspot'],
          default: 'zoho',
        },
      },
    },
  },
];

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case 'get_unprocessed_leads':
        result = await getUnprocessedLeads(args?.limit);
        break;

      case 'sync_lead_to_zoho':
        if (!args?.lead_id) {
          throw new Error('lead_id is required');
        }
        result = await syncLeadToZoho(args.lead_id);
        break;

      case 'get_sync_status':
        result = await getSyncStatus(args?.hours);
        break;

      case 'retry_failed_syncs':
        result = await retryFailedSyncs(args?.max_attempts);
        break;

      case 'get_lead_details':
        if (!args?.lead_id) {
          throw new Error('lead_id is required');
        }
        result = await getLeadDetails(args.lead_id);
        break;

      case 'get_field_mappings':
        result = await getFieldMappings(args?.target_system);
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: true,
            message: error.message,
            tool: name,
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// ============================================================================
// Server Startup
// ============================================================================

async function main() {
  // Verify database connection
  try {
    await pool.query('SELECT 1');
    console.error('Database connection verified');
  } catch (err) {
    console.error('Failed to connect to database:', err.message);
    console.error('Continuing anyway - tools will fail if DB unavailable');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('LeadChain MCP server started');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.error('Shutting down...');
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('Shutting down...');
  await pool.end();
  process.exit(0);
});
