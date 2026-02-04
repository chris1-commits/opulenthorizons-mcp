#!/usr/bin/env node

/**
 * LeadChain Webhook Handler
 *
 * Express server that:
 * - Receives Meta Lead Ads webhooks
 * - Verifies webhook signatures
 * - Fetches full lead data from Meta Graph API
 * - Stores leads in Postgres for later sync to Zoho
 */

import express from 'express';
import crypto from 'crypto';
import pg from 'pg';
import fetch from 'node-fetch';

const { Pool } = pg;

// ============================================================================
// Configuration
// ============================================================================

const config = {
  port: parseInt(process.env.PORT || '3000'),
  host: process.env.HOST || '0.0.0.0',

  database: {
    connectionString: process.env.DATABASE_URL ||
      'postgresql://leadchain_user:password@localhost:5432/leadchain_db',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  },

  meta: {
    appSecret: process.env.META_APP_SECRET,
    accessToken: process.env.META_ACCESS_TOKEN,
    verifyToken: process.env.META_VERIFY_TOKEN || 'leadchain_verify_token',
    graphApiVersion: process.env.META_GRAPH_API_VERSION || 'v18.0',
    graphApiBase: 'https://graph.facebook.com',
  },

  // Request limits
  maxBodySize: '1mb',

  // Health check
  healthCheckPath: '/health',
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
// Meta Graph API
// ============================================================================

/**
 * Fetch full lead data from Meta Graph API
 */
async function fetchLeadFromMeta(leadgenId) {
  const url = `${config.meta.graphApiBase}/${config.meta.graphApiVersion}/${leadgenId}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${config.meta.accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Meta API error (${response.status}): ${error}`);
  }

  return response.json();
}

/**
 * Parse Meta lead data into our schema format
 */
function parseMetaLead(metaLead, webhookData) {
  const formData = {};
  const fieldValues = {};

  // Parse field_data array into key-value pairs
  if (metaLead.field_data) {
    for (const field of metaLead.field_data) {
      const name = field.name?.toLowerCase().replace(/\s+/g, '_');
      const value = Array.isArray(field.values) ? field.values[0] : field.values;

      if (name && value) {
        formData[name] = value;
        fieldValues[field.name] = value;
      }
    }
  }

  // Extract standard contact fields
  const email = formData.email || formData.work_email || formData.personal_email;
  const phone = formData.phone || formData.phone_number || formData.mobile_number;
  const fullName = formData.full_name || formData.name;
  const firstName = formData.first_name || formData.firstname;
  const lastName = formData.last_name || formData.lastname || formData.surname;
  const company = formData.company || formData.company_name || formData.organization;
  const jobTitle = formData.job_title || formData.title || formData.position;

  return {
    meta_lead_id: metaLead.id,
    meta_form_id: metaLead.form_id || webhookData?.form_id,
    meta_page_id: webhookData?.page_id,
    meta_ad_id: webhookData?.ad_id,
    meta_adgroup_id: webhookData?.adgroup_id,
    meta_campaign_id: webhookData?.campaign_id,
    email,
    phone,
    full_name: fullName,
    first_name: firstName,
    last_name: lastName,
    company,
    job_title: jobTitle,
    form_data: fieldValues,
    created_time: metaLead.created_time,
  };
}

// ============================================================================
// Webhook Signature Verification
// ============================================================================

/**
 * Verify Meta webhook signature
 */
function verifyWebhookSignature(payload, signature) {
  if (!config.meta.appSecret) {
    console.warn('META_APP_SECRET not set - skipping signature verification');
    return true;
  }

  if (!signature) {
    return false;
  }

  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', config.meta.appSecret)
    .update(payload, 'utf8')
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// ============================================================================
// Express App Setup
// ============================================================================

const app = express();

// Raw body parser for signature verification
app.use(express.json({
  limit: config.maxBodySize,
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// ============================================================================
// Routes
// ============================================================================

/**
 * Health check endpoint
 */
app.get(config.healthCheckPath, async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected',
    });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: err.message,
    });
  }
});

/**
 * Meta webhook verification (GET)
 * Facebook calls this to verify webhook ownership
 */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('Webhook verification request:', { mode, token: token?.substring(0, 10) + '...' });

  if (mode === 'subscribe' && token === config.meta.verifyToken) {
    console.log('Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.error('Webhook verification failed');
    res.status(403).send('Forbidden');
  }
});

/**
 * Meta webhook receiver (POST)
 * Receives leadgen events from Facebook/Instagram
 */
app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];

  // Verify signature
  if (!verifyWebhookSignature(req.rawBody, signature)) {
    console.error('Invalid webhook signature');

    // Log invalid signature event
    await logWebhookEvent('leadgen', req.body, signature, false, 'Invalid signature');

    return res.status(401).send('Invalid signature');
  }

  // Log valid webhook event
  await logWebhookEvent('leadgen', req.body, signature, true, null);

  // Respond immediately (Meta requires <20s response)
  res.status(200).send('EVENT_RECEIVED');

  // Process leads asynchronously
  try {
    await processWebhookPayload(req.body);
  } catch (err) {
    console.error('Error processing webhook:', err);
  }
});

/**
 * Log webhook event for audit
 */
async function logWebhookEvent(eventType, payload, signature, valid, error) {
  try {
    await query(
      `INSERT INTO webhook_events (event_type, source, raw_payload, signature, signature_valid, processing_error)
       VALUES ($1, 'meta', $2, $3, $4, $5)`,
      [eventType, JSON.stringify(payload), signature, valid, error]
    );
  } catch (err) {
    console.error('Failed to log webhook event:', err);
  }
}

/**
 * Process incoming webhook payload
 */
async function processWebhookPayload(payload) {
  if (payload.object !== 'page' && payload.object !== 'instagram') {
    console.log('Ignoring non-page/instagram webhook:', payload.object);
    return;
  }

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'leadgen') {
        await processLeadgenEvent(change.value, entry.id);
      }
    }
  }
}

/**
 * Process a single leadgen event
 */
async function processLeadgenEvent(leadgenData, pageId) {
  const leadgenId = leadgenData.leadgen_id;

  if (!leadgenId) {
    console.error('Missing leadgen_id in webhook data');
    return;
  }

  console.log(`Processing lead: ${leadgenId}`);

  try {
    // Check if we already have this lead
    const existing = await query(
      'SELECT id FROM meta_leads WHERE meta_lead_id = $1',
      [leadgenId]
    );

    if (existing.rows.length > 0) {
      console.log(`Lead ${leadgenId} already exists, skipping`);
      return;
    }

    // Fetch full lead data from Meta
    const metaLead = await fetchLeadFromMeta(leadgenId);

    // Parse into our format
    const leadData = parseMetaLead(metaLead, {
      ...leadgenData,
      page_id: pageId,
    });

    // Insert into database
    await query(
      `INSERT INTO meta_leads (
        meta_lead_id, meta_form_id, meta_page_id, meta_ad_id, meta_adgroup_id, meta_campaign_id,
        email, phone, full_name, first_name, last_name, company, job_title,
        form_data, created_time
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (meta_lead_id) DO NOTHING`,
      [
        leadData.meta_lead_id,
        leadData.meta_form_id,
        leadData.meta_page_id,
        leadData.meta_ad_id,
        leadData.meta_adgroup_id,
        leadData.meta_campaign_id,
        leadData.email,
        leadData.phone,
        leadData.full_name,
        leadData.first_name,
        leadData.last_name,
        leadData.company,
        leadData.job_title,
        JSON.stringify(leadData.form_data),
        leadData.created_time,
      ]
    );

    console.log(`Lead ${leadgenId} saved successfully`);

    // Record metric
    await recordMetric('leads_received', 1, { form_id: leadData.meta_form_id });

  } catch (err) {
    console.error(`Failed to process lead ${leadgenId}:`, err);
    await recordMetric('leads_failed', 1, { error: err.message.substring(0, 100) });
  }
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
    console.error('Failed to record metric:', err);
  }
}

// ============================================================================
// Error Handling
// ============================================================================

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ============================================================================
// Server Startup
// ============================================================================

async function main() {
  // Verify database connection
  try {
    await pool.query('SELECT 1');
    console.log('Database connection verified');
  } catch (err) {
    console.error('Database connection failed:', err.message);
    process.exit(1);
  }

  // Verify Meta configuration
  if (!config.meta.accessToken) {
    console.warn('WARNING: META_ACCESS_TOKEN not set - lead fetching will fail');
  }
  if (!config.meta.appSecret) {
    console.warn('WARNING: META_APP_SECRET not set - signature verification disabled');
  }

  // Start server
  app.listen(config.port, config.host, () => {
    console.log(`Webhook handler listening on ${config.host}:${config.port}`);
    console.log(`Health check: http://${config.host}:${config.port}${config.healthCheckPath}`);
    console.log(`Webhook endpoint: http://${config.host}:${config.port}/webhook`);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await pool.end();
  process.exit(0);
});
