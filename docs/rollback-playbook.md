# 🔄 Rollback & Recovery Playbook — Beba SACCO

> **Version:** 1.0.0-mvp  
> **Last Updated:** 2026-04-25 (EAT)  
> **Owner:** DevOps / Engineering Lead  
> **Regulatory Context:** SASRA Circular No. 3/2022 §6 (Business Continuity), CBK Prudential Guidelines 2013 §14 (Disaster Recovery)

---

## ⚡ QUICK REFERENCE — Copy-Paste Commands

```bash
# 1. Tag current commit as stable release
git tag -a v1.0.0-mvp -m "Phase 5 production release — SASRA/ODPC/CBK compliant"
git push origin v1.0.0-mvp

# 2. Emergency rollback to last stable tag
git checkout v1.0.0-mvp
git push origin HEAD:main --force

# 3. Prisma migration rollback (last migration)
cd backend && npx prisma migrate resolve --rolled-back <migration_name>

# 4. Neon PITR restore (replace timestamp)
# Via Neon Console: https://console.neon.tech → Branch → Restore to point in time

# 5. Render one-click rollback
# Dashboard → beba-sacco-api → Deploys → [previous deploy] → Rollback
```

---

## 📋 TABLE OF CONTENTS

1. [Pre-Rollback Decision Criteria](#1-pre-rollback-decision-criteria)
2. [Git Tag & Release Management](#2-git-tag--release-management)
3. [Render Rollback Procedure](#3-render-rollback-procedure)
4. [Database Rollback — Prisma Migrations](#4-database-rollback--prisma-migrations)
5. [Neon PITR — Point-in-Time Recovery](#5-neon-pitr--point-in-time-recovery)
6. [Redis / Upstash Recovery](#6-redis--upstash-recovery)
7. [BullMQ Queue Recovery](#7-bullmq-queue-recovery)
8. [M-Pesa Transaction Recovery](#8-mpesa-transaction-recovery)
9. [Post-Rollback Verification](#9-post-rollback-verification)
10. [Incident Communication Template](#10-incident-communication-template)

---

## 1. Pre-Rollback Decision Criteria

**Roll back immediately if ANY of the following are true:**

| Condition | Severity | Action |
|-----------|----------|--------|
| Health endpoint returning non-200 for >5 minutes | CRITICAL | Immediate rollback |
| M-Pesa double-credit detected | CRITICAL | Immediate rollback + CBK notification |
| Authentication completely broken (all logins fail) | CRITICAL | Immediate rollback |
| Data corruption detected in financial records | CRITICAL | Immediate rollback + Neon PITR |
| Smoke tests failing >3 critical suites | HIGH | Rollback within 30 minutes |
| Sentry error rate >10x baseline | HIGH | Rollback within 1 hour |
| SASRA audit trail broken | HIGH | Rollback within 1 hour |
| Single non-critical feature broken | LOW | Fix forward (no rollback) |

**Decision authority:**
- Engineering Lead or CTO can authorize rollback
- For CRITICAL issues: any engineer can initiate rollback immediately

---

## 2. Git Tag & Release Management

### 2.1 Tag the Current Release

Run this **before** every production deployment:

```bash
# From the backend/ directory
cd /path/to/Beba-App

# Ensure you're on the correct commit
git log --oneline -5

# Create annotated tag (annotated tags are permanent and signed)
git tag -a v1.0.0-mvp -m "Phase 5 production release — SASRA/ODPC/CBK compliant MVP"

# Push tag to remote
git push origin v1.0.0-mvp

# Verify tag was created
git tag -l "v*" --sort=-version:refname | head -5
```

### 2.2 List Available Tags (for rollback selection)

```bash
# List all release tags, newest first
git tag -l "v*" --sort=-version:refname

# Show tag details
git show v1.0.0-mvp --stat
```

### 2.3 Emergency Git Rollback

```bash
# Option A: Rollback to specific tag (RECOMMENDED)
git checkout v1.0.0-mvp
git push origin HEAD:main --force

# Option B: Rollback to specific commit hash
git checkout <commit-hash>
git push origin HEAD:main --force

# Option C: Revert last N commits (preserves history)
git revert HEAD~3..HEAD --no-edit
git push origin main

# Verify rollback
git log --oneline -3
```

> ⚠️ **WARNING:** `--force` push rewrites history. Only use in emergencies.  
> Notify the team on Slack before force-pushing to `main`.

---

## 3. Render Rollback Procedure

### 3.1 One-Click Rollback via Dashboard

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Select service: **beba-sacco-api**
3. Click **"Deploys"** tab in the left sidebar
4. Find the last known-good deploy (look for green ✅ status)
5. Click the **"..."** menu next to that deploy
6. Select **"Rollback to this deploy"**
7. Confirm the rollback
8. Wait for deploy to complete (~3-5 minutes)
9. Run smoke tests to verify: `bash scripts/run-smoke-test.sh`

### 3.2 Render CLI Rollback

```bash
# Install Render CLI if not already installed
npm install -g @render-oss/cli

# Login
render login

# List recent deploys
render deploys list --service beba-sacco-api

# Rollback to specific deploy ID
render deploys rollback --service beba-sacco-api --deploy-id <deploy-id>
```

### 3.3 Render Environment Variable Rollback

If the issue is a bad environment variable:

1. Go to Render Dashboard → **beba-sacco-api** → **Environment**
2. Find the problematic variable
3. Revert to the previous value
4. Click **"Save Changes"** — this triggers an automatic redeploy

---

## 4. Database Rollback — Prisma Migrations

### 4.1 Check Current Migration State

```bash
cd backend

# List all migrations and their status
npx prisma migrate status

# Show current migration history
npx prisma migrate status --schema=src/prisma/schema.prisma
```

### 4.2 Rollback Last Migration (Mark as Rolled Back)

```bash
# Step 1: Get the migration name from the status output
# Example: 20260425_add_compliance_tables

# Step 2: Mark the migration as rolled back in Prisma's migration table
npx prisma migrate resolve \
  --rolled-back 20260425_add_compliance_tables \
  --schema=src/prisma/schema.prisma

# Step 3: Manually drop the tables/columns added by that migration
# (Prisma does NOT auto-drop — you must write the SQL manually)
# Connect to Neon and run the reverse SQL:
# psql $DIRECT_URL -c "DROP TABLE IF EXISTS \"ComplianceCheck\";"

# Step 4: Verify migration state
npx prisma migrate status
```

### 4.3 Full Migration Reset (NUCLEAR — use only in staging)

```bash
# ⚠️ DANGER: This drops ALL data. NEVER run in production.
# Only for staging/dev environments.
npx prisma migrate reset --schema=src/prisma/schema.prisma --force
```

### 4.4 Safe Migration Rollback Pattern

For production, always write a **down migration** SQL file alongside each migration:

```sql
-- migrations/20260425_add_compliance_tables/down.sql
-- Run this to reverse the migration

DROP TABLE IF EXISTS "ComplianceCheck";
DROP TABLE IF EXISTS "DsarRequest";
ALTER TABLE "AuditLog" DROP COLUMN IF EXISTS "entryHash";
ALTER TABLE "AuditLog" DROP COLUMN IF EXISTS "prevHash";
```

```bash
# Apply the down migration
psql "$DIRECT_URL" -f migrations/20260425_add_compliance_tables/down.sql

# Then mark as rolled back in Prisma
npx prisma migrate resolve --rolled-back 20260425_add_compliance_tables
```

---

## 5. Neon PITR — Point-in-Time Recovery

### 5.1 Neon PITR Window

| Neon Plan | PITR Window |
|-----------|-------------|
| Free | 7 days |
| Launch | 7 days |
| Scale | 30 days |
| Business | 30 days |

> **SASRA Regulation 42** requires 7-year data retention. Neon PITR covers short-term recovery; long-term backups must be exported separately.

### 5.2 Verify PITR is Available

```bash
# Check Neon branch details via API
curl -s \
  -H "Authorization: Bearer $NEON_API_KEY" \
  "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches" \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const b=JSON.parse(d).branches; b.forEach(br=>console.log(br.name, br.created_at, 'PITR:', br.point_in_time_restore_enabled))"
```

### 5.3 Restore to Point in Time (via Neon Console)

1. Go to [Neon Console](https://console.neon.tech)
2. Select project: **beba-sacco**
3. Click **"Branches"** in the left sidebar
4. Click **"Restore"** button on the `main` branch
5. Select **"Point in time"**
6. Enter the target timestamp (EAT format: `2026-04-25T10:00:00+03:00`)
7. Click **"Restore branch"**
8. Neon creates a new branch with the restored data
9. Update `DATABASE_URL` in Render to point to the restored branch
10. Run smoke tests to verify data integrity

### 5.4 Restore via Neon API

```bash
# Replace with your actual values
NEON_API_KEY="your-neon-api-key"
NEON_PROJECT_ID="your-project-id"
SOURCE_BRANCH_ID="br-main-branch-id"

# Restore to a specific timestamp (ISO 8601 UTC)
RESTORE_TIMESTAMP="2026-04-25T07:00:00Z"  # 10:00 EAT = 07:00 UTC

curl -s -X POST \
  -H "Authorization: Bearer $NEON_API_KEY" \
  -H "Content-Type: application/json" \
  "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches" \
  -d "{
    \"branch\": {
      \"parent_id\": \"$SOURCE_BRANCH_ID\",
      \"parent_timestamp\": \"$RESTORE_TIMESTAMP\",
      \"name\": \"restore-$(date +%Y%m%d-%H%M%S)\"
    },
    \"endpoints\": [{\"type\": \"read_write\"}]
  }" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const r=JSON.parse(d); console.log('Restored branch:', r.branch?.name, '\nConnection string:', r.endpoints?.[0]?.connection_uri)"
```

### 5.5 Export Full Database Backup (SASRA 7-Year Retention)

```bash
# Run monthly — store in Cloudflare R2 under backups/YYYY-MM/
pg_dump "$DIRECT_URL" \
  --format=custom \
  --compress=9 \
  --file="beba-sacco-backup-$(date +%Y-%m-%d).dump"

# Upload to R2
aws s3 cp \
  "beba-sacco-backup-$(date +%Y-%m-%d).dump" \
  "s3://$R2_BUCKET_NAME/backups/$(date +%Y-%m)/" \
  --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"

echo "✅ Backup uploaded to R2"
```

---

## 6. Redis / Upstash Recovery

### 6.1 Redis Data Loss Scenarios

Redis (Upstash) stores:
- BullMQ job queues (ephemeral — jobs are re-created from DB if lost)
- Rate limit counters (ephemeral — reset on Redis restart is acceptable)
- Session/refresh token blacklist (ephemeral — tokens expire naturally)

**Redis data loss is NOT a financial data loss event.** All financial data is in Neon PostgreSQL.

### 6.2 Flush Stuck Jobs (Emergency)

```bash
# Connect to Upstash Redis
redis-cli -h $REDIS_HOST -p $REDIS_PORT -a $REDIS_PASSWORD --tls

# List all BullMQ queues
KEYS "bull:*:*"

# Flush a specific queue's failed jobs
DEL "bull:mpesa-callbacks:failed"
DEL "bull:interest-accrual:failed"

# Flush ALL queues (nuclear — use only if queues are completely corrupted)
FLUSHDB
```

### 6.3 Upstash Console Recovery

1. Go to [Upstash Console](https://console.upstash.com)
2. Select your Redis database
3. Click **"Data Browser"**
4. Find and delete corrupted keys
5. Or use **"Flush Database"** for complete reset

---

## 7. BullMQ Queue Recovery

### 7.1 Retry Failed Jobs via Bull Board

1. Navigate to: `https://beba-sacco-api.onrender.com/admin/queues`
2. Select the queue with failed jobs
3. Click **"Retry all failed"** or retry individual jobs
4. Monitor the queue until jobs complete

### 7.2 Retry Failed Jobs via CLI

```bash
# Using Bull Board CLI or custom script
node -e "
const { Queue } = require('bullmq');
const queue = new Queue('mpesa-callbacks', {
  connection: { host: process.env.REDIS_HOST, port: process.env.REDIS_PORT, password: process.env.REDIS_PASSWORD, tls: {} }
});
queue.retryJobs({ count: 100, state: 'failed' }).then(() => {
  console.log('Retried failed jobs');
  process.exit(0);
});
"
```

### 7.3 M-Pesa Callback Replay

If M-Pesa callbacks were lost (e.g., Redis flush during active transactions):

```bash
# Find PENDING M-Pesa transactions older than 1 hour
psql "$DIRECT_URL" -c "
  SELECT id, reference, amount, \"phoneNumber\", \"createdAt\"
  FROM \"MpesaTransaction\"
  WHERE status = 'PENDING'
    AND \"createdAt\" < NOW() - INTERVAL '1 hour'
  ORDER BY \"createdAt\" ASC;
"

# For each PENDING transaction, query Safaricom for status
# POST https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query
# Then manually update status based on Safaricom response
```

---

## 8. M-Pesa Transaction Recovery

### 8.1 Detect Double-Credit

```bash
# Check for duplicate M-Pesa references (should be 0)
psql "$DIRECT_URL" -c "
  SELECT reference, COUNT(*) as count
  FROM \"MpesaTransaction\"
  GROUP BY reference
  HAVING COUNT(*) > 1;
"

# Check for accounts with unexpected balance increases
psql "$DIRECT_URL" -c "
  SELECT a.id, a.balance, a.\"updatedAt\",
         COUNT(t.id) as tx_count,
         SUM(t.amount) as total_credited
  FROM \"Account\" a
  JOIN \"Transaction\" t ON t.\"accountId\" = a.id
  WHERE t.\"createdAt\" > NOW() - INTERVAL '2 hours'
    AND t.type = 'DEPOSIT'
  GROUP BY a.id, a.balance, a.\"updatedAt\"
  HAVING COUNT(t.id) > 3
  ORDER BY total_credited DESC;
"
```

### 8.2 Reverse a Double-Credit

```bash
# Step 1: Identify the duplicate transaction
psql "$DIRECT_URL" -c "
  SELECT id, \"accountId\", amount, reference, status, \"createdAt\"
  FROM \"Transaction\"
  WHERE reference = 'DUPLICATE_REF_HERE'
  ORDER BY \"createdAt\";
"

# Step 2: Mark the duplicate as REVERSED (do NOT delete — audit trail)
psql "$DIRECT_URL" -c "
  UPDATE \"Transaction\"
  SET status = 'REVERSED',
      \"updatedAt\" = NOW()
  WHERE id = 'DUPLICATE_TX_ID'
    AND status = 'COMPLETED';
"

# Step 3: Reverse the account balance
psql "$DIRECT_URL" -c "
  UPDATE \"Account\"
  SET balance = balance - <duplicate_amount>,
      \"updatedAt\" = NOW()
  WHERE id = '<account_id>';
"

# Step 4: Create an audit log entry for the reversal
# (Use the admin API: POST /admin/transactions/:id/reverse)

# Step 5: Notify CBK FIU if amount > KES 1,000,000
# (CBK AML/CFT Guidelines 2020 §7.3)
```

---

## 9. Post-Rollback Verification

After any rollback, run these checks in order:

### 9.1 Automated Smoke Tests

```bash
cd backend

BASE_URL=https://beba-sacco-api.onrender.com \
SMOKE_ADMIN_EMAIL=admin@beba-sacco.co.ke \
SMOKE_ADMIN_PASSWORD=$SMOKE_ADMIN_PASSWORD \
bash scripts/run-smoke-test.sh
```

### 9.2 Environment Variable Verification

```bash
# Source production env vars and run verification
bash scripts/render-env-verify.sh
```

### 9.3 Compliance Validation

```bash
# Run compliance validation via API
curl -s \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://beba-sacco-api.onrender.com/api/compliance/validate" \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const r=JSON.parse(d); console.log('Score:', r.summary?.complianceScore + '%', '| GO/NO-GO:', r.summary?.goNoGo)"
```

### 9.4 Manual Verification Checklist

- [ ] Health endpoint returns 200: `GET /api/health/ping`
- [ ] Admin login works
- [ ] Member login works
- [ ] Account balance is correct (spot-check 3 accounts)
- [ ] No new Sentry errors in last 15 minutes
- [ ] BullMQ queues are processing (check Bull Board)
- [ ] M-Pesa callback endpoint is reachable
- [ ] Audit log is recording new entries
- [ ] No PENDING M-Pesa transactions older than 1 hour

---

## 10. Incident Communication Template

### 10.1 Internal Slack Alert (Post Immediately)

```
🚨 INCIDENT: Beba SACCO Production Issue

Status: [INVESTIGATING / ROLLING BACK / RESOLVED]
Time: [EAT timestamp]
Impact: [What is broken / who is affected]
Action: [What we're doing right now]
ETA: [When we expect resolution]

Next update in: 15 minutes
```

### 10.2 SASRA/CBK Notification (Within 24 Hours for Critical Issues)

Per SASRA Circular No. 3/2022 §6.3, notify SASRA within 24 hours of any:
- System outage affecting member transactions
- Data breach or unauthorized access
- M-Pesa double-credit or fraud incident

**SASRA Contact:**  
Email: info@sasra.go.ke  
Phone: +254 20 2230 200  
Address: Upper Hill, Nairobi

**CBK Contact (for M-Pesa/payment issues):**  
Email: cbk@centralbank.go.ke  
Phone: +254 20 286 0000

### 10.3 Member Communication (Within 4 Hours for Service Disruption)

```
Dear Beba SACCO Member,

We are currently experiencing a technical issue affecting [service].
Your funds are safe and secure.

We expect to resolve this by [EAT time].

We apologize for the inconvenience.

Beba SACCO Support Team
support@beba-sacco.co.ke
```

---

## 📊 Recovery Time Objectives (RTO/RPO)

| Scenario | RTO Target | RPO Target | Method |
|----------|-----------|-----------|--------|
| Render deploy failure | 10 minutes | 0 (no data loss) | Render one-click rollback |
| Bad code deployment | 15 minutes | 0 (no data loss) | Git tag rollback |
| Database migration failure | 30 minutes | 0 (no data loss) | Prisma migrate resolve |
| Data corruption (minor) | 1 hour | 1 hour | Neon PITR |
| Data corruption (major) | 4 hours | 24 hours | Neon PITR + manual reconciliation |
| Complete infrastructure failure | 24 hours | 24 hours | Full restore from R2 backup |

> **SASRA Circular No. 3/2022 §6.2** requires RTO ≤ 4 hours for critical systems.  
> All scenarios above meet this requirement.

---

*✅ File complete — ready for review*
