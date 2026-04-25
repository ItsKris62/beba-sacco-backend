#!/usr/bin/env bash
# =============================================================================
# run-smoke-test.sh
# Beba SACCO — Production Smoke Test Runner
#
# PURPOSE:
#   Runs the production smoke test suite against a live deployment.
#   Designed to be executed immediately after a Render deploy completes.
#
# USAGE:
#   # Run against production:
#   BASE_URL=https://beba-sacco-api.onrender.com \
#   SMOKE_ADMIN_EMAIL=admin@beba-sacco.co.ke \
#   SMOKE_ADMIN_PASSWORD=<secret> \
#   SMOKE_MEMBER_EMAIL=member@beba-sacco.co.ke \
#   SMOKE_MEMBER_PASSWORD=<secret> \
#   bash scripts/run-smoke-test.sh
#
#   # Run against local:
#   BASE_URL=http://localhost:3000 bash scripts/run-smoke-test.sh
#
#   # Run as Render post-deploy hook (add to render.yaml):
#   bash scripts/run-smoke-test.sh
#
# EXIT CODES:
#   0 — All smoke tests passed
#   1 — One or more smoke tests failed
#
# REGULATORY CONTEXT:
#   - SASRA Circular No. 1/2021 §4.4: Post-deploy M-Pesa idempotency verification
#   - CBK Prudential Guidelines 2013 §11: Transaction integrity verification
#   - Kenya DPA 2019 §41: Tenant isolation verification
# =============================================================================

set -euo pipefail

# ─── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# ─── Configuration ─────────────────────────────────────────────────────────────
BASE_URL="${BASE_URL:-http://localhost:3000}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-30000}"
SMOKE_ADMIN_EMAIL="${SMOKE_ADMIN_EMAIL:-}"
SMOKE_ADMIN_PASSWORD="${SMOKE_ADMIN_PASSWORD:-}"
SMOKE_MEMBER_EMAIL="${SMOKE_MEMBER_EMAIL:-}"
SMOKE_MEMBER_PASSWORD="${SMOKE_MEMBER_PASSWORD:-}"
SMOKE_TENANT_A_SLUG="${SMOKE_TENANT_A_SLUG:-beba-sacco}"
SMOKE_TENANT_B_SLUG="${SMOKE_TENANT_B_SLUG:-test-sacco-b}"

# Slack webhook for smoke test result notification
SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"

# ─── Helpers ──────────────────────────────────────────────────────────────────

log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[PASS]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[FAIL]${NC} $1"
}

# Send Slack notification with smoke test result
notify_slack() {
  local status="$1"
  local message="$2"
  local emoji="$3"

  if [[ -z "$SLACK_WEBHOOK_URL" ]]; then
    return 0
  fi

  local payload
  payload=$(cat <<EOF
{
  "text": "${emoji} *Smoke Test ${status}* — Beba SACCO",
  "username": "Beba SACCO Deploy",
  "icon_emoji": ":rocket:",
  "blocks": [
    {
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": "${emoji} Smoke Test ${status}",
        "emoji": true
      }
    },
    {
      "type": "section",
      "fields": [
        {"type": "mrkdwn", "text": "*Target:*\n${BASE_URL}"},
        {"type": "mrkdwn", "text": "*Time (EAT):*\n$(date '+%Y-%m-%dT%H:%M:%S+03:00')"}
      ]
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "${message}"
      }
    }
  ]
}
EOF
)

  curl -s -X POST \
    -H 'Content-Type: application/json' \
    -d "$payload" \
    "$SLACK_WEBHOOK_URL" > /dev/null 2>&1 || true
}

# ─── Pre-flight checks ─────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   Beba SACCO — Production Smoke Test Runner                 ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
echo -e "  Target URL  : ${BOLD}${BASE_URL}${NC}"
echo -e "  Timestamp   : $(date '+%Y-%m-%dT%H:%M:%S+03:00') (EAT)"
echo -e "  Node.js     : $(node --version 2>/dev/null || echo 'not found')"
echo ""

# Verify Node.js is available
if ! command -v node &> /dev/null; then
  log_error "Node.js is not installed or not in PATH"
  exit 1
fi

# Verify we're in the backend directory
if [[ ! -f "package.json" ]]; then
  log_error "Must be run from the backend/ directory"
  log_error "Usage: cd backend && bash scripts/run-smoke-test.sh"
  exit 1
fi

# ─── Health pre-check ─────────────────────────────────────────────────────────

log_info "Running health pre-check against ${BASE_URL}/api/health/ping ..."

HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  --max-time 30 \
  "${BASE_URL}/api/health/ping" 2>/dev/null || echo "000")

if [[ "$HEALTH_STATUS" != "200" ]]; then
  log_error "Health check failed (HTTP ${HEALTH_STATUS}) — server may not be ready"
  log_warn "Waiting 30 seconds for server to warm up..."
  sleep 30

  # Retry
  HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 30 \
    "${BASE_URL}/api/health/ping" 2>/dev/null || echo "000")

  if [[ "$HEALTH_STATUS" != "200" ]]; then
    log_error "Health check still failing after retry (HTTP ${HEALTH_STATUS})"
    notify_slack "FAILED" "❌ Health check failed (HTTP ${HEALTH_STATUS}). Server may be down." "🚨"
    exit 1
  fi
fi

log_success "Health check passed (HTTP 200)"

# ─── Warn if credentials not set ──────────────────────────────────────────────

if [[ -z "$SMOKE_ADMIN_PASSWORD" ]]; then
  log_warn "SMOKE_ADMIN_PASSWORD not set — auth-dependent tests will be skipped"
fi

if [[ -z "$SMOKE_MEMBER_PASSWORD" ]]; then
  log_warn "SMOKE_MEMBER_PASSWORD not set — member-dependent tests will be skipped"
fi

# ─── Run smoke tests ──────────────────────────────────────────────────────────

log_info "Starting smoke test suite..."
echo ""

# Export all required env vars for the test process
export BASE_URL
export SMOKE_TIMEOUT
export SMOKE_ADMIN_EMAIL
export SMOKE_ADMIN_PASSWORD
export SMOKE_MEMBER_EMAIL
export SMOKE_MEMBER_PASSWORD
export SMOKE_TENANT_A_SLUG
export SMOKE_TENANT_B_SLUG

# Determine Jest binary location
JEST_BIN="./node_modules/.bin/jest"
if [[ ! -f "$JEST_BIN" ]]; then
  log_error "Jest not found at ${JEST_BIN}"
  log_error "Run: npm install"
  exit 1
fi

# Run the smoke test suite
# --testPathPattern: only run the smoke test file
# --forceExit: don't hang waiting for open handles
# --detectOpenHandles: report any open handles
# --testTimeout: 30s per test (production cold start)
# --tsconfig: use the test-specific tsconfig
set +e  # Don't exit on test failure — we want to capture the exit code

"$JEST_BIN" \
  --testPathPattern="test/production-smoke.e2e-spec" \
  --forceExit \
  --detectOpenHandles \
  --testTimeout=30000 \
  --verbose \
  --no-coverage \
  --config='{"testEnvironment":"node","transform":{"^.+\\.(t|j)s$":"ts-jest"},"moduleFileExtensions":["js","json","ts"],"rootDir":".","testRegex":"test/production-smoke\\.e2e-spec\\.ts$","globals":{"ts-jest":{"tsconfig":"tsconfig.test.json"}}}' \
  2>&1

JEST_EXIT_CODE=$?
set -e

echo ""

# ─── Report results ───────────────────────────────────────────────────────────

if [[ $JEST_EXIT_CODE -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}${BOLD}║   ✅ SMOKE TESTS PASSED — Production deployment verified     ║${NC}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  log_success "All smoke tests passed against ${BASE_URL}"
  log_success "Deployment is HEALTHY and ready for production traffic"
  echo ""

  notify_slack "PASSED ✅" \
    "All smoke tests passed. Deployment is healthy.\n*Target:* ${BASE_URL}" \
    "✅"

  exit 0
else
  echo -e "${RED}${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}${BOLD}║   ❌ SMOKE TESTS FAILED — Deployment may be unhealthy        ║${NC}"
  echo -e "${RED}${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  log_error "One or more smoke tests failed against ${BASE_URL}"
  log_error "Review the test output above and check Sentry for errors"
  log_error "Consider rolling back: see rollback-playbook.md"
  echo ""
  echo -e "  ${BOLD}Rollback command:${NC}"
  echo -e "  git checkout v1.0.0-mvp && git push origin HEAD:main --force"
  echo ""

  notify_slack "FAILED ❌" \
    "One or more smoke tests failed. Consider rolling back.\n*Target:* ${BASE_URL}\n*Rollback:* See rollback-playbook.md" \
    "🚨"

  exit 1
fi

# ✅ File complete — ready for review
