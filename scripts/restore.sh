#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# restore.sh – Restore Beba SACCO PostgreSQL Backup from MinIO/S3 (Phase 4)
#
# Usage:
#   ./scripts/restore.sh <s3-key>              # e.g., daily/2025-01-15/beba_...sql.gz
#   ./scripts/restore.sh <s3-key> --dry-run    # validate without restoring
#
# WARNING: This will DROP and recreate the target database.
#          Always restore to a staging environment first.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

S3_KEY="${1:?Usage: ./scripts/restore.sh <s3-key> [--dry-run]}"
DRY_RUN=false
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=true

: "${DATABASE_URL:?DATABASE_URL must be set}"
: "${MINIO_ENDPOINT:?MINIO_ENDPOINT must be set}"
: "${MINIO_BUCKET:?MINIO_BUCKET must be set}"
: "${MINIO_ACCESS_KEY:?MINIO_ACCESS_KEY must be set}"
: "${MINIO_SECRET_KEY:?MINIO_SECRET_KEY must be set}"

LOCAL_FILE="/tmp/beba_restore_$(date -u +%s).sql.gz"

echo "[$(date -u)] Restore from: s3://${MINIO_BUCKET}/${S3_KEY}"
echo "[$(date -u)] Target DB:    ${DATABASE_URL//:*@/:***@}"  # Redact password in logs

# ── Download ──────────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY RUN] Would download: s3://${MINIO_BUCKET}/${S3_KEY} → ${LOCAL_FILE}"
else
  mc alias set bebabackup \
    "${MINIO_ENDPOINT}" "${MINIO_ACCESS_KEY}" "${MINIO_SECRET_KEY}" \
    --api S3v4 --quiet

  mc cp "bebabackup/${MINIO_BUCKET}/${S3_KEY}" "${LOCAL_FILE}" --quiet
  echo "[$(date -u)] Downloaded: $(du -sh "${LOCAL_FILE}" | cut -f1)"
fi

# ── Validate dump integrity ───────────────────────────────────────────────────
if [[ "$DRY_RUN" == "false" ]]; then
  echo "[$(date -u)] Validating gzip integrity..."
  gzip --test "${LOCAL_FILE}"
  echo "[$(date -u)] Integrity check passed."
fi

# ── Safety prompt (non-CI) ────────────────────────────────────────────────────
if [[ "${CI:-false}" != "true" && "$DRY_RUN" == "false" ]]; then
  read -rp "⚠️  This will overwrite the target database. Type 'yes' to continue: " CONFIRM
  [[ "$CONFIRM" != "yes" ]] && { echo "Aborted."; exit 1; }
fi

# ── Restore ───────────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY RUN] Would restore: ${LOCAL_FILE} → ${DATABASE_URL//:*@/:***@}"
else
  echo "[$(date -u)] Restoring..."
  gunzip -c "${LOCAL_FILE}" | psql "${DATABASE_URL}" --quiet
  echo "[$(date -u)] Restore complete."
  rm -f "${LOCAL_FILE}"
fi
