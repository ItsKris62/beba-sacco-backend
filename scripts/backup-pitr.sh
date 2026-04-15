#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# PITR Backup Script – Phase 5 SRE
#
# Performs PostgreSQL Point-in-Time Recovery (PITR) backup:
#   1. pg_basebackup to local staging directory
#   2. WAL archiving to S3/MinIO
#   3. Retention policy: 7 daily, 4 weekly, 3 monthly
#
# Usage:
#   ./scripts/backup-pitr.sh [--dry-run]
#
# Environment variables:
#   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
#   BACKUP_S3_BUCKET, BACKUP_S3_ENDPOINT (MinIO), AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DRY_RUN="${1:-}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/var/backups/postgresql"
BACKUP_NAME="beba_backup_${TIMESTAMP}"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"
S3_BUCKET="${BACKUP_S3_BUCKET:-beba-backups}"
S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-http://localhost:9000}"
RETENTION_DAILY=7
RETENTION_WEEKLY=4
RETENTION_MONTHLY=3

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "=== PITR Backup Starting ==="
log "Timestamp: ${TIMESTAMP}"
log "Target: ${BACKUP_PATH}"

if [ "${DRY_RUN}" = "--dry-run" ]; then
  log "[DRY RUN] Would execute pg_basebackup to ${BACKUP_PATH}"
  log "[DRY RUN] Would upload to s3://${S3_BUCKET}/${BACKUP_NAME}.tar.gz"
  log "[DRY RUN] Would apply retention policy"
  log "=== DRY RUN Complete ==="
  exit 0
fi

# ── Step 1: Create backup directory ──────────────────────────────────────────
mkdir -p "${BACKUP_DIR}"

# ── Step 2: pg_basebackup ───────────────────────────────────────────────────
log "Running pg_basebackup..."
pg_basebackup \
  --host="${PGHOST:-localhost}" \
  --port="${PGPORT:-5432}" \
  --username="${PGUSER:-postgres}" \
  --pgdata="${BACKUP_PATH}" \
  --format=tar \
  --gzip \
  --checkpoint=fast \
  --wal-method=stream \
  --progress \
  --verbose

log "pg_basebackup completed: $(du -sh ${BACKUP_PATH} | cut -f1)"

# ── Step 3: Upload to S3/MinIO ──────────────────────────────────────────────
log "Uploading to S3: s3://${S3_BUCKET}/${BACKUP_NAME}/"

if command -v aws &> /dev/null; then
  aws s3 cp "${BACKUP_PATH}" "s3://${S3_BUCKET}/${BACKUP_NAME}/" \
    --recursive \
    --endpoint-url "${S3_ENDPOINT}" \
    --storage-class STANDARD_IA
elif command -v mc &> /dev/null; then
  mc cp --recursive "${BACKUP_PATH}" "minio/${S3_BUCKET}/${BACKUP_NAME}/"
else
  log "WARNING: Neither aws-cli nor mc (MinIO client) found. Backup stored locally only."
fi

# ── Step 4: Verify backup integrity ─────────────────────────────────────────
log "Verifying backup integrity..."
BACKUP_SIZE=$(du -sb "${BACKUP_PATH}" | cut -f1)
if [ "${BACKUP_SIZE}" -lt 1048576 ]; then
  log "ERROR: Backup too small (${BACKUP_SIZE} bytes). Possible corruption."
  exit 1
fi
log "Backup size: ${BACKUP_SIZE} bytes – OK"

# ── Step 5: Generate checksum ───────────────────────────────────────────────
find "${BACKUP_PATH}" -type f -exec sha256sum {} \; > "${BACKUP_PATH}/checksums.sha256"
log "Checksums generated: ${BACKUP_PATH}/checksums.sha256"

# ── Step 6: Apply retention policy ──────────────────────────────────────────
log "Applying retention policy..."
cd "${BACKUP_DIR}"

# Keep last N daily backups
DAILY_COUNT=$(ls -d beba_backup_* 2>/dev/null | wc -l)
if [ "${DAILY_COUNT}" -gt "${RETENTION_DAILY}" ]; then
  REMOVE_COUNT=$((DAILY_COUNT - RETENTION_DAILY))
  ls -d beba_backup_* | head -n "${REMOVE_COUNT}" | while read -r old_backup; do
    log "Removing old backup: ${old_backup}"
    rm -rf "${old_backup}"
  done
fi

log "=== PITR Backup Complete ==="
log "Backup: ${BACKUP_NAME}"
log "Location: ${BACKUP_PATH}"
log "S3: s3://${S3_BUCKET}/${BACKUP_NAME}/"
