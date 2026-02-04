# LeadChain MCP Server

A Model Context Protocol (MCP) server that automates the Meta Lead Ads → Postgres → Zoho CRM pipeline, with full Claude integration.

## Overview

LeadChain enables Claude to:
- Inspect Meta leads stored in your Postgres database
- Trigger or retry syncs to Zoho CRM
- Report pipeline health, errors, and throughput
- Orchestrate lead management workflows

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│ Meta Lead Ads   │────▶│ Webhook Handler  │────▶│  Postgres   │
│ (Facebook/IG)   │     │ (webhook-handler)│     │  Database   │
└─────────────────┘     └──────────────────┘     └──────┬──────┘
                                                        │
                        ┌──────────────────┐            │
                        │   Sync Worker    │◀───────────┘
                        │ (sync-worker.js) │
                        └────────┬─────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │    Zoho CRM     │
                        │  (Leads Module) │
                        └─────────────────┘

                        ┌──────────────────┐
     Claude ◀──────────▶│   MCP Server     │◀──────── Postgres
                        │ (leadchain-mcp)  │
                        └──────────────────┘
```

## Components

| File | Description |
|------|-------------|
| `leadchain-mcp-server.js` | MCP server exposing tools to Claude |
| `webhook-handler.js` | Express server receiving Meta webhooks |
| `sync-worker.js` | Background worker syncing leads to Zoho |
| `schema.sql` | Postgres database schema |
| `docker-compose.yml` | Container orchestration |
| `deploy.sh` | Automated deployment script |

## Quick Start

### 1. Clone and Configure

```bash
git clone https://github.com/chris1-commits/opulenthorizons-mcp.git
cd opulenthorizons-mcp
cp .env.example .env
# Edit .env with your credentials
```

### 2. Deploy

```bash
./deploy.sh
```

Or manually:

```bash
npm install
docker compose up -d
```

### 3. Configure Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "leadchain-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/leadchain-mcp-server.js"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@localhost:5432/leadchain_db",
        "ZOHO_CLIENT_ID": "your_client_id",
        "ZOHO_CLIENT_SECRET": "your_client_secret",
        "ZOHO_REFRESH_TOKEN": "your_refresh_token"
      }
    }
  }
}
```

Config file locations:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

## MCP Tools

### `get_unprocessed_leads`

List leads pending sync to Zoho.

```
Parameters:
  limit (integer): Max leads to return (default: 50, max: 200)

Returns: Lead list with email, phone, name, company, sync attempts
```

### `sync_lead_to_zoho`

Sync a specific lead to Zoho CRM.

```
Parameters:
  lead_id (string, required): UUID of the lead

Returns: Success status, Zoho lead ID, or error details
```

### `get_sync_status`

Get pipeline health and statistics.

```
Parameters:
  hours (integer): Lookback period (default: 24, max: 168)

Returns: Summary stats, success rate, recent errors, recommendations
```

### `retry_failed_syncs`

Bulk retry failed sync attempts.

```
Parameters:
  max_attempts (integer): Only retry leads with fewer attempts (default: 3)

Returns: Retry results for each lead
```

### `get_lead_details`

Get detailed information about a specific lead.

```
Parameters:
  lead_id (string, required): UUID or Meta Lead ID

Returns: Full lead data, processing status, sync history
```

### `get_field_mappings`

View field mapping configuration.

```
Parameters:
  target_system (string): Target system (default: zoho)

Returns: List of field mappings with transformations
```

## Database Schema

### Tables

- **meta_leads**: Core lead data from Meta Lead Ads
- **lead_sync_log**: Audit log of all sync attempts
- **field_mappings**: Configurable Meta → Zoho field mappings
- **webhook_events**: Raw webhook payloads for debugging
- **system_metrics**: Pipeline health metrics

### Key Fields in `meta_leads`

| Field | Description |
|-------|-------------|
| `processed` | FALSE = pending sync, TRUE = synced |
| `sync_attempts` | Number of failed sync attempts |
| `zoho_lead_id` | Zoho CRM lead ID (after successful sync) |
| `form_data` | JSONB of all form fields |

## Example Prompts for Claude

### Daily Health Check

> "Use get_sync_status for the last 24 hours. Summarize total leads, success rate, any errors, and recommend actions."

### Review Pending Leads

> "Call get_unprocessed_leads with limit 50. Show leads with email addresses, then sync them to Zoho one by one."

### Handle Failures

> "Run get_sync_status for 6 hours, show failed leads with errors, then call retry_failed_syncs with max_attempts 5."

### Debug Specific Lead

> "Get details for Meta lead ID 123456789. Check if it's in the database, whether it's processed, and sync it if not."

## Configuration

### Environment Variables

See `.env.example` for all options. Required:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Postgres connection string |
| `META_APP_SECRET` | For webhook signature verification |
| `META_ACCESS_TOKEN` | For fetching lead data from Graph API |
| `ZOHO_CLIENT_ID` | Zoho OAuth client ID |
| `ZOHO_CLIENT_SECRET` | Zoho OAuth client secret |
| `ZOHO_REFRESH_TOKEN` | Zoho OAuth refresh token |

### Meta Lead Ads Setup

1. Create a Facebook App at [developers.facebook.com](https://developers.facebook.com)
2. Add the Webhooks product
3. Subscribe to `leadgen` events on your Page
4. Set webhook URL to `https://your-domain.com/webhook`
5. Use your `META_VERIFY_TOKEN` for verification
6. Generate a Page Access Token with `leads_retrieval` permission

### Zoho CRM Setup

1. Create a client at [api-console.zoho.com](https://api-console.zoho.com)
2. Select "Self Client" type
3. Generate tokens with scope: `ZohoCRM.modules.leads.ALL`
4. Save the refresh token (it doesn't expire)

## Docker Commands

```bash
# Start all services
docker compose up -d

# View logs
docker compose logs -f

# Stop services
docker compose down

# Rebuild images
docker compose build --no-cache

# Access MCP server container
docker exec -it leadchain-mcp node leadchain-mcp-server.js
```

## npm Scripts

```bash
npm start              # Run MCP server
npm run start:webhook  # Run webhook handler
npm run start:worker   # Run sync worker (continuous)
npm run start:worker:once  # Run sync worker (single batch)
npm run start:worker:dry   # Dry run (no Zoho API calls)
npm run db:init        # Initialize database schema
npm run docker:up      # Start Docker services
npm run docker:logs    # View Docker logs
```

## Troubleshooting

### Leads not syncing

1. Check sync worker logs: `docker compose logs sync-worker`
2. Verify Zoho credentials: Run `npm run start:worker:dry`
3. Check `lead_sync_log` table for errors
4. Use Claude: "Run get_sync_status and explain any errors"

### Webhook not receiving leads

1. Verify webhook URL is publicly accessible
2. Check signature verification: Is `META_APP_SECRET` correct?
3. Check webhook logs: `docker compose logs webhook-server`
4. Verify Meta webhook subscription in App Dashboard

### Database connection issues

1. Check `DATABASE_URL` format
2. Verify Postgres is running: `docker compose ps`
3. Test connection: `psql $DATABASE_URL -c "SELECT 1"`

## License

MIT
