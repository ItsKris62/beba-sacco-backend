#!/usr/bin/env bash
# Create an on-demand Render Postgres logical export before risky deploys.
#
# Usage:
#   ./scripts/backup-render-postgres.sh <postgres-id> [--name <backup-name>]
#
# Required env:
#   RENDER_API_KEY

set -euo pipefail

DATABASE_ID="${1:?Postgres database ID required}"
shift || true

BACKUP_NAME="pre-hardening-$(date +%Y%m%d-%H%M)"
if [[ "${1:-}" == "--name" ]]; then
  BACKUP_NAME="${2:?Backup name required after --name}"
elif [[ -n "${1:-}" ]]; then
  BACKUP_NAME="$1"
fi

RENDER_API_KEY="${RENDER_API_KEY:?Set RENDER_API_KEY env var}"
API_BASE="https://api.render.com/v1/postgres/${DATABASE_ID}/export"

echo "Creating Render Postgres export"
echo "Database ID: ${DATABASE_ID}"
echo "Audit label: ${BACKUP_NAME}"

before_count="$(
  curl -fsS "${API_BASE}" \
    -H "Authorization: Bearer ${RENDER_API_KEY}" \
    -H "Accept: application/json" |
    jq 'if type == "array" then length elif .exports then (.exports | length) else 0 end'
)"

curl -fsS -X POST "${API_BASE}" \
  -H "Authorization: Bearer ${RENDER_API_KEY}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -o /tmp/render-postgres-export-response.json

echo "Export requested. Waiting for the export list to include a new completed item..."

for i in {1..30}; do
  exports_json="$(
    curl -fsS "${API_BASE}" \
      -H "Authorization: Bearer ${RENDER_API_KEY}" \
      -H "Accept: application/json"
  )"

  current_count="$(echo "${exports_json}" | jq 'if type == "array" then length elif .exports then (.exports | length) else 0 end')"
  latest="$(
    echo "${exports_json}" |
      jq -c 'if type == "array" then .[0] elif .exports then .exports[0] else . end'
  )"
  download_url="$(
    echo "${latest}" |
      jq -r '.downloadURL // .downloadUrl // .url // .signedUrl // empty'
  )"
  status="$(echo "${latest}" | jq -r '.status // .state // empty')"

  if [[ "${current_count}" -gt "${before_count}" && -n "${download_url}" ]]; then
    echo "Export completed"
    echo "Backup label: ${BACKUP_NAME}"
    echo "Download URL: ${download_url}"
    echo "Export metadata: ${latest}"
    exit 0
  fi

  if [[ "${status}" == "failed" || "${status}" == "canceled" ]]; then
    echo "Export failed with status: ${status}" >&2
    echo "Latest export metadata: ${latest}" >&2
    exit 1
  fi

  echo "Waiting for export... (${i}/30)"
  sleep 10
done

echo "Export polling timed out. Check the Render dashboard Recovery page." >&2
exit 1
