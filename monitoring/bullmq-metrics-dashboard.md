# BullMQ Metrics Dashboard Queries (Prometheus/Grafana)

## Overview
These PromQL queries power the BullMQ observability dashboard for Beba SACCO.

## Queue Depth & Throughput

```promql
# Current queue depth by queue name
beba_bullmq_queue_waiting{job="beba-sacco"}
beba_bullmq_queue_active{job="beba-sacco"}
beba_bullmq_queue_completed{job="beba-sacco"}
beba_bullmq_queue_failed{job="beba-sacco"}
beba_bullmq_queue_delayed{job="beba-sacco"}
```

## Job Success / Fail Rates

```promql
# Job completion rate (jobs/min)
rate(beba_bullmq_jobs_completed_total[5m]) * 60

# Job failure rate (jobs/min)
rate(beba_bullmq_jobs_failed_total[5m]) * 60

# Success ratio over 5m window
rate(beba_bullmq_jobs_completed_total[5m])
/
(rate(beba_bullmq_jobs_completed_total[5m]) + rate(beba_bullmq_jobs_failed_total[5m]))
```

## DLQ Monitoring

```promql
# DLQ size by queue
beba_bullmq_dlq_size{job="beba-sacco"}

# DLQ growth rate (alerts when > 0)
rate(beba_bullmq_dlq_size[5m]) > 0

# Jobs that have exceeded max retries
beba_bullmq_jobs_max_retries_exceeded_total{job="beba-sacco"}
```

## Queue Latency

```promql
# Time from job creation to completion (p95)
histogram_quantile(0.95,
  rate(beba_bullmq_job_duration_seconds_bucket[5m])
)

# Time spent waiting in queue before processing starts
beba_bullmq_queue_wait_time_seconds{job="beba-sacco"}
```

## Worker Health

```promql
# Active workers by queue
beba_bullmq_workers_active{job="beba-sacco"}

# Worker memory usage
beba_nodejs_heap_size_used_bytes{job="beba-sacco"}

# Worker CPU usage (if node_exporter is deployed)
100 - (avg by (instance) (irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)
```

## Alert Rules (Prometheus)

```yaml
groups:
  - name: bullmq_alerts
    rules:
      - alert: BullMQQueueDepthHigh
        expr: beba_bullmq_queue_waiting > 1000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "BullMQ queue depth is high"
          description: "Queue {{ $labels.queue }} has {{ $value }} waiting jobs"

      - alert: BullMQDLQGrowing
        expr: rate(beba_bullmq_dlq_size[5m]) > 0
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "BullMQ DLQ is growing"
          description: "DLQ for {{ $labels.queue }} is accumulating failed jobs"

      - alert: BullMQHighFailureRate
        expr: |
          rate(beba_bullmq_jobs_failed_total[5m])
          /
          (rate(beba_bullmq_jobs_completed_total[5m]) + rate(beba_bullmq_jobs_failed_total[5m]))
          > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High job failure rate"
          description: "Failure rate for {{ $labels.queue }} is {{ $value | humanizePercentage }}"

      - alert: BullMQWorkerDown
        expr: beba_bullmq_workers_active == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "No active workers for queue"
          description: "Queue {{ $labels.queue }} has zero active workers"
```

## Audit Log Verification Queries

```sql
-- Verify no missing audit entries for financial mutations (last 24h)
SELECT
  action,
  COUNT(*) as count,
  MAX(timestamp) as last_occurrence
FROM "AuditLog"
WHERE timestamp >= NOW() - INTERVAL '24 hours'
  AND action IN ('LOAN.DISBURSE', 'LOAN.REPAY', 'DEPOSIT.STK', 'WITHDRAWAL.POST')
GROUP BY action
ORDER BY count DESC;

-- Check for duplicate transaction references (idempotency breach)
SELECT reference, COUNT(*) as dup_count
FROM "Transaction"
WHERE created_at >= NOW() - INTERVAL '24 hours'
GROUP BY reference
HAVING COUNT(*) > 1;

-- Verify tenant isolation: cross-tenant audit entries (should be 0)
SELECT COUNT(*) as cross_tenant_count
FROM "AuditLog" a
JOIN "User" u ON a."actorId" = u.id
WHERE a."tenantId" != u."tenantId"
  AND a.timestamp >= NOW() - INTERVAL '24 hours';

-- PII redaction verification: ensure no raw phone/ID in audit metadata
SELECT id, action, metadata
FROM "AuditLog"
WHERE metadata::text ~ '\d{8,}'  -- potential unredacted ID numbers
  AND timestamp >= NOW() - INTERVAL '24 hours'
LIMIT 10;
```
