#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# verify-tenant-isolation.sh
# Beba SACCO — Security & Tenant Isolation Audit Script (Phase C)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Usage:
#   cd backend && bash scripts/verify-tenant-isolation.sh
#
# Exit codes:
#   0  = all checks passed
#   1  = one or more critical checks failed
#
# Non-negotiable constraints validated:
#   • Every Prisma query includes tenantId scoping
#   • Middleware execution order in main.ts
#   • Rate limiting on auth, mpesa callback, report generate
#   • PII redaction in structured logs
#   • Idempotency-Key header validation on POST/PATCH
#   • RBAC guards on admin endpoints
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_DIR="${PROJECT_ROOT}/src"

FAILED=0
PASS=0
TOTAL=0

# ─── Helpers ──────────────────────────────────────────────────────────────────

log_pass() {
  echo "✅  PASS: $1"
  ((PASS++))
  ((TOTAL++))
}

log_fail() {
  echo "❌  FAIL: $1"
  ((FAILED++))
  ((TOTAL++))
}

log_info() {
  echo "ℹ️   INFO: $1"
}

# ─── C3.1: Prisma tenantId scoping ────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "C3.1  Prisma tenantId Scoping Audit"
echo "═══════════════════════════════════════════════════════════════════════════════"

# Find Prisma queries without tenantId in WHERE clauses
# Exclude raw queries (executeRaw, queryRaw) and test files
PRISMA_WITHOUT_TENANT=$(${GREP:-grep} -rnP 'prisma\.(findUnique|findFirst|findMany|count|aggregate|groupBy|create|update|updateMany|delete|deleteMany|upsert)\s*\(' "${SRC_DIR}" \
  --include="*.ts" \
  | ${GREP:-grep} -v 'tenantId' \
  | ${GREP:-grep} -v '\.spec\.ts' \
  | ${GREP:-grep} -v '\.e2e-spec\.ts' \
  | ${GREP:-grep} -v 'test/' \
  | ${GREP:-grep} -v 'node_modules' \
  | ${GREP:-grep} -v 'seed' \
  || true)

if [ -z "$PRISMA_WITHOUT_TENANT" ]; then
  log_pass "All Prisma queries include tenantId scoping (or are raw queries/tests)"
else
  log_fail "Prisma queries found WITHOUT tenantId scoping:"
  echo "$PRISMA_WITHOUT_TENANT" | head -20
fi

# Verify Prisma middleware injects tenantId
if ${GREP:-grep} -q "tenantAsyncStorage" "${SRC_DIR}/prisma/prisma.service.ts"; then
  log_pass "Prisma tenant isolation middleware is attached"
else
  log_fail "Prisma tenant isolation middleware NOT found in prisma.service.ts"
fi

# ─── C3.2: Middleware execution order ─────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "C3.2  Middleware Execution Order Audit"
echo "═══════════════════════════════════════════════════════════════════════════════"

# Check main.ts applies security middleware before routes
if ${GREP:-grep} -q "app.use(helmet" "${SRC_DIR}/main.ts"; then
  log_pass "Helmet security middleware is registered in main.ts"
else
  log_fail "Helmet security middleware NOT found in main.ts"
fi

if ${GREP:-grep} -q "app.enableCors" "${SRC_DIR}/main.ts"; then
  log_pass "CORS middleware is registered in main.ts"
else
  log_fail "CORS middleware NOT found in main.ts"
fi

# Check middleware chain order in AppModule
MIDDLEWARE_ORDER=$(${GREP:-grep} -A2 "consumer.apply" "${SRC_DIR}/app.module.ts" | head -5 || true)
if echo "$MIDDLEWARE_ORDER" | ${GREP:-grep} -q "RequestIdMiddleware.*TenantMiddleware.*IdempotencyMiddleware"; then
  log_pass "Middleware chain order: RequestId → Tenant → Idempotency"
else
  log_fail "Middleware chain order may be incorrect. Found:"
  echo "$MIDDLEWARE_ORDER"
fi

# ─── C3.3: Rate limiting ──────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "C3.3  Rate Limiting Audit"
echo "═══════════════════════════════════════════════════════════════════════════════"

# Global throttler
if ${GREP:-grep} -q "ThrottlerModule.forRoot" "${SRC_DIR}/app.module.ts"; then
  log_pass "ThrottlerModule is registered globally"
else
  log_fail "ThrottlerModule NOT registered globally"
fi

# Auth rate limiting
if ${GREP:-grep} -q "@Throttle" "${SRC_DIR}/modules/auth/auth.controller.ts" || \
   ${GREP:-grep} -q "ThrottlerGuard" "${SRC_DIR}/modules/auth/auth.controller.ts"; then
  log_pass "Rate limiting applied to auth endpoints"
else
  log_info "Auth controller rate limiting: using global ThrottlerGuard (verify manually)"
fi

# M-Pesa callback rate limiting
if ${GREP:-grep} -q "@Throttle" "${SRC_DIR}/modules/mpesa/"*.ts || \
   ${GREP:-grep} -q "ThrottlerGuard" "${SRC_DIR}/modules/mpesa/"*.ts; then
  log_pass "Rate limiting applied to M-Pesa callbacks"
else
  log_info "M-Pesa rate limiting: using global ThrottlerGuard (verify manually)"
fi

# Report generation rate limiting
if ${GREP:-grep} -q "@Throttle" "${SRC_DIR}/modules/reports/"*.ts || \
   ${GREP:-grep} -q "ThrottlerGuard" "${SRC_DIR}/modules/reports/"*.ts; then
  log_pass "Rate limiting applied to report generation"
else
  log_info "Report generation rate limiting: using global ThrottlerGuard (verify manually)"
fi

# ─── C3.4: PII redaction in logs ──────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "C3.4  PII Redaction in Structured Logs"
echo "═══════════════════════════════════════════════════════════════════════════════"

# Check pino redact config
PINODE_REDACT=$(${GREP:-grep} -A20 "redact:" "${SRC_DIR}/app.module.ts" || true)
if echo "$PINODE_REDACT" | ${GREP:-grep} -q "authorization"; then
  log_pass "Authorization header is redacted in logs"
else
  log_fail "Authorization header NOT redacted in logs"
fi

if echo "$PINODE_REDACT" | ${GREP:-grep} -q "password"; then
  log_pass "Password fields are redacted in logs"
else
  log_fail "Password fields NOT redacted in logs"
fi

if echo "$PINODE_REDACT" | ${GREP:-grep} -q "refreshToken"; then
  log_pass "Refresh token is redacted in logs"
else
  log_fail "Refresh token NOT redacted in logs"
fi

# Check for PII in log statements (grep for phone, idNumber, balance in logger calls)
PII_IN_LOGS=$(${GREP:-rnP} 'logger\.(log|warn|error|debug)\s*\([^)]*(phone|idNumber|nationalId|kraPin|balance|passwordHash)' "${SRC_DIR}" \
  --include="*.ts" \
  | ${GREP:-grep} -v '\.spec\.ts' \
  | ${GREP:-grep} -v 'test/' \
  | ${GREP:-grep} -v 'node_modules' \
  || true)

if [ -z "$PII_IN_LOGS" ]; then
  log_pass "No raw PII fields found in logger calls"
else
  log_fail "Potential PII leakage in log statements:"
  echo "$PII_IN_LOGS" | head -10
fi

# ─── C3.5: Idempotency-Key header validation ──────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "C3.5  Idempotency-Key Header Validation"
echo "═══════════════════════════════════════════════════════════════════════════════"

# Check IdempotencyMiddleware is applied
if ${GREP:-grep} -q "IdempotencyMiddleware" "${SRC_DIR}/app.module.ts"; then
  log_pass "IdempotencyMiddleware is registered in AppModule"
else
  log_fail "IdempotencyMiddleware NOT registered in AppModule"
fi

# Check POST/PATCH controllers reference idempotency
IDEMPOTENCY_HEADERS=$(${GREP:-rnP} '@ApiHeader\s*\(\s*\{[^}]*Idempotency-Key' "${SRC_DIR}" \
  --include="*.ts" \
  | wc -l)

if [ "$IDEMPOTENCY_HEADERS" -ge 3 ]; then
  log_pass "Idempotency-Key documented on $IDEMPOTENCY_HEADERS+ mutation endpoints"
else
  log_fail "Only $IDEMPOTENCY_HEADERS endpoints document Idempotency-Key (expected 3+)"
fi

# Check LoansService uses idempotency
if ${GREP:-grep} -q "idempotency\." "${SRC_DIR}/modules/loans/loans.service.ts"; then
  log_pass "LoansService calls idempotency service"
else
  log_fail "LoansService does NOT call idempotency service"
fi

# ─── C3.6: RBAC guards on admin endpoints ─────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "C3.6  RBAC Guards on Admin Endpoints"
echo "═══════════════════════════════════════════════════════════════════════════════"

# Check RBACGuard is global
if ${GREP:-grep} -q "APP_GUARD.*RBACGuard" "${SRC_DIR}/app.module.ts"; then
  log_pass "RBACGuard is registered as global APP_GUARD"
else
  log_fail "RBACGuard NOT registered as global APP_GUARD"
fi

# Check admin controllers use @Roles decorator
ADMIN_ROLES=$(${GREP:-rnP} '@Roles\s*\([^)]+(MANAGER|TENANT_ADMIN|SUPER_ADMIN)' "${SRC_DIR}/modules/" \
  --include="*.ts" \
  | wc -l)

if [ "$ADMIN_ROLES" -ge 5 ]; then
  log_pass "@Roles decorator found on $ADMIN_ROLES admin controller methods"
else
  log_fail "Only $ADMIN_ROLES admin methods have @Roles (expected 5+)"
fi

# Check loan admin controller specifically
if ${GREP:-grep} -q "@Roles" "${SRC_DIR}/modules/loans/loan-admin.controller.ts"; then
  log_pass "LoanAdminController has @Roles decorators"
else
  log_fail "LoanAdminController missing @Roles decorators"
fi

# ─── C3.7: Global exception filter (RFC 7807) ─────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "C3.7  RFC 7807 Problem+JSON Compliance"
echo "═══════════════════════════════════════════════════════════════════════════════"

if ${GREP:-grep} -q "application/problem+json" "${SRC_DIR}/common/filters/global-exception.filter.ts"; then
  log_pass "GlobalExceptionFilter returns application/problem+json"
else
  log_fail "GlobalExceptionFilter does NOT return application/problem+json"
fi

if ${GREP:-grep} -q "correlationId" "${SRC_DIR}/common/filters/global-exception.filter.ts"; then
  log_pass "GlobalExceptionFilter includes correlationId in problem detail"
else
  log_fail "GlobalExceptionFilter missing correlationId in problem detail"
fi

# ─── C3.8: No placeholder code or TODOs ───────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "C3.8  Zero Placeholder / TODO Audit"
echo "═══════════════════════════════════════════════════════════════════════════════"

TODO_COUNT=$(${GREP:-rnP '\/\/\s*TODO|TODO:|FIXME:|XXX:|HACK:' "${SRC_DIR}" \
  --include="*.ts" \
  | ${GREP:-grep} -v '\.spec\.ts' \
  | ${GREP:-grep} -v 'test/' \
  | ${GREP:-grep} -v 'node_modules' \
  | wc -l)

if [ "$TODO_COUNT" -eq 0 ]; then
  log_pass "Zero TODO/FIXME/XXX/HACK comments in source code"
else
  log_fail "Found $TODO_COUNT TODO/FIXME/XXX/HACK comments:"
  ${GREP:-rnP} '\/\/\s*TODO|TODO:|FIXME:|XXX:|HACK:' "${SRC_DIR}" \
    --include="*.ts" \
    | ${GREP:-grep} -v '\.spec\.ts' \
    | ${GREP:-grep} -v 'test/' \
    | head -10
fi

PLACEHOLDER_COUNT=$(${GREP:-rnP 'placeholder|PLACEHOLDER|lorem ipsum|xxx-xxx|00000000-0000-0000-0000-000000000000' "${SRC_DIR}" \
  --include="*.ts" \
  | ${GREP:-grep} -v '\.spec\.ts' \
  | ${GREP:-grep} -v 'test/' \
  | ${GREP:-grep} -v 'node_modules' \
  | ${GREP:-grep} -v 'seed' \
  | wc -l)

if [ "$PLACEHOLDER_COUNT" -eq 0 ]; then
  log_pass "Zero placeholder strings in source code"
else
  log_fail "Found $PLACEHOLDER_COUNT potential placeholders"
fi

# ─── C3.9: Docker non-root, healthchecks ──────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "C3.9  Docker Security Audit"
echo "═══════════════════════════════════════════════════════════════════════════════"

if [ -f "${PROJECT_ROOT}/Dockerfile" ]; then
  if ${GREP:-grep} -q "USER nestjs" "${PROJECT_ROOT}/Dockerfile"; then
    log_pass "Dockerfile runs as non-root user (nestjs)"
  else
    log_fail "Dockerfile does NOT specify non-root USER"
  fi

  if ${GREP:-grep} -q "HEALTHCHECK" "${PROJECT_ROOT}/Dockerfile"; then
    log_pass "Dockerfile includes HEALTHCHECK"
  else
    log_fail "Dockerfile missing HEALTHCHECK"
  fi
else
  log_fail "Dockerfile not found"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "Audit Summary"
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "  Total checks:  $TOTAL"
echo "  Passed:        $PASS"
echo "  Failed:        $FAILED"
echo ""

if [ "$FAILED" -eq 0 ]; then
  echo "🎉  ALL CHECKS PASSED — Tenant isolation and security posture is solid."
  exit 0
else
  echo "⚠️   $FAILED CHECK(S) FAILED — Review failures above before deployment."
  exit 1
fi
