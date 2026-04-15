#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# PITR Restore Script – Phase 5 SRE
#
# Restores PostgreSQL from a PITR backup to a specific timestamp.
#
# Usage:
#   ./scripts/restore-pitr.sh <backup_name> [--target-time "2025-01-15 14:30:00"] [--dry-run]
#
# Examples:
#   ./scripts/restore-pitr.sh beba_backup_20250115_020000 --dry-run
#   ./scripts/restore-pitr.sh beba_backup_20250115_020000 --target-time "2025-01-15 14:30:00"
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BACKUP_NAME="${1:?Usage: restore-pitr.sh <backup_name> [--target-time <timestamp>] [--dry-run]}"
shift

TARGET_TIME=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-time) TARGET_TIME="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

BACKUP_DIR="/var/backups/postgresql"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"
RESTORE_DIR="/var/lib/postgresql/restore_${BACKUP_NAME}"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"
S3_BUCKET="${BACKUP_S3_BUCKET:-beba-backups}"
S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-http://localhost:9000}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "=== PITR Restore Starting ==="
log "Backup: ${BACKUP_NAME}"
log "Target time: ${TARGET_TIME:-latest}"
log "Dry run: ${DRY_RUN}"

# ── Step 1: Validate backup exists ──────────────────────────────────────────
if [ ! -d "${BACKUP_PATH}" ]; then
  log "Local backup not found. Attempting S3 download..."
  if [ "${DRY_RUN}" = true ]; then
    log "[DRY RUN] Would download from s3://${S3_BUCKET}/${BACKUP_NAME}/"
  else
    mkdir -p "${BACKUP_PATH}"
    if command -v aws &> /dev/null; then
      aws s3 cp "s3://${S3_BUCKET}/${BACKUP_NAME}/" "${BACKUP_PATH}/" \
        --recursive --endpoint-url "${S3_ENDPOINT}"
    elif command -v mc &> /dev/null; then
      mc cp --recursive "minio/${S3_BUCKET}/${BACKUP_NAME}/" "${BACKUP_PATH}/"
    else
      log "ERROR: Backup not found locally and no S3 client available."
      exit 1
    fi
  fi
fi

# ── Step 2: Verify checksums ────────────────────────────────────────────────
if [ -f "${BACKUP_PATH}/checksums.sha256" ]; then
  log "Verifying backup checksums..."
  if [ "${DRY_RUN}" = true ]; then
    log "[DRY RUN] Would verify checksums"
  else
    cd "${BACKUP_PATH}"
    if sha256sum -c checksums.sha256 --quiet 2>/dev/null; then
      log "Checksum verification: PASSED"
    else
      log "WARNING: Checksum verification failed. Proceed with caution."
    fi
  fi
else
  log "WARNING: No checksums.sha256 found. Skipping verification."
fi

# ── Step 3: Pre-restore validation ──────────────────────────────────────────
log "Pre-restore validation..."
BACKUP_SIZE=$(du -sb "${BACKUP_PATH}" 2>/dev/null | cut -f1 || echo "0")
log "Backup size: ${BACKUP_SIZE} bytes"

if [ "${BACKUP_SIZE}" -lt 1048576 ] && [ "${DRY_RUN}" = false ]; then
  log "ERROR: Backup too small. Aborting."
  exit 1
fi

if [ "${DRY_RUN}" = true ]; then
  log ""
  log "=== DRY RUN Summary ==="
  log "Backup: ${BACKUP_NAME} (${BACKUP_SIZE} bytes)"
  log "Would stop PostgreSQL"
  log "Would restore to: ${RESTORE_DIR}"
  if [ -n "${TARGET_TIME}" ]; then
    log "Would set recovery_target_time = '${TARGET_TIME}'"
  fi
  log "Would start PostgreSQL with recovery configuration"
  log "Would verify database connectivity"
  log "=== DRY RUN Complete ==="
  exit 0
fi

# ── Step 4: Stop PostgreSQL ─────────────────────────────────────────────────
log "Stopping PostgreSQL..."
if command -v pg_ctl &> /dev/null; then
  pg_ctl -D "${PGDATA}" stop -m fast || true
elif command -v systemctl &> /dev/null; then
  systemctl stop postgresql || true
fi

# ── Step 5: Backup current data directory ───────────────────────────────────
if [ -d "${PGDATA}" ]; then
  CURRENT_BACKUP="${PGDATA}.pre_restore_$(date +%Y%m%d_%H%M%S)"
  log "Backing up current data to: ${CURRENT_BACKUP}"
  mv "${PGDATA}" "${CURRENT_BACKUP}"
fi

# ── Step 6: Extract backup ─────────────────────────────────────────────────
log "Extracting backup to ${PGDATA}..."
mkdir -p "${PGDATA}"

# Extract base backup
if [ -f "${BACKUP_PATH}/base.tar.gz" ]; then
  tar -xzf "${BACKUP_PATH}/base.tar.gz" -C "${PGDATA}"
fi

# Extract WAL files
if [ -f "${BACKUP_PATH}/pg_wal.tar.gz" ]; then
  mkdir -p "${PGDATA}/pg_wal"
  tar -xzf "${BACKUP_PATH}/pg_wal.tar.gz" -C "${PGDATA}/pg_wal"
fi

# ── Step 7: Configure recovery ──────────────────────────────────────────────
log "Configuring recovery..."
cat > "${PGDATA}/postgresql.auto.conf" << EOF
# PITR Recovery Configuration
restore_command = 'cp /var/backups/postgresql/wal_archive/%f %p'
recovery_target_action = 'promote'
EOF

if [ -n "${TARGET_TIME}" ]; then
  echo "recovery_target_time = '${TARGET_TIME}'" >> "${PGDATA}/postgresql.auto.conf"
  log "Recovery target time: ${TARGET_TIME}"
fi

# Signal PostgreSQL to enter recovery mode
touch "${PGDATA}/recovery.signal"

# Fix permissions
chown -R postgres:postgres "${PGDATA}" 2>/dev/null || true
chmod 700 "${PGDATA}"

# ── Step 8: Start PostgreSQL ────────────────────────────────────────────────
log "Starting PostgreSQL in recovery mode..."
if command -v pg_ctl &> /dev/null; then
  pg_ctl -D "${PGDATA}" start -w -t 300
elif command -v systemctl &> /dev/null; then
  systemctl start postgresql
fi

# ── Step 9: Verify recovery ────────────────────────────────────────────────
log "Verifying database connectivity..."
sleep 5

MAX_RETRIES=30
RETRY=0
while [ "${RETRY}" -lt "${MAX_RETRIES}" ]; do
  if psql -h "${PGHOST:-localhost}" -U "${PGUSER:-postgres}" -d "${PGDATABASE:-beba}" \
    -c "SELECT 1 AS health_check;" &>/dev/null; then
    log "Database is responsive!"
    break
  fi
  RETRY=$((RETRY + 1))
  log "Waiting for database... (${RETRY}/${MAX_RETRIES})"
  sleep 2
done

if [ "${RETRY}" -ge "${MAX_RETRIES}" ]; then
  log "ERROR: Database did not become responsive within timeout."
  exit 1
fi

# Verify data integrity
MEMBER_COUNT=$(psql -h "${PGHOST:-localhost}" -U "${PGUSER:-postgres}" -d "${PGDATABASE:-beba}" \
  -t -c "SELECT COUNT(*) FROM \"Member\";" 2>/dev/null || echo "N/A")
LOAN_COUNT=$(psql -h "${PGHOST:-localhost}" -U "${PGUSER:-postgres}" -d "${PGDATABASE:-beba}" \
  -t -c "SELECT COUNT(*) FROM \"Loan\";" 2>/dev/null || echo "N/A")

log ""
log "=== PITR Restore Complete ==="
log "Backup: ${BACKUP_NAME}"
log "Target time: ${TARGET_TIME:-latest}"
log "Members: ${MEMBER_COUNT}"
log "Loans: ${LOAN_COUNT}"
log "Previous data backed up to: ${CURRENT_BACKUP:-N/A}"
