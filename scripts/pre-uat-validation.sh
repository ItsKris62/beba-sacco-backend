#!/usr/bin/env bash
# Pre-UAT validation for Beba SACCO staging/prod-like environments.
#
# Usage:
#   API_BASE=https://... MEMBER_TOKEN=... ADMIN_TOKEN=... \
#     ./scripts/pre-uat-validation.sh --environment staging --tenant <tenant-uuid>

set -euo pipefail

ENVIRONMENT="staging"
TENANT_ID="${TENANT_ID:-test-tenant-uuid}"
API_BASE="${API_BASE:-https://beba-sacco-api-staging.onrender.com/api}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --environment)
      ENVIRONMENT="$2"
      shift 2
      ;;
    --tenant)
      TENANT_ID="$2"
      shift 2
      ;;
    --api-base)
      API_BASE="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_cmd curl
require_cmd jq

echo "Starting Pre-UAT validation"
echo "Environment: $ENVIRONMENT"
echo "Tenant: $TENANT_ID"
echo "API: $API_BASE"

echo "Checking service health..."
HEALTH_JSON="$(curl -sf "$API_BASE/health")"
echo "$HEALTH_JSON" | jq -e '.status == "ok" or .status == "up"' >/dev/null

echo "Checking feature flag exposure..."
echo "$HEALTH_JSON" | jq '.checks.featureFlags // .details.featureFlags // "not exposed"'

if [[ "${FEATURE_SECURE_UPLOAD_V2:-false}" == "true" ]]; then
  if [[ -z "${MEMBER_TOKEN:-}" ]]; then
    echo "Skipping secure upload smoke: MEMBER_TOKEN is not set"
  else
    echo "Testing secure upload URL contract..."
    RESPONSE="$(
      curl -sf -X POST "$API_BASE/members/documents/upload-url" \
        -H "Authorization: Bearer $MEMBER_TOKEN" \
        -H "X-Tenant-ID: $TENANT_ID" \
        -H "X-Correlation-ID: pre-uat-secure-upload" \
        -H "Content-Type: application/json" \
        -d '{"type":"NATIONAL_ID_FRONT","mimeType":"image/jpeg","sizeBytes":100,"originalFileName":"pre-uat.jpg","checksum":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
    )"
    echo "$RESPONSE" | jq -e '.expiresIn == 900 and (.uploadToken | test("^[a-f0-9]{64}$"))' >/dev/null
  fi
fi

if [[ "${FEATURE_RLS_ENFORCEMENT:-false}" == "true" ]]; then
  if [[ -z "${MEMBER_TOKEN:-}" ]]; then
    echo "Skipping RLS smoke: MEMBER_TOKEN is not set"
  else
    echo "Testing tenant isolation response shape..."
    RESPONSE="$(
      curl -sf -X GET "$API_BASE/members/documents" \
        -H "Authorization: Bearer $MEMBER_TOKEN" \
        -H "X-Tenant-ID: $TENANT_ID" \
        -H "X-Correlation-ID: pre-uat-rls"
    )"
    echo "$RESPONSE" | jq -e 'type == "array" or (.data | type == "array")' >/dev/null
  fi
fi

echo "Testing audit immutability trigger when DATABASE_URL is available..."
if command -v psql >/dev/null 2>&1 && [[ -n "${DATABASE_URL:-}" ]]; then
  RESULT="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -c 'UPDATE "AuditLog" SET "metadata" = '"'"'{}'"'"' WHERE false;' 2>&1 || true)"
  if echo "$RESULT" | grep -q "AUDIT_IMMUTABLE"; then
    echo "Audit immutability enforced"
  else
    echo "Audit immutability trigger not observed. Review migration state before UAT."
  fi
else
  echo "Skipping DB immutability check: psql or DATABASE_URL unavailable"
fi

if [[ "${FEATURE_KYC_STATUS_ALIAS:-false}" == "true" ]]; then
  echo "KYC status alias flag is enabled. Validate admin VERIFIED flow with UAT test data."
fi

echo "Pre-UAT validation complete"
