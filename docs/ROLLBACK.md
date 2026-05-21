# Beba SACCO Rollback Runbook

Last updated: 2026-05-20 | Owner: Engineering Lead

## Quick Rollback (<5 minutes)

```bash
# 1. Disable feature flags via Render dashboard or Render CLI.
render env set -e production -s beba-sacco-api FEATURE_SECURE_UPLOAD_V2=false
render env set -e production -s beba-sacco-api FEATURE_VIRUS_SCAN=false
render env set -e production -s beba-sacco-api FEATURE_RLS_ENFORCEMENT=false
render env set -e production -s beba-sacco-api FEATURE_KYC_STATUS_ALIAS=false

# 2. If code caused the incident, redeploy the previous known-good Git tag.
render deploy beba-sacco-api --git-ref v1.2.3

# 3. If a migration failed before becoming active, mark it rolled back.
npx prisma migrate resolve --rolled-back <migration-name> --schema=src/prisma/schema.prisma

# 4. Clear corrupted Redis queues only as a last resort.
redis-cli -u "$REDIS_URL" FLUSHDB

# 5. Notify the team.
curl -X POST "$SLACK_WEBHOOK" -H "Content-Type: application/json" \
  -d '{"text":"Beba SACCO rollback completed - investigation in progress"}'
```

## Rollback Triggers

| Metric                                   | Threshold            | Action                                                     |
| ---------------------------------------- | -------------------- | ---------------------------------------------------------- |
| Error rate `/documents/*`                | >1% over 5 min       | Disable `FEATURE_SECURE_UPLOAD_V2`                         |
| BullMQ queue depth `document.virus-scan` | >1000 pending        | Disable `FEATURE_VIRUS_SCAN`                               |
| Cross-tenant false negatives after RLS   | Any confirmed case   | Disable `FEATURE_RLS_ENFORCEMENT`                          |
| KYC status alias mismatch                | Any critical flow    | Disable `FEATURE_KYC_STATUS_ALIAS`                         |
| PostgreSQL connection errors             | >3 in 1 min          | Roll back to previous Git tag                              |
| Sentry critical alerts                   | Any `level=critical` | Investigate immediately; roll back if unresolved in 10 min |
| Health check failures                    | 3 consecutive        | Roll back or redeploy last known-good version              |
| Sentry trace volume or latency spike     | >5% latency increase | Set `SENTRY_TRACES_SAMPLE_RATE=0`                          |
| Debug logging volume too high            | Log drain saturated  | Set `LOG_LEVEL=info`                                       |

## Diagnostic Commands

```bash
# Check current feature flag state.
render env get -e production -s beba-sacco-api | grep FEATURE_

# View recent deployments.
render deployments list beba-sacco-api --limit 5

# Query recent document errors from Render logs.
render logs beba-sacco-api --query 'level:error AND module:documents' --since 5m

# Check BullMQ queue state.
redis-cli -u "$REDIS_URL" LLEN bull:document.virus-scan:wait
redis-cli -u "$REDIS_URL" LLEN bull:document.virus-scan:failed

# Verify DB migration state.
npx prisma migrate status --schema=src/prisma/schema.prisma

# Confirm RLS rollout state.
render env get -e production -s beba-sacco-api | grep FEATURE_RLS_ENFORCEMENT

# Emergency RLS database bypass for staging diagnostics only.
psql "$DATABASE_URL" -c "SELECT set_config('app.rls_enabled', 'false', false);"

# Disable Phase 3 tracing without code rollback.
render env set -e production -s beba-sacco-api SENTRY_TRACES_SAMPLE_RATE=0
render env set -e production -s beba-sacco-api LOG_LEVEL=info
```

## Post-Rollback Validation

1. Confirm `/api/health` returns `status: ok` with database, Redis, and storage checks green.
2. Verify the legacy upload flow works: create test member, request upload URL, upload document, confirm upload.
3. Check Sentry for error-rate drop below 0.1%.
4. Validate audit logs still capture document upload and review events.
5. Confirm error responses still include `correlationId`.
6. Notify QA to resume UAT testing.

## Phase 3 Observability Rollback

Phase 3 changes are additive. Prefer these switches before reverting code:

```bash
# Reduce trace volume to zero while keeping error capture enabled.
render env set -e production -s beba-sacco-api SENTRY_TRACES_SAMPLE_RATE=0

# Return logs to production baseline verbosity.
render env set -e production -s beba-sacco-api LOG_LEVEL=info
```

Frontend upload polish has no feature flag because it preserves the existing API contract. If a UI-only regression appears, redeploy the previous Netlify build while keeping backend flags unchanged.

## Escalation Contacts

| Role               | Contact         | SLA                        |
| ------------------ | --------------- | -------------------------- |
| Backend Lead       | @christopher    | 15 min                     |
| DevOps             | @devops-channel | 30 min                     |
| Product Owner      | @product        | 1 hour                     |
| Compliance Officer | @compliance     | 2 hours for data incidents |
