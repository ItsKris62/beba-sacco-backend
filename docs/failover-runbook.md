# 🔄 Failover Runbook – Phase 5 SRE

## Overview

This runbook documents the disaster recovery (DR) and failover procedures for the Beba SACCO platform. It covers database failover, Redis recovery, application scaling, and zero-downtime deployment rollback.

**Target SLAs:**
- Uptime: 99.95%
- RTO (Recovery Time Objective): < 60 seconds
- RPO (Recovery Point Objective): 0 (zero data loss via WAL replication)
- p95 latency: < 150ms
- Error rate: < 0.1%

---

## 1. PostgreSQL Primary Failover

### Trigger
- Primary DB unresponsive for > 30 seconds
- Health check failures on `/health` endpoint
- PgBouncer connection pool exhaustion (> 80%)

### Steps

1. **Verify primary is down:**
   ```bash
   psql -h pg-primary.beba.internal -U beba_app -c "SELECT 1;" 2>&1
   ```

2. **Promote replica to primary:**
   ```bash
   # On replica host:
   pg_ctl promote -D /var/lib/postgresql/data
   ```

3. **Update PgBouncer configuration:**
   ```bash
   # Edit pgbouncer.ini: change beba_primary host to replica address
   sed -i 's/pg-primary.beba.internal/pg-replica-01.beba.internal/' /etc/pgbouncer/pgbouncer.ini
   pgbouncer -R /etc/pgbouncer/pgbouncer.ini  # Reload without dropping connections
   ```

4. **Update DNS (if using DNS-based routing):**
   ```bash
   # Update A record for pg-primary.beba.internal → new primary IP
   # TTL should be 30s for fast propagation
   ```

5. **Verify application connectivity:**
   ```bash
   curl -s http://localhost:3000/health | jq .
   ```

6. **Rebuild replica from new primary:**
   ```bash
   pg_basebackup -h pg-replica-01.beba.internal -U replication -D /var/lib/postgresql/data --wal-method=stream
   ```

### Rollback
- If promoted replica has issues, restore from latest PITR backup:
  ```bash
  ./scripts/restore-pitr.sh <latest_backup> --dry-run
  ./scripts/restore-pitr.sh <latest_backup>
  ```

---

## 2. Redis Failure Recovery

### Trigger
- Redis connection timeouts > 5 seconds
- BullMQ job processing stalls
- Rate limiter returning errors

### Steps

1. **Check Redis status:**
   ```bash
   redis-cli -h redis.beba.internal ping
   redis-cli -h redis.beba.internal info replication
   ```

2. **If Redis is down, application degrades gracefully:**
   - Rate limiter falls back to in-memory (permissive)
   - BullMQ jobs queue in memory, retry on reconnect
   - Session cache misses → re-authenticate from DB

3. **Restart Redis:**
   ```bash
   systemctl restart redis
   # Or in K8s:
   kubectl rollout restart deployment/redis -n beba
   ```

4. **Verify BullMQ recovery:**
   ```bash
   # Check queue depths return to normal
   curl -s http://localhost:3000/admin/monitoring/queue-health | jq .
   ```

---

## 3. Application Pod Failure

### Trigger
- Pod crash loop (> 3 restarts in 5 minutes)
- OOM kill events
- Health check failures

### Steps

1. **Check pod status:**
   ```bash
   kubectl get pods -n beba -l app=beba-api
   kubectl describe pod <pod-name> -n beba
   kubectl logs <pod-name> -n beba --tail=100
   ```

2. **If OOM:** Scale up memory limits or investigate memory leak:
   ```bash
   kubectl top pods -n beba
   kubectl set resources deployment/beba-api -n beba --limits=memory=2Gi
   ```

3. **If crash loop:** Check recent deployments:
   ```bash
   kubectl rollout history deployment/beba-api -n beba
   kubectl rollout undo deployment/beba-api -n beba  # Rollback to previous
   ```

---

## 4. Blue-Green Deployment Rollback

### Trigger
- p99 latency > 1 second after deployment
- Error rate > 0.5% after deployment
- Health check failures on green deployment

### Steps

1. **Switch traffic back to blue:**
   ```bash
   kubectl patch service beba-api -n beba -p '{"spec":{"selector":{"slot":"blue"}}}'
   ```

2. **Verify blue is healthy:**
   ```bash
   curl -s http://localhost:3000/health | jq .
   ```

3. **Investigate green failure:**
   ```bash
   kubectl logs -l slot=green -n beba --tail=200
   ```

4. **Scale down green:**
   ```bash
   kubectl scale deployment/beba-api-green -n beba --replicas=0
   ```

---

## 5. BullMQ Worker Recovery

### Trigger
- Queue depth > 500 for > 5 minutes
- Worker pods all in CrashLoopBackOff
- Stalled jobs detected

### Steps

1. **Check worker status:**
   ```bash
   kubectl get pods -n beba -l app=beba-workers
   ```

2. **Force restart workers:**
   ```bash
   kubectl rollout restart deployment/beba-workers -n beba
   ```

3. **Verify queue drain:**
   ```bash
   # Monitor queue depths
   watch -n 5 'curl -s http://localhost:3000/admin/monitoring/queue-health | jq .'
   ```

4. **If stalled jobs exist:**
   ```bash
   # Connect to Redis and check stalled jobs
   redis-cli -h redis.beba.internal
   > KEYS bull:*:stalled
   ```

---

## 6. Daraja (M-Pesa) API Outage

### Trigger
- Safaricom API returning 503/504
- Circuit breaker in OPEN state
- M-Pesa callback queue growing

### Steps

1. **Verify Daraja status:**
   ```bash
   curl -s https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials
   ```

2. **Application handles automatically:**
   - Circuit breaker prevents cascading failures
   - Failed transactions queued for retry
   - Users see "M-Pesa temporarily unavailable" message

3. **When Daraja recovers:**
   - Circuit breaker auto-resets after 60s
   - Queued transactions retry automatically
   - Run reconciliation to verify all transactions:
     ```bash
     curl -X POST http://localhost:3000/admin/mpesa/reconcile
     ```

---

## 7. Post-Incident Checklist

After any failover event:

- [ ] Verify all services healthy (`GET /health`)
- [ ] Check data integrity (member/loan/transaction counts)
- [ ] Verify queue depths at zero
- [ ] Check for orphaned transactions
- [ ] Review monitoring dashboards for anomalies
- [ ] Update incident log with timeline and root cause
- [ ] Schedule post-mortem within 48 hours
- [ ] Update this runbook if procedures changed

---

## Contact Escalation

| Level | Contact | Response Time |
|-------|---------|---------------|
| L1 | On-call SRE | < 5 minutes |
| L2 | Platform Lead | < 15 minutes |
| L3 | CTO / VP Engineering | < 30 minutes |
| External | Safaricom API Support | As needed |
| External | Cloud Provider Support | As needed |
