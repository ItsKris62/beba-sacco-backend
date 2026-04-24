#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# backup.sh – Beba SACCO PostgreSQL Backup to MinIO/S3 (Phase 4)
#
# Usage:
#   ./scripts/backup.sh              # full dump
#   ./scripts/backup.sh --dry-run    # validate env without uploading
#
# Environment variables (set in .env or injected by secrets manager):
#   DATABASE_URL       – PostgreSQL connection string
#   MINIO_ENDPOINT     – e.g., https://minio.example.com or AWS S3 endpoint
#   MINIO_BUCKET       – target bucket (e.g., beba-backups)
#   MINIO_ACCESS_KEY   – S3/MinIO access key
#   MINIO_SECRET_KEY   – S3/MinIO secret key
#   BACKUP_RETENTION_DAYS – days to keep backups (default: 30)
#
# Outputs:
#   <bucket>/daily/YYYY-MM-DD/beba_<timestamp>.sql.gz
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# ── Validate environment ──────────────────────────────────────────────────────
: "${DATABASE_URL:?DATABASE_URL must be set}"
: "${MINIO_ENDPOINT:?MINIO_ENDPOINT must be set}"
: "${MINIO_BUCKET:?MINIO_BUCKET must be set}"
: "${MINIO_ACCESS_KEY:?MINIO_ACCESS_KEY must be set}"
: "${MINIO_SECRET_KEY:?MINIO_SECRET_KEY must be set}"

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H-%M-%SZ")
DATE=$(date -u +"%Y-%m-%d")
BACKUP_FILE="/tmp/beba_${TIMESTAMP}.sql.gz"
S3_KEY="daily/${DATE}/beba_${TIMESTAMP}.sql.gz"

echo "[$(date -u)] Starting backup: ${BACKUP_FILE}"

# ── pg_dump ───────────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY RUN] Would run: pg_dump \"${DATABASE_URL}\" | gzip > ${BACKUP_FILE}"
else
  pg_dump "${DATABASE_URL}" \
    --format=plain \
    --no-password \
    --verbose \
    2>&1 | gzip > "${BACKUP_FILE}"

  echo "[$(date -u)] Dump complete: $(du -sh "${BACKUP_FILE}" | cut -f1)"
fi

# ── Upload to MinIO/S3 via mc (MinIO Client) ──────────────────────────────────
if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY RUN] Would upload to: ${MINIO_BUCKET}/${S3_KEY}"
else
  # Configure mc alias (non-interactive)
  mc alias set bebabackup \
    "${MINIO_ENDPOINT}" \
    "${MINIO_ACCESS_KEY}" \
    "${MINIO_SECRET_KEY}" \
    --api S3v4 --quiet

  mc cp "${BACKUP_FILE}" "bebabackup/${MINIO_BUCKET}/${S3_KEY}" --quiet

  echo "[$(date -u)] Uploaded: s3://${MINIO_BUCKET}/${S3_KEY}"
fi

# ── Cleanup local temp file ───────────────────────────────────────────────────
[[ "$DRY_RUN" == "false" ]] && rm -f "${BACKUP_FILE}"

# ── Prune backups older than RETENTION_DAYS ───────────────────────────────────
if [[ "$DRY_RUN" == "false" ]]; then
  CUTOFF=$(date -u -d "${RETENTION_DAYS} days ago" +"%Y-%m-%dT%H:%M:%S" 2>/dev/null \
    || date -u -v-${RETENTION_DAYS}d +"%Y-%m-%dT%H:%M:%S")  # macOS fallback

  echo "[$(date -u)] Pruning backups older than ${RETENTION_DAYS} days (cutoff: ${CUTOFF})"
  mc rm --recursive --force --older-than "${RETENTION_DAYS}d" \
    "bebabackup/${MINIO_BUCKET}/daily/" --quiet || true
fi

echo "[$(date -u)] Backup complete."
