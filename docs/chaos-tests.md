# Chaos Readiness Test Plan – Beba SACCO (Phase 4)

These tests MUST be run in **staging** only. Each scenario describes the failure to inject, expected system behaviour, and pass criteria.

---

## 1. Primary Database Drop

**Inject:** `docker compose down postgres`

**Expected behaviour:**
- NestJS app logs connection errors via nestjs-pino (structured JSON)
- `GET /api/health` returns 503 within 30 s
- `GET /api/health/synthetic` returns 503 immediately
- BullMQ workers pause job processing (do not crash)
- No in-flight HTTP requests hang indefinitely (Prisma pool timeout ~10 s)

**Recovery:**
```bash
docker compose up -d postgres
# Wait for Prisma to reconnect (auto-reconnect via connection pool)
```

**Pass criteria:**
- Health check recovers to 200 within 60 s of DB restart
- Zero data loss (no committed transactions lost)
- Queue resumes processing pending jobs automatically

---

## 2. Redis Partition

**Inject:** `docker compose stop redis`

**Expected behaviour:**
- App stays up (Redis failures are non-fatal — see `RedisService` catch blocks)
- Idempotency middleware degrades gracefully (passes requests through)
- Velocity checks degrade gracefully (allow-through on Redis error)
- BullMQ workers: jobs already in-flight complete; new jobs cannot be enqueued
- Token cache (Daraja OAuth) falls through to fresh API call

**Recovery:**
```bash
docker compose start redis
```

**Pass criteria:**
- No 500 errors on non-Redis-dependent endpoints
- Queue auto-reconnects and drains backlog within 2 min of Redis recovery

---

## 3. Daraja (M-Pesa) Timeout

**Inject:** Add iptables rule to drop packets to `sandbox.safaricom.co.ke`:
```bash
iptables -A OUTPUT -d sandbox.safaricom.co.ke -j DROP
```

**Expected behaviour:**
- `POST /api/mpesa/stk-push` returns 500 after fetch timeout (~30 s)
- No duplicate `MpesaTransaction` records created
- Alertmanager fires if error rate > 1% (5 min window)
- Pending `MpesaTransaction` records left in PENDING state for reconciliation

**Recovery:**
```bash
iptables -D OUTPUT -d sandbox.safaricom.co.ke -j DROP
```

**Pass criteria:**
- No zombie transactions; recon engine flags stale PENDING → RECON_PENDING
- System recovers without manual intervention

---

## 4. Queue Worker Crash

**Inject:** Kill the BullMQ worker process:
```bash
docker compose kill app  # or send SIGKILL to a specific worker
```

**Expected behaviour:**
- Jobs with `lockDuration` exceeded are automatically re-queued by BullMQ
- On app restart, pending jobs resume processing (at-least-once delivery)
- Idempotency references (`reference` field on Transaction) prevent double-posting

**Recovery:**
```bash
docker compose up -d app
```

**Pass criteria:**
- All queued jobs eventually complete
- No duplicate financial transactions posted

---

## 5. High-Volume Load Spike (BullMQ Backlog)

**Inject:** Enqueue 500 interest accrual jobs simultaneously:
```bash
# Use the BullMQ board or a test script to flood the queue
node scripts/flood-queue.js --queue financial.interest-accrual --count 500
```

**Expected behaviour:**
- Alertmanager fires `QueueBacklog` alert (depth > 100 for 10 min)
- Workers process at configured concurrency (3 for accrual)
- No job is lost; failed jobs retry up to 3×

**Pass criteria:**
- All 500 jobs complete within 30 min
- Alertmanager alert resolves automatically after backlog clears

---

## 6. Secret Rotation

**Inject:** Rotate `DARAJA_CONSUMER_KEY` + `DARAJA_CONSUMER_SECRET`:
```bash
# Update .env / secrets manager
# Trigger config reload:
curl -X POST http://localhost:3000/api/admin/security/rotate \
  -H "Authorization: Bearer <SUPER_ADMIN_TOKEN>" \
  -H "X-Tenant-ID: <tenant>"
```

**Expected behaviour:**
- Cached Daraja OAuth token invalidated in Redis
- Next M-Pesa STK Push uses fresh credentials
- No downtime during rotation

**Pass criteria:**
- STK Push succeeds within 60 s of rotation
- Old token no longer accepted by Daraja

---

## 7. Ledger Drift Injection (Synthetic)

**Inject:** Directly update an account balance in the DB without a corresponding Transaction:
```sql
UPDATE "Account" SET balance = balance + 1000 WHERE id = '<test-account-id>';
```

**Expected behaviour:**
- Ledger integrity checker (hourly) detects drift
- `LEDGER_DRIFT_DETECTED` error logged
- Alertmanager `LedgerDrift` alert fires
- Disbursement blocked for that tenant

**Recovery:**
- Investigate and post a correcting Transaction record
- Rerun integrity check to confirm resolution

---

## Running the Tests

```bash
# Start staging stack
docker compose -f docker-compose.yml up -d

# Run health check baseline
curl http://localhost:3000/api/health/synthetic

# Inject chaos (example: DB drop)
docker compose stop postgres
sleep 10
curl http://localhost:3000/api/health  # should return 503

# Recover
docker compose start postgres
sleep 30
curl http://localhost:3000/api/health  # should return 200
```
