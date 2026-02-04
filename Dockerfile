# LeadChain MCP - Multi-stage Dockerfile
# Builds separate images for webhook, sync-worker, and mcp-server

# ============================================================================
# Base Stage
# ============================================================================
FROM node:20-alpine AS base

WORKDIR /app

# Install curl for health checks
RUN apk add --no-cache curl

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source files
COPY *.js ./
COPY schema.sql ./

# ============================================================================
# Webhook Server
# ============================================================================
FROM base AS webhook

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "webhook-handler.js"]

# ============================================================================
# Sync Worker
# ============================================================================
FROM base AS sync-worker

CMD ["node", "sync-worker.js"]

# ============================================================================
# MCP Server
# ============================================================================
FROM base AS mcp-server

# MCP uses stdio, keep container running
CMD ["node", "leadchain-mcp-server.js"]
