# Sprint 4 – Zero-Downtime Production Migration Runbook

**App:** Beba SACCO Backend (NestJS v10 + Prisma 5 + PostgreSQL 15 Neon + Upstash Redis + BullMQ v5)  
**Migration:** M-Pesa Integration Hardening – Sprint 4  
**Schema file:** `src/prisma/schema.prisma`  
**EAT timezone:** Africa/Nairobi (UTC+3)  
**Owner:** Platform Lead + SASRA Compliance Officer  

---

## 🚨 Rollback Triggers (abort & execute rollback IMMEDIATELY if any of these fire)

| Trigger | Threshold | Action |
|---|---|---|
| M-Pesa callback failure rate | > 2% over 5-min window | Rollback to previous API deployment |
| `mpesa.callback.dlq` job count | > 5 new jobs in 10 min | Pause worker, investigate, rollback if needed |
| Ledger mismatch alert | Any `COMPLETED` M-Pesa tx without linked Transaction | Stop repayment cron, trigger SASRA audit |
| DB error rate | > 0.5% on `/api/mpesa/*` | Rollback API, restore from backup |
| Worker `ECONNREFUSED` to Redis | > 3 consecutive failures | Check Upstash, do NOT restart workers blind |
| `prisma migrate deploy` fails | Any exit code ≠ 0 | Do NOT proceed — run rollback SQL immediately |

---

## PRE-FLIGHT CHECKLIST (T-2 hours before deploy)

### 1. Backup

```bash
# Neon: create a named restore point via the Neon console or CLI
# The direct (non-pooler) URL is required for pg_dump
export DIRECT_URL="postgresql://user:pass@ep-xxx.eu-west-2.aws.neon.tech/beba?sslmode=require"

# Full schema + data dump (exclude BullMQ jobs — they are in Redis)
pg_dump "$DIRECT_URL" \
  --format=custom \
  --no-owner \
  --exclude-table=_prisma_migrations \
  --file="backups/beba-pre-sprint4-$(date +%Y%m%d-%H%M%S).dump"

# Verify dump size is non-zero
ls -lh backups/beba-pre-sprint4-*.dump
```

**SASRA compliance note:** The backup preserves every `MpesaTransaction` row including `callbackPayload`. Never truncate or drop `MpesaTransaction` during migration.

### 2. Shadow DB Sync Check

```bash
# Verify the shadow database (used by migrate dev) matches the migration history
npx prisma migrate diff \
  --from-schema-datasource src/prisma/schema.prisma \
  --to-schema-datamodel src/prisma/schema.prisma \
  --script \
  --schema src/prisma/schema.prisma

# Expected output: empty diff (no pending changes)
# If there are pending changes, resolve them BEFORE proceeding
```

### 3. Redis / BullMQ Queue Drain

```bash
# Check current queue depths before deploy
# Replace REDIS_URL with your Upstash connection string
redis-cli -u "$REDIS_URL" \
  LLEN "bull:mpesa.callback:wait" \
  LLEN "bull:mpesa.callback.dlq:wait" \
  LLEN "bull:mpesa.disbursement:wait"

# Soft-drain: pause new jobs from entering, let existing jobs complete
# Use Bull Board UI (localhost:3000/admin/queues) or:
redis-cli -u "$REDIS_URL" SET "bull:mpesa.callback:paused" "1"
redis-cli -u "$REDIS_URL" SET "bull:mpesa.disbursement:paused" "1"

# Wait for active job count to reach 0 (check every 30s):
watch -n 30 'redis-cli -u "$REDIS_URL" LLEN "bull:mpesa.callback:active"'

# Un-pause after migration is complete (step in POST-DEPLOY section)
```

### 4. Announce Maintenance Window (if needed)

```bash
# If STK Pushes are in flight, allow 15 minutes for all Daraja callbacks to arrive
# before draining. Safaricom retries callbacks for up to 5 minutes.
# Maintenance window recommendation: 06:00–06:30 EAT (after daily cron, minimal traffic)
```

---

## MIGRATION EXECUTION

### Step 1: Backfill NULL references (data patch)

```sql
-- SASRA compliance: every MpesaTransaction must have a non-null reference.
-- Any rows created before the reference column was added (pre-Phase 1) will
-- have reference = NULL. This backfill sets reference = transId (B2C/C2B rows)
-- or a derived STK reference for STK rows.
--
-- Run on DIRECT URL (not pooler) to avoid transaction isolation issues.

BEGIN;

-- Backfill rows where reference IS NULL (should be zero post-Phase 1, but safe to run)
UPDATE "MpesaTransaction"
SET reference = "transId"
WHERE reference IS NULL
  AND "transId" IS NOT NULL;

-- For any remaining NULLs (edge case: no transId either), generate a synthetic reference
UPDATE "MpesaTransaction"
SET reference = CONCAT('LEGACY-', id)
WHERE reference IS NULL;

-- Verify: no NULL references remain
SELECT COUNT(*) AS null_reference_count
FROM "MpesaTransaction"
WHERE reference IS NULL;
-- Expected: 0

COMMIT;
```

> **If null_reference_count > 0 after backfill:** Do NOT proceed. Investigate the rows and apply manual correction before running the Prisma migration.

### Step 2: Apply Prisma migration

```bash
# Generate Prisma client from the current schema FIRST
# (required before migrate deploy — regenerates the typed client)
npm run prisma:generate
# Equivalent: npx prisma generate --schema=src/prisma/schema.prisma

# Dry-run: show the SQL that will be executed
npx prisma migrate diff \
  --from-migrations src/prisma/migrations \
  --to-schema-datamodel src/prisma/schema.prisma \
  --script \
  --schema src/prisma/schema.prisma

# Review the SQL above, then apply:
npx prisma migrate deploy --schema=src/prisma/schema.prisma

# Verify: check migration was applied
npx prisma migrate status --schema=src/prisma/schema.prisma
# Expected: All migrations applied
```

### Step 3: Verify schema integrity

```bash
# Confirm the @unique constraint on MpesaTransaction.reference exists
psql "$DIRECT_URL" -c "
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = '\"MpesaTransaction\"'::regclass
  AND conname LIKE '%reference%';
"
# Expected: one row with contype = 'u' (unique)

# Confirm required indices exist
psql "$DIRECT_URL" -c "
SELECT indexname FROM pg_indexes
WHERE tablename = 'MpesaTransaction'
ORDER BY indexname;
"
```

---

## DEPLOYMENT SEQUENCE

### Step 4: Blue/Green API swap

```bash
# ── Docker Compose (single-server) ──────────────────────────────────────────
# Build the new image
docker build -t beba-backend:sprint4 .

# Start the new container on a staging port first (health check)
docker run -d \
  --name beba-backend-sprint4-canary \
  --env-file .env.production \
  -p 3001:3000 \
  beba-backend:sprint4

# Health check on canary port
curl -sf http://localhost:3001/api/health | jq .
# Expected: { "status": "ok", ... }

# If health check passes, swap the main container:
docker stop beba-backend-current || true
docker rename beba-backend-current beba-backend-previous || true
docker rename beba-backend-sprint4-canary beba-backend-current

# Restart with production port
docker rm beba-backend-current
docker run -d \
  --name beba-backend-current \
  --env-file .env.production \
  -p 3000:3000 \
  --restart unless-stopped \
  beba-backend:sprint4

# ── Kubernetes (if using k8s) ────────────────────────────────────────────────
# kubectl set image deployment/beba-backend api=beba-backend:sprint4
# kubectl rollout status deployment/beba-backend
# kubectl rollout undo deployment/beba-backend   # rollback command
```

### Step 5: Queue worker rollout

```bash
# If queue workers are separate processes/containers:

# 1. Drain the old worker gracefully
docker exec beba-worker-current kill -SIGTERM 1
# NestJS respects SIGTERM via app.enableShutdownHooks()

# 2. Wait for active jobs to complete (up to 30s)
sleep 30

# 3. Start the new worker
docker run -d \
  --name beba-worker-sprint4 \
  --env-file .env.production \
  beba-backend:sprint4 \
  node dist/main.js

# Un-pause queues now that new worker is running
redis-cli -u "$REDIS_URL" DEL "bull:mpesa.callback:paused"
redis-cli -u "$REDIS_URL" DEL "bull:mpesa.disbursement:paused"
redis-cli -u "$REDIS_URL" DEL "bull:mpesa.stk-repayment:paused"
```

---

## POST-DEPLOY VERIFICATION

### Step 6: Health checks

```bash
# API health
curl -sf https://api.beba-sacco.co.ke/api/health | jq .
# Expected: { "status": "ok", "details": { "database": { "status": "up" }, "redis": { "status": "up" } } }

# Queue health (Bull Board or direct BullMQ check)
curl -sf https://api.beba-sacco.co.ke/api/health/queues | jq .
# Expected: all queues in RUNNING state, DLQ = 0 waiting

# Prometheus metrics endpoint
curl -sf https://api.beba-sacco.co.ke/api/metrics | grep mpesa
# Expected: mpesa_stk_push_total, mpesa_callback_processed_total
```

### Step 7: Prisma count queries

```bash
# Verify MpesaTransaction counts are intact (no data loss from migration)
psql "$DIRECT_URL" -c "
SELECT
  status,
  type,
  COUNT(*) AS cnt
FROM \"MpesaTransaction\"
GROUP BY status, type
ORDER BY type, status;
"

# Confirm no new NULL references were introduced
psql "$DIRECT_URL" -c "
SELECT COUNT(*) AS null_refs FROM \"MpesaTransaction\" WHERE reference IS NULL;
"
# Expected: 0

# Spot-check the most recent transactions are unchanged
psql "$DIRECT_URL" -c "
SELECT id, reference, status, amount, type, \"createdAt\"
FROM \"MpesaTransaction\"
ORDER BY \"createdAt\" DESC
LIMIT 10;
"
```

### Step 8: BullMQ queue stats

```bash
# Check queue states via redis-cli
redis-cli -u "$REDIS_URL" \
  LLEN "bull:mpesa.callback:wait" \
  LLEN "bull:mpesa.callback:active" \
  LLEN "bull:mpesa.callback.dlq:wait" \
  LLEN "bull:mpesa.stk-repayment:wait"

# Expected: callback:wait and stk-repayment:wait ≈ 0 immediately post-deploy
# callback.dlq:wait = 0 (no new failures from migration)
```

### Step 9: SASRA validator dry-run

```bash
# Run a SASRA audit covering the last 24 hours
TODAY=$(date -u +%Y-%m-%d)
YESTERDAY=$(date -u -d "yesterday" +%Y-%m-%d 2>/dev/null || date -u -v-1d +%Y-%m-%d)

curl -sf \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  "https://api.beba-sacco.co.ke/api/audit/sasra/mpesa?startDate=${YESTERDAY}&endDate=${TODAY}" \
  | jq '{
      compliancePercent: .summary.compliancePercent,
      mismatches: .summary.mismatchCount,
      stalePending: .summary.stalePendingCount,
      dlqCount: .summary.dlqCount
    }'

# ✅ PASS criteria:
#   compliancePercent ≥ 95
#   mismatches = 0
#   stalePendingCount = 0 (or matches pre-deploy count – no NEW stale rows)
#   dlqCount = -1 (expected: BullMQ DLQ is in Redis, not DB – verify via Bull Board)
```

### Step 10: End-to-end M-Pesa smoke test

```bash
# Trigger a sandbox STK Push to verify the full flow works post-deploy
# Use the Postman collection: item 03 + item 08 in sequence

# Or via curl (replace variables):
curl -X POST "https://api.beba-sacco.co.ke/api/mpesa/members/deposit" \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "254712345678",
    "amount": 1,
    "purpose": "SAVINGS",
    "accountRef": "ACC-FOSA-000001"
  }' | jq .

# Simulate the callback (use ngrok URL or internal route in staging):
# Then verify MpesaTransaction status transitioned PENDING → COMPLETED:
psql "$DIRECT_URL" -c "
SELECT status, \"mpesaReceiptNumber\", \"updatedAt\"
FROM \"MpesaTransaction\"
ORDER BY \"updatedAt\" DESC
LIMIT 3;
"
```

---

## ROLLBACK PLAN

### Rollback Step 1: Stop new API, restore previous container

```bash
# Stop new deployment
docker stop beba-backend-current
docker rm beba-backend-current

# Restore previous container (if it was saved as beba-backend-previous)
docker rename beba-backend-previous beba-backend-current
docker start beba-backend-current

# Or pull the pinned previous image:
# docker run -d --name beba-backend-current --env-file .env.production -p 3000:3000 beba-backend:sprint3
```

### Rollback Step 2: Drop unique constraint (if migration added one)

```sql
-- Only execute if the migration added the @unique constraint on MpesaTransaction.reference
-- and there are conflicts preventing the rollback schema from loading.
--
-- First: identify the constraint name
SELECT conname
FROM pg_constraint
WHERE conrelid = '"MpesaTransaction"'::regclass
  AND contype = 'u'
  AND conname LIKE '%reference%';

-- Then drop it:
BEGIN;
ALTER TABLE "MpesaTransaction" DROP CONSTRAINT IF EXISTS "MpesaTransaction_reference_key";
COMMIT;

-- Verify:
SELECT COUNT(*) FROM pg_constraint
WHERE conrelid = '"MpesaTransaction"'::regclass
  AND conname = 'MpesaTransaction_reference_key';
-- Expected: 0
```

### Rollback Step 3: Revert Prisma migration

```bash
# IMPORTANT: Prisma does not have a built-in migrate rollback command.
# Reverting requires:
#   1. Manually reversing the SQL changes (drop new columns/constraints)
#   2. Deleting the migration entry from _prisma_migrations

# Step 3a: Reverse the migration SQL manually (run in psql):
# -- Example: if the migration added a column:
# ALTER TABLE "MpesaTransaction" DROP COLUMN IF EXISTS "newColumn";

# Step 3b: Remove the migration record so Prisma thinks it was never applied:
psql "$DIRECT_URL" -c "
DELETE FROM _prisma_migrations
WHERE migration_name = '$(ls src/prisma/migrations | grep sprint4 | tail -1)';
"

# Step 3c: Regenerate Prisma client from previous schema:
git checkout HEAD~1 -- src/prisma/schema.prisma
npm run prisma:generate
```

### Rollback Step 4: Restore from DB backup (nuclear option)

```bash
# Only if steps 1–3 are insufficient or data corruption is detected.
# This restores the ENTIRE database — all transactions since backup are lost.
# SASRA requirement: document the time window and transactions affected.

pg_restore \
  --dbname "$DIRECT_URL" \
  --clean \
  --no-owner \
  --no-privileges \
  backups/beba-pre-sprint4-$(ls backups | grep pre-sprint4 | sort | tail -1 | grep -o '[0-9]*-[0-9]*')

# After restore: re-generate Prisma client
npm run prisma:generate

# Notify SASRA compliance officer of the restore event (regulatory obligation)
```

### Rollback Step 5: Requeue DLQ jobs that accumulated during incident

```bash
# After rollback, inspect jobs that landed in the DLQ during the incident:
redis-cli -u "$REDIS_URL" LRANGE "bull:mpesa.callback.dlq:wait" 0 -1

# For each job that failed due to the migration (not business logic failures),
# use the admin endpoint to replay:
curl -X POST "https://api.beba-sacco.co.ke/api/mpesa/admin/dlq/${JOB_ID}/requeue" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID"

# SASRA compliance: document every manual DLQ replay in the audit log.
# POST /api/audit manually if the replay was performed out-of-band.
```

---

## SASRA COMPLIANCE CHECKLIST (Post-Migration Sign-off)

Run this after successful deployment and verification. Sign off with the SASRA Compliance Officer.

- [ ] `MpesaTransaction.reference` — zero NULL rows confirmed (`null_refs = 0`)
- [ ] `callbackPayload` — all COMPLETED transactions have non-null callbackPayload
- [ ] Phone masking — SASRA audit report output contains only `254***XXXX` format
- [ ] Ledger cross-validation — zero mismatches in SASRA audit report
- [ ] Stale PENDING — zero rows older than 24h without FAILED/DLQ status
- [ ] DLQ = 0 — Bull Board shows `mpesa.callback.dlq` is empty
- [ ] Backup retained — pre-migration dump stored and verified
- [ ] Cron scheduler active — `mpesa-stk-repayment-scheduler` visible in cron registry
- [ ] SASRA audit report CSV exported and filed for the audit window
- [ ] Rollback plan tested in staging environment prior to this production run

---

## APPENDIX: Environment Variables Added in Sprint 4

Add these to `.env.production` before deploying:

```dotenv
# Sprint 4 – Repayment Scheduler
MPESA_STK_RATE_LIMIT_PER_DAY=3         # Max scheduler-initiated STK pushes per member/day

# Sprint 4 – SASRA Audit (no new env vars; uses existing DB/Redis connections)

# Ensure these already exist from Phase 1 & 2:
MPESA_CALLBACK_URL=https://api.beba-sacco.co.ke  # Production static URL (NOT ngrok)
MPESA_B2C_RESULT_URL=https://api.beba-sacco.co.ke/api/mpesa/webhooks/b2c-result
MPESA_B2C_QUEUE_TIMEOUT_URL=https://api.beba-sacco.co.ke/api/mpesa/webhooks/b2c-timeout
MPESA_ENVIRONMENT=production
MPESA_ALLOWED_IPS=196.201.214.200,196.201.214.206,196.201.213.114,196.201.214.207,196.201.213.141,196.201.213.45,196.201.214.141,196.201.214.145,196.201.213.113,196.201.214.113,196.201.213.95,196.201.213.94
```

---

## APPENDIX: Key File Locations

| Artifact | Path |
|---|---|
| Prisma schema | `src/prisma/schema.prisma` |
| M-Pesa utilities (maskPhone, parseReference) | `src/modules/mpesa/utils/mpesa.utils.ts` |
| SASRA validator service | `src/modules/audit/sasra-validator.service.ts` |
| SASRA DTOs | `src/modules/audit/dto/sasra-audit.dto.ts` |
| Repayment scheduler | `src/modules/queue/processors/mpesa-repayment.scheduler.ts` |
| Queue constants | `src/modules/queue/queue.constants.ts` |
| Postman collection | `scripts/mpesa-sprint4.postman_collection.json` |
| Postman environment | `scripts/mpesa-sprint4.postman_environment.json` |
| ngrok tunnel script | `scripts/ngrok-mpesa-tunnel.sh` |
| This runbook | `docs/sprint4-production-runbook.md` |

---

*Last updated: 2026-04-23 | Author: Sprint 4 Engineering Team*  
*SASRA Filing Reference: Attach this document to the quarterly SASRA operational report.*
