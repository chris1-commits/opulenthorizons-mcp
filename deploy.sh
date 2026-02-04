#!/bin/bash

# LeadChain MCP Deployment Script
# Sets up the environment, initializes database, and starts services

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# ============================================================================
# Check Prerequisites
# ============================================================================

check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check Node.js
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed. Please install Node.js 18+."
        exit 1
    fi

    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        log_error "Node.js version 18+ required. Found: $(node -v)"
        exit 1
    fi
    log_info "Node.js $(node -v) found"

    # Check npm
    if ! command -v npm &> /dev/null; then
        log_error "npm is not installed."
        exit 1
    fi
    log_info "npm $(npm -v) found"

    # Check for Docker (optional)
    if command -v docker &> /dev/null; then
        log_info "Docker found (optional)"
        DOCKER_AVAILABLE=true
    else
        log_warn "Docker not found - will use local services"
        DOCKER_AVAILABLE=false
    fi

    # Check for psql (optional)
    if command -v psql &> /dev/null; then
        log_info "psql client found"
        PSQL_AVAILABLE=true
    else
        log_warn "psql client not found - manual DB setup may be needed"
        PSQL_AVAILABLE=false
    fi
}

# ============================================================================
# Environment Setup
# ============================================================================

setup_environment() {
    log_info "Setting up environment..."

    # Check for .env file
    if [ ! -f .env ]; then
        if [ -f .env.example ]; then
            log_warn ".env file not found. Copying from .env.example"
            cp .env.example .env
            log_warn "Please edit .env with your actual credentials before continuing."
            log_warn "Required: META_APP_SECRET, META_ACCESS_TOKEN, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN"
            exit 1
        else
            log_error ".env file not found and no .env.example available"
            exit 1
        fi
    fi

    # Load environment variables
    set -a
    source .env
    set +a

    log_info "Environment loaded"
}

# ============================================================================
# Install Dependencies
# ============================================================================

install_dependencies() {
    log_info "Installing Node.js dependencies..."
    npm ci
    log_info "Dependencies installed"
}

# ============================================================================
# Database Setup
# ============================================================================

setup_database() {
    log_info "Setting up database..."

    if [ "$DOCKER_AVAILABLE" = true ] && [ "${USE_DOCKER:-true}" = "true" ]; then
        log_info "Starting PostgreSQL container..."
        docker compose up -d postgres

        # Wait for PostgreSQL to be ready
        log_info "Waiting for PostgreSQL to be ready..."
        for i in {1..30}; do
            if docker compose exec -T postgres pg_isready -U "${POSTGRES_USER:-leadchain_user}" &> /dev/null; then
                log_info "PostgreSQL is ready"
                break
            fi
            if [ $i -eq 30 ]; then
                log_error "PostgreSQL failed to start within 30 seconds"
                exit 1
            fi
            sleep 1
        done

        # Schema is auto-loaded by Docker entrypoint
        log_info "Database schema initialized via Docker entrypoint"
    elif [ "$PSQL_AVAILABLE" = true ]; then
        log_info "Initializing database schema with psql..."
        psql "$DATABASE_URL" -f schema.sql
        log_info "Database schema initialized"
    else
        log_warn "Cannot automatically initialize database."
        log_warn "Please run: psql \$DATABASE_URL -f schema.sql"
    fi
}

# ============================================================================
# Test API Connections
# ============================================================================

test_meta_api() {
    log_info "Testing Meta Graph API connection..."

    if [ -z "$META_ACCESS_TOKEN" ]; then
        log_warn "META_ACCESS_TOKEN not set - skipping Meta API test"
        return
    fi

    # Test with a simple API call
    RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
        "https://graph.facebook.com/v18.0/me?access_token=${META_ACCESS_TOKEN}")

    if [ "$RESPONSE" = "200" ]; then
        log_info "Meta Graph API connection successful"
    else
        log_warn "Meta Graph API test returned status $RESPONSE"
        log_warn "Check your META_ACCESS_TOKEN"
    fi
}

test_zoho_api() {
    log_info "Testing Zoho API connection..."

    if [ -z "$ZOHO_CLIENT_ID" ] || [ -z "$ZOHO_CLIENT_SECRET" ] || [ -z "$ZOHO_REFRESH_TOKEN" ]; then
        log_warn "Zoho credentials not set - skipping Zoho API test"
        return
    fi

    # Try to get an access token
    RESPONSE=$(curl -s -X POST "${ZOHO_ACCOUNTS_DOMAIN:-https://accounts.zoho.com}/oauth/v2/token" \
        -d "refresh_token=${ZOHO_REFRESH_TOKEN}" \
        -d "client_id=${ZOHO_CLIENT_ID}" \
        -d "client_secret=${ZOHO_CLIENT_SECRET}" \
        -d "grant_type=refresh_token")

    if echo "$RESPONSE" | grep -q "access_token"; then
        log_info "Zoho API connection successful"
    else
        log_warn "Zoho API test failed"
        log_warn "Response: $RESPONSE"
        log_warn "Check your Zoho credentials"
    fi
}

# ============================================================================
# Start Services
# ============================================================================

start_services() {
    log_info "Starting services..."

    if [ "$DOCKER_AVAILABLE" = true ] && [ "${USE_DOCKER:-true}" = "true" ]; then
        log_info "Starting all services with Docker Compose..."
        docker compose up -d

        log_info "Services started. Checking health..."
        sleep 5
        docker compose ps

        log_info ""
        log_info "Service URLs:"
        log_info "  Webhook: http://localhost:${WEBHOOK_PORT:-3000}/webhook"
        log_info "  Health:  http://localhost:${WEBHOOK_PORT:-3000}/health"
        log_info ""
        log_info "View logs: docker compose logs -f"
    else
        log_info "Starting services locally..."

        # Start webhook server in background
        log_info "Starting webhook server..."
        nohup npm run start:webhook > webhook.log 2>&1 &
        echo $! > webhook.pid

        # Start sync worker in background
        log_info "Starting sync worker..."
        nohup npm run start:worker > sync-worker.log 2>&1 &
        echo $! > sync-worker.pid

        log_info "Services started locally"
        log_info "  Webhook PID: $(cat webhook.pid)"
        log_info "  Sync Worker PID: $(cat sync-worker.pid)"
        log_info ""
        log_info "View logs:"
        log_info "  tail -f webhook.log"
        log_info "  tail -f sync-worker.log"
    fi
}

# ============================================================================
# Print Claude Configuration
# ============================================================================

print_claude_config() {
    log_info ""
    log_info "============================================"
    log_info "Claude Desktop Configuration"
    log_info "============================================"
    log_info ""
    log_info "Add this to your claude_desktop_config.json:"
    log_info ""

    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    cat << EOF
{
  "mcpServers": {
    "leadchain-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["${SCRIPT_DIR}/leadchain-mcp-server.js"],
      "env": {
        "DATABASE_URL": "${DATABASE_URL}",
        "ZOHO_CLIENT_ID": "${ZOHO_CLIENT_ID}",
        "ZOHO_CLIENT_SECRET": "${ZOHO_CLIENT_SECRET}",
        "ZOHO_REFRESH_TOKEN": "${ZOHO_REFRESH_TOKEN}",
        "ZOHO_API_DOMAIN": "${ZOHO_API_DOMAIN:-https://www.zohoapis.com}",
        "ZOHO_ACCOUNTS_DOMAIN": "${ZOHO_ACCOUNTS_DOMAIN:-https://accounts.zoho.com}"
      }
    }
  }
}
EOF

    log_info ""
    log_info "Config file locations:"
    log_info "  macOS: ~/Library/Application Support/Claude/claude_desktop_config.json"
    log_info "  Windows: %APPDATA%\\Claude\\claude_desktop_config.json"
    log_info "  Linux: ~/.config/Claude/claude_desktop_config.json"
    log_info ""
}

# ============================================================================
# Main
# ============================================================================

main() {
    log_info "LeadChain MCP Deployment"
    log_info "========================"
    log_info ""

    check_prerequisites
    setup_environment
    install_dependencies
    setup_database
    test_meta_api
    test_zoho_api
    start_services
    print_claude_config

    log_info ""
    log_info "Deployment complete!"
    log_info ""
}

# Run main function
main "$@"
