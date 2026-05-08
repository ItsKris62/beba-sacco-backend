# Beba SACCO — Security & Tenant Isolation Audit Checklist (Phase C)

## Manual Verification Commands

| # | Command | Expected Outcome | Status |
|---|---------|-----------------|--------|
| 1 | `grep -rn "tenantId" src/modules/loans/loans.service.ts` | Every `.find*`, `.create`, `.update` includes `tenantId` | ⬜ |
| 2 | `grep -n "ThrottlerGuard" src/app.module.ts` | `ThrottlerGuard` registered as `APP_GUARD` | ⬜ |
| 3 | `grep -n "APP_GUARD.*RBACGuard" src/app.module.ts` | `RBACGuard` registered as `APP_GUARD` | ⬜ |
| 4 | `grep -n "helmet" src/main.ts` | Helmet middleware configured before routes | ⬜ |
| 5 | `grep -n "IdempotencyMiddleware" src/app.module.ts` | Middleware applied in `configure()` | ⬜ |
| 6 | `grep -A5 "redact:" src/app.module.ts` | `authorization`, `password`, `refreshToken` redacted | ⬜ |
| 7 | `bash scripts/verify-tenant-isolation.sh` | Exits `0` with zero false positives | ⬜ |
| 8 | `npm run test:e2e` | All dashboard, loan, report tests pass | ⬜ |
| 9 | `docker build -t beba-sacco:phase-c .` | Build succeeds with non-root user | ⬜ |
| 10 | `docker compose -f docker-compose.prod.yml config` | Compose file validates without errors | ⬜ |
| 11 | `grep -rn "Serial" src/modules/loans/loans.service.ts` | `Serializable` transaction on `disburse()` | ⬜ |
| 12 | `grep -rn "optimistic" src/modules/loans/loans.service.ts` | Version check on Account before update | ⬜ |
| 13 | `grep -rn "X-Idempotency-Key" src/modules/loans/loan-admin.controller.ts` | Header documented on review endpoint | ⬜ |
| 14 | `grep -rn "problem+json" src/common/filters/global-exception.filter.ts` | Content-Type set correctly | ⬜ |
| 15 | `grep -rn "correlationId" src/common/filters/global-exception.filter.ts` | Correlation ID included in response | ⬜ |

## Automated Scan Results

Run `bash scripts/verify-tenant-isolation.sh` to populate:

```
═══════════════════════════════════════════════════════════════════════════════
Audit Summary
═══════════════════════════════════════════════════════════════════════════════
  Total checks:  XX
  Passed:        XX
  Failed:        XX
```

## PII Redaction Patterns

The following fields MUST be redacted in all log outputs:

| Field | Pattern | Location |
|-------|---------|----------|
| Authorization header | `req.headers.authorization` | pino redact config |
| Passwords | `req.body.password` | pino redact config |
| Current password | `req.body.currentPassword` | pino redact config |
| New password | `req.body.newPassword` | pino redact config |
| Refresh token | `req.body.refreshToken` | pino redact config |
| Access token JTI | `req.body.accessTokenJti` | pino redact config |
| Phone numbers | `2547XXXXXXXX` | Logger middleware (mask last 4 digits) |
| ID numbers | `\d{7,8}` | Logger middleware (mask middle digits) |
| Account balances | `balance: \d+` | Logger middleware (round to nearest 100) |

## Rate Limiting Configuration

| Endpoint | TTL | Limit | Strategy |
|----------|-----|-------|----------|
| `POST /auth/login` | 60s | 5 | IP-based |
| `POST /auth/register` | 60s | 3 | IP-based |
| `POST /mpesa/webhooks/*` | 60s | 100 | IP-based (Safaricom CIDR) |
| `POST /admin/reports/generate` | 60s | 10 | User-based |
| `POST /members/deposit/mpesa` | 86400s | 3 | Member-based |

## RBAC Matrix

| Endpoint | SUPER_ADMIN | TENANT_ADMIN | MANAGER | LOAN_OFFICER | MEMBER |
|----------|:-----------:|:------------:|:-------:|:------------:|:------:|
| `GET /admin/dashboard/stats` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `GET /admin/dashboard/reports` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `PATCH /admin/loans/:id/review` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `POST /admin/reports/generate` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `GET /members/dashboard` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `POST /members/loans/apply` | ❌ | ❌ | ❌ | ❌ | ✅ |
| `POST /members/deposit/mpesa` | ❌ | ❌ | ❌ | ❌ | ✅ |
