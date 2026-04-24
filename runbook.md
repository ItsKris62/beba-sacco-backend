# Beba SACCO – Production Runbook

> **Audience:** On-call engineers and DevOps.  
> **Last updated:** 2026-04-13

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [Health Checks & Monitoring](#2-health-checks--monitoring)
3. [Deployment](#3-deployment)
4. [Rollback Procedure](#4-rollback-procedure)
5. [Database Backup & Restore](#5-database-backup--restore)
6. [Incident Response](#6-incident-response)
7. [Common Issues & Fixes](#7-common-issues--fixes)
8. [Secrets Rotation](#8-secrets-rotation)

---

## 1. Architecture Overview

```
Internet → Nginx (80/443) → NestJS App (:3000)
                                 │
                    ┌────────────┼────────────────┐
                    ▼            ▼                 ▼
               PostgreSQL     Redis           BullMQ Workers
               (Neon/local)  (Upstash/local)  (email, mpesa, audit)
                                               │
                                         Cloudflare R2 / MinIO
```

**Stack:** NestJS 10 · PostgreSQL 15 · Prisma 5 · Redis (Upstash) · BullMQ 5 · Cloudflare R2

**Ports:**
| Service | Port |
|---------|------|
| NestJS API | 3000 |
| PostgreSQL | 5432 |
| Redis | 6379 |
| MinIO API | 9000 |
| MinIO Console | 9001 |

---

## 2. Health Checks & Monitoring

### Liveness probe
```
GET /api/health/ping
```
Returns `200 { status: "ok", uptime, timestamp }`. Used by load balancers.

### Readiness probe (full dependency check)
```
GET /api/health
```
Checks: PostgreSQL · Redis · heap memory · disk. Returns `503` if any dependency is down.

### Sentry
Production errors stream to Sentry. Check `SENTRY_DSN` is set.  
Dashboard: <your-sentry-project-url>

### Logs
```bash
# Follow application logs
docker compose -f docker-compose.prod.yml logs -f app

# Grep for errors
docker compose -f docker-compose.prod.yml logs app | grep '"level":50'
```

---

## 3. Deployment

### Automated (recommended)
Push to `main` branch. GitHub Actions CI pipeline runs:
1. Lint + type check
2. Tests (unit + integration + coverage gate ≥ 80%)
3. Security scan (npm audit + TruffleHog)
4. Build + push Docker image to GHCR
5. Deploy to staging + smoke test

### Manual deployment
```bash
# On the production server
cd /opt/beba-sacco

# Pull latest image
docker pull ghcr.io/<org>/<repo>:latest

# Run DB migrations (always before restarting app)
docker run --rm --env-file .env.production \
  ghcr.io/<org>/<repo>:latest \
  npm run prisma:deploy

# Rolling restart (zero-downtime)
docker compose -f docker-compose.prod.yml up -d --no-deps app

# Verify health
curl -sf https://api.beba-sacco.com/api/health/ping
```

---

## 4. Rollback Procedure

### Rolling back the application
```bash
# List available image tags
docker images ghcr.io/<org>/<repo> --format "{{.Tag}}\t{{.CreatedAt}}" | head -10

# Roll back to a specific image tag
IMAGE=ghcr.io/<org>/<repo>:<previous-tag>
docker compose -f docker-compose.prod.yml stop app
docker compose -f docker-compose.prod.yml run --rm \
  -e IMAGE_TAG=<previous-tag> app echo "Image pinned"
docker compose -f docker-compose.prod.yml up -d --no-deps app

# Verify
curl -sf https://api.beba-sacco.com/api/health/ping
```

### Rolling back a database migration
```bash
# ⚠️  Destructive — always take a backup first (see Section 5)
# Prisma does not support automatic rollbacks; apply a corrective migration instead

# 1. Create an "undo" migration
npx prisma migrate dev --name undo_<migration_name> --schema=src/prisma/schema.prisma

# 2. Apply to production
npm run prisma:deploy
```

---

## 5. Database Backup & Restore

### Manual backup (pg_dump)
```bash
# Run from the host where postgres container is running
docker exec beba_postgres_prod pg_dump \
  -U ${POSTGRES_USER} -d ${POSTGRES_DB} \
  --format=custom --compress=9 \
  > backup_$(date +%Y%m%d_%H%M%S).dump

# Verify backup integrity
pg_restore --list backup_*.dump | head -20
```

### Restore from backup
```bash
# ⚠️  This will OVERWRITE the current database
docker exec -i beba_postgres_prod pg_restore \
  -U ${POSTGRES_USER} -d ${POSTGRES_DB} \
  --clean --if-exists \
  < backup_<timestamp>.dump
```

### Automated backups (recommended)
Configure a daily cron job on the server:
```bash
0 2 * * * /opt/beba-sacco/scripts/backup-db.sh >> /var/log/beba-backup.log 2>&1
```

---

## 6. Incident Response

### P1 — API completely down
1. Check container status: `docker compose -f docker-compose.prod.yml ps`
2. Restart if crashed: `docker compose -f docker-compose.prod.yml restart app`
3. Check logs: `docker compose -f docker-compose.prod.yml logs --tail=100 app`
4. Check health endpoint: `curl https://api.beba-sacco.com/api/health`
5. If DB is down: verify PostgreSQL container + Neon connection string
6. If Redis is down: BullMQ queues pause; app remains functional (degraded)
7. Escalate to on-call lead if not resolved within 15 min

### P2 — Email queue backlogged
```bash
# Check queue depth via BullMQ dashboard (Bull Board)
# Or via Redis CLI:
docker exec beba_redis_prod redis-cli -a ${REDIS_PASSWORD} \
  LLEN bull:email:wait

# Drain stuck jobs (moves failed jobs back to active)
docker exec beba_redis_prod redis-cli -a ${REDIS_PASSWORD} \
  LMOVE bull:email:failed bull:email:wait RIGHT LEFT
```

### P3 — M-Pesa callbacks not processing
1. Check `mpesa.callback` queue depth
2. Verify `MPESA_WEBHOOK_SECRET` matches Daraja configuration
3. Check callback URL is reachable from Safaricom IP ranges
4. Review `MpesaCallbackProcessor` logs for errors
5. Replay failed jobs from BullMQ dashboard

### P4 — High latency / timeouts
1. Check DB connection pool: `SHOW max_connections;` in Postgres
2. Check Redis memory: `docker exec beba_redis_prod redis-cli -a ${REDIS_PASSWORD} INFO memory`
3. Check for slow queries in Prisma logs (>500ms entries)
4. Restart app to flush connection pools if needed

---

## 7. Common Issues & Fixes

### Issue: `P1001 Can't reach database server`
**Cause:** DATABASE_URL uses pooler hostname with `SET search_path` calls  
**Fix:** Use the **direct** (non-pooler) Neon connection URL. Remove `-pooler` from hostname.

### Issue: BullMQ jobs stuck in `waiting` state
**Cause:** Worker not running or Redis connection dropped  
**Fix:** `docker compose -f docker-compose.prod.yml restart app`

### Issue: Pre-signed upload URLs failing in production
**Cause:** `R2_ENDPOINT` override left set from dev config  
**Fix:** Ensure `R2_ENDPOINT` is **not** set in `.env.production`; it should only be set for local MinIO.

### Issue: CORS errors from frontend
**Cause:** `CORS_ORIGIN` doesn't include the frontend domain  
**Fix:** Update `CORS_ORIGIN` in `.env.production` and restart app.

### Issue: `EMAIL queue: enqueue failed`
**Cause:** BullMQ Redis connection dropped or PLUNK_API_KEY missing  
**Fix:** Verify `PLUNK_API_KEY` is set; check Redis health; emails are fire-and-forget so no data loss.

---

## 8. Secrets Rotation

### Rotating JWT secrets
1. Generate new secrets: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
2. Update `JWT_SECRET` and `JWT_REFRESH_SECRET` in `.env.production`
3. Restart app: `docker compose -f docker-compose.prod.yml restart app`
4. **Note:** All active sessions are immediately invalidated. Users must log in again.

### Rotating M-Pesa credentials
1. Generate new credentials in Safaricom Daraja portal
2. Update `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_PASSKEY`
3. Update `MPESA_WEBHOOK_SECRET` and configure in Daraja callback settings
4. Restart app

### Rotating Redis password
1. Update `REDIS_PASSWORD` in `.env.production` and Redis container config
2. Restart both Redis and app containers simultaneously to avoid auth errors
3. Verify: `docker exec beba_redis_prod redis-cli -a <new_password> ping`

---

*For architecture decisions and Phase history, see the project memory at `~/.claude/projects/*/memory/`.*
