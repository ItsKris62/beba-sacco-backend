#!/usr/bin/env bash
# =============================================================================
# render-env-verify.sh
# Beba SACCO — Production Environment Variable Verification Script
#
# PURPOSE:
#   Validates that all required environment variables are set and meet
#   minimum security/compliance requirements before a Render deployment
#   is considered healthy.
#
# USAGE:
#   # Run locally against a .env file:
#   source backend/.env && bash backend/scripts/render-env-verify.sh
#
#   # Run as Render pre-deploy check (add to render.yaml preDeployCommand):
#   bash scripts/render-env-verify.sh
#
# EXIT CODES:
#   0 — All checks passed (GO)
#   1 — One or more CRITICAL checks failed (NO-GO)
#
# REGULATORY CONTEXT:
#   - SASRA Circular No. 3/2022 §5: Security configuration verification
#   - Kenya DPA 2019 §41: Data security controls
#   - CBK Prudential Guidelines 2013: Operational risk management
# =============================================================================

set -euo pipefail

# ─── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Colour

# ─── Counters ─────────────────────────────────────────────────────────────────
PASS=0
FAIL=0
WARN=0

# ─── Helper functions ─────────────────────────────────────────────────────────

pass() {
  echo -e "  ${GREEN}✅ PASS${NC} — $1"
  PASS=$((PASS + 1))
}

fail() {
  echo -e "  ${RED}❌ FAIL${NC} — $1"
  FAIL=$((FAIL + 1))
}

warn() {
  echo -e "  ${YELLOW}⚠️  WARN${NC} — $1"
  WARN=$((WARN + 1))
}

section() {
  echo ""
  echo -e "${BOLD}${BLUE}── $1 ──────────────────────────────────────────────────${NC}"
}

# Check: variable is set and non-empty
check_required() {
  local var_name="$1"
  local description="$2"
  local value="${!var_name:-}"

  if [[ -z "$value" ]]; then
    fail "$var_name is not set — $description"
  else
    pass "$var_name is set — $description"
  fi
}

# Check: variable is set and meets minimum length
check_min_length() {
  local var_name="$1"
  local min_len="$2"
  local description="$3"
  local value="${!var_name:-}"

  if [[ -z "$value" ]]; then
    fail "$var_name is not set — $description"
  elif [[ ${#value} -lt $min_len ]]; then
    fail "$var_name is too short (${#value} chars, minimum $min_len) — $description"
  else
    pass "$var_name meets minimum length ($min_len chars) — $description"
  fi
}

# Check: variable equals expected value
check_equals() {
  local var_name="$1"
  local expected="$2"
  local description="$3"
  local value="${!var_name:-}"

  if [[ "$value" != "$expected" ]]; then
    fail "$var_name=\"$value\" (expected \"$expected\") — $description"
  else
    pass "$var_name=\"$expected\" — $description"
  fi
}

# Check: variable starts with prefix
check_starts_with() {
  local var_name="$1"
  local prefix="$2"
  local description="$3"
  local value="${!var_name:-}"

  if [[ -z "$value" ]]; then
    fail "$var_name is not set — $description"
  elif [[ "$value" != "$prefix"* ]]; then
    fail "$var_name does not start with \"$prefix\" — $description"
  else
    pass "$var_name format valid — $description"
  fi
}

# Check: variable is a valid integer >= min
check_int_min() {
  local var_name="$1"
  local min_val="$2"
  local description="$3"
  local value="${!var_name:-}"

  if [[ -z "$value" ]]; then
    fail "$var_name is not set — $description"
  elif ! [[ "$value" =~ ^[0-9]+$ ]]; then
    fail "$var_name=\"$value\" is not a valid integer — $description"
  elif [[ "$value" -lt "$min_val" ]]; then
    fail "$var_name=$value is below minimum $min_val — $description"
  else
    pass "$var_name=$value meets minimum $min_val — $description"
  fi
}

# Warn: variable is set (non-blocking)
check_recommended() {
  local var_name="$1"
  local description="$2"
  local value="${!var_name:-}"

  if [[ -z "$value" ]]; then
    warn "$var_name is not set — $description (recommended)"
  else
    pass "$var_name is set — $description"
  fi
}

# =============================================================================
# MAIN VERIFICATION
# =============================================================================

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   Beba SACCO — Production Environment Verification          ║${NC}"
echo -e "${BOLD}║   SASRA · ODPC · CBK Compliance Check                       ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
echo -e "  Timestamp (EAT): $(date -u '+%Y-%m-%dT%H:%M:%S+03:00' 2>/dev/null || date '+%Y-%m-%dT%H:%M:%S+03:00')"
echo -e "  Node.js: $(node --version 2>/dev/null || echo 'not found')"

# ─── Section 1: Application ───────────────────────────────────────────────────
section "1. Application Configuration"

check_equals "NODE_ENV" "production" "Must be production for live deployment"
check_required "PORT" "HTTP server port"
check_required "APP_URL" "Public API URL (used for M-Pesa callbacks)"
check_required "API_PREFIX" "API route prefix"
check_required "CORS_ORIGIN" "CORS allowed origin (must not be wildcard *)"

# Verify CORS is not wildcard
CORS_ORIGIN="${CORS_ORIGIN:-}"
if [[ "$CORS_ORIGIN" == "*" ]]; then
  fail "CORS_ORIGIN is wildcard '*' — security risk (ODPC DPA 2019 §41)"
fi

# ─── Section 2: Database (Neon) ───────────────────────────────────────────────
section "2. Database — Neon PostgreSQL"

check_required "DATABASE_URL" "Neon pooler connection URL"
check_required "DIRECT_URL" "Neon direct connection URL (for migrations)"

# Verify DATABASE_URL is a Neon URL
DATABASE_URL="${DATABASE_URL:-}"
if [[ -n "$DATABASE_URL" ]] && [[ "$DATABASE_URL" != *"neon.tech"* ]] && [[ "$DATABASE_URL" != *"postgresql://"* ]]; then
  warn "DATABASE_URL does not appear to be a Neon PostgreSQL URL"
fi

# Verify DIRECT_URL is different from DATABASE_URL (pooler vs direct)
DIRECT_URL="${DIRECT_URL:-}"
if [[ -n "$DATABASE_URL" ]] && [[ -n "$DIRECT_URL" ]] && [[ "$DATABASE_URL" == "$DIRECT_URL" ]]; then
  warn "DATABASE_URL and DIRECT_URL are identical — DIRECT_URL should be the non-pooler URL"
fi

# Verify DATA_RETENTION_YEARS >= 7 (SASRA Regulation 42)
check_int_min "DATA_RETENTION_YEARS" "7" "SASRA Regulation 42: minimum 7-year financial record retention"

# ─── Section 3: JWT Security ──────────────────────────────────────────────────
section "3. JWT Security (Kenya DPA 2019 §41)"

check_min_length "JWT_SECRET" "32" "JWT access token signing secret"
check_min_length "JWT_REFRESH_SECRET" "32" "JWT refresh token signing secret"
check_required "JWT_ACCESS_EXPIRATION" "Access token expiry (recommended: 15m)"
check_required "JWT_REFRESH_EXPIRATION" "Refresh token expiry (recommended: 7d)"

# Verify JWT secrets are different
JWT_SECRET="${JWT_SECRET:-}"
JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:-}"
if [[ -n "$JWT_SECRET" ]] && [[ -n "$JWT_REFRESH_SECRET" ]] && [[ "$JWT_SECRET" == "$JWT_REFRESH_SECRET" ]]; then
  fail "JWT_SECRET and JWT_REFRESH_SECRET must be different values"
fi

# Verify access token expiry is short (max 1h)
JWT_ACCESS_EXPIRATION="${JWT_ACCESS_EXPIRATION:-}"
if [[ "$JWT_ACCESS_EXPIRATION" == *"d"* ]] || [[ "$JWT_ACCESS_EXPIRATION" == *"w"* ]]; then
  warn "JWT_ACCESS_EXPIRATION=\"$JWT_ACCESS_EXPIRATION\" — access tokens should expire in minutes (e.g. 15m)"
fi

# ─── Section 4: Redis (Upstash) ───────────────────────────────────────────────
section "4. Redis — Upstash (Kenya DPA 2019 §41)"

check_required "REDIS_HOST" "Upstash Redis hostname"
check_required "REDIS_PORT" "Redis port"
check_required "REDIS_PASSWORD" "Redis authentication password"
check_equals "REDIS_TLS" "true" "Redis TLS must be enabled (Upstash requirement)"

# ─── Section 5: M-Pesa / Daraja ──────────────────────────────────────────────
section "5. M-Pesa / Safaricom Daraja (National Payment System Act 2011)"

check_required "MPESA_CONSUMER_KEY" "Daraja API consumer key"
check_required "MPESA_CONSUMER_SECRET" "Daraja API consumer secret"
check_required "MPESA_PASSKEY" "STK Push passkey"
check_required "MPESA_SHORTCODE" "Paybill/till number"
check_required "MPESA_B2C_SHORTCODE" "B2C shortcode for disbursements"
check_required "MPESA_INITIATOR_NAME" "B2C initiator name"
check_required "MPESA_SECURITY_CREDENTIAL" "RSA-encrypted initiator password (base64)"
check_equals "MPESA_ENVIRONMENT" "production" "Must be production for live M-Pesa transactions"
check_required "MPESA_CALLBACK_URL" "STK Push callback URL"
check_required "MPESA_B2C_RESULT_URL" "B2C result URL"
check_required "MPESA_B2C_QUEUE_TIMEOUT_URL" "B2C queue timeout URL"
check_min_length "MPESA_WEBHOOK_SECRET" "32" "HMAC secret for callback signature validation"

# Verify callback URLs use HTTPS
MPESA_CALLBACK_URL="${MPESA_CALLBACK_URL:-}"
if [[ -n "$MPESA_CALLBACK_URL" ]] && [[ "$MPESA_CALLBACK_URL" != "https://"* ]]; then
  fail "MPESA_CALLBACK_URL must use HTTPS (Safaricom requirement)"
fi

# Verify Safaricom IP allowlist has all 8 IPs
MPESA_ALLOWED_IPS="${MPESA_ALLOWED_IPS:-}"
if [[ -z "$MPESA_ALLOWED_IPS" ]]; then
  fail "MPESA_ALLOWED_IPS is not set — M-Pesa callbacks are not IP-restricted (SASRA Circular 1/2021 §4.1)"
else
  IP_COUNT=$(echo "$MPESA_ALLOWED_IPS" | tr ',' '\n' | grep -c '[0-9]' || true)
  if [[ "$IP_COUNT" -lt 8 ]]; then
    warn "MPESA_ALLOWED_IPS has only $IP_COUNT IPs (expected 8 Safaricom production IPs)"
  else
    pass "MPESA_ALLOWED_IPS has $IP_COUNT Safaricom IPs"
  fi
fi

# ─── Section 6: Cloudflare R2 ─────────────────────────────────────────────────
section "6. Cloudflare R2 Storage"

check_required "R2_ACCOUNT_ID" "Cloudflare account ID"
check_required "R2_ACCESS_KEY_ID" "R2 access key ID"
check_required "R2_SECRET_ACCESS_KEY" "R2 secret access key"
check_required "R2_BUCKET_NAME" "R2 bucket name"
check_required "R2_PUBLIC_URL" "R2 public URL for pre-signed links"

# ─── Section 7: Sentry Monitoring ─────────────────────────────────────────────
section "7. Sentry Error Monitoring (SASRA Circular 3/2022 §5)"

check_starts_with "SENTRY_DSN" "https://" "Sentry DSN for error tracking"
check_equals "SENTRY_ENVIRONMENT" "production" "Sentry environment tag"

# ─── Section 8: Email (Plunk) ─────────────────────────────────────────────────
section "8. Email — Plunk"

check_required "PLUNK_API_KEY" "Plunk API key for transactional email"
check_required "PLUNK_FROM_EMAIL" "Sender email address"
check_required "PLUNK_FROM_NAME" "Sender display name"

# ─── Section 9: Compliance & Monitoring ───────────────────────────────────────
section "9. Compliance & Monitoring"

check_recommended "SLACK_WEBHOOK_URL" "Slack webhook for DLQ/compliance alerts"
check_recommended "TINYBIRD_TOKEN" "Tinybird analytics token"

# BullMQ concurrency settings
check_int_min "BULLMQ_CONCURRENCY_ACCRUAL" "1" "Interest accrual queue concurrency"
check_int_min "BULLMQ_CONCURRENCY_RECON" "1" "Reconciliation queue concurrency"
check_int_min "BULLMQ_CONCURRENCY_LEDGER" "1" "Ledger queue concurrency"
check_int_min "BULLMQ_CONCURRENCY_WEBHOOK" "1" "Webhook delivery queue concurrency"

# STK rate limit
check_int_min "MPESA_STK_RATE_LIMIT_PER_DAY" "1" "M-Pesa STK push rate limit per member per day"

# =============================================================================
# SUMMARY
# =============================================================================

TOTAL=$((PASS + FAIL + WARN))

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   VERIFICATION SUMMARY                                       ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
echo -e "  Total checks : $TOTAL"
echo -e "  ${GREEN}✅ Pass${NC}        : $PASS"
echo -e "  ${YELLOW}⚠️  Warn${NC}        : $WARN"
echo -e "  ${RED}❌ Fail${NC}        : $FAIL"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo -e "${RED}${BOLD}  🚫 NO-GO — $FAIL critical check(s) failed.${NC}"
  echo -e "  Fix all ❌ FAIL items before deploying to production."
  echo -e "  Regulatory risk: SASRA/CBK/ODPC non-compliance if deployed with failures."
  echo ""
  exit 1
elif [[ $WARN -gt 0 ]]; then
  echo -e "${YELLOW}${BOLD}  ⚠️  CONDITIONAL GO — $WARN warning(s) present.${NC}"
  echo -e "  Deployment can proceed but warnings should be resolved within 24h."
  echo ""
  exit 0
else
  echo -e "${GREEN}${BOLD}  🚀 GO — All $TOTAL checks passed. Ready for production deployment.${NC}"
  echo ""
  exit 0
fi

# ✅ File complete — ready for review
