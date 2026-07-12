# Render Deployment Blueprint

This backend is deployed on Render without Docker. Run the HTTP API and BullMQ workers as separate Render services so web traffic does not interrupt repayment reminders, M-Pesa callbacks, guarantor recovery, reconciliation, or audit queue jobs.

## Services

`render.yaml` defines:

- `beba-api`: NestJS web service. Build with `npm install && npm run prisma:generate && npm run build`, run with `npm run start:prod`, health check at `/api/health/ping`.
- `beba-worker`: background worker using the same codebase. Build with `npm install && npm run prisma:generate && npm run build`, run with `npm run start:worker:prod`.
- `beba-postgres`: Render managed PostgreSQL.
- `beba-redis`: Render managed Redis for BullMQ, idempotency, callback replay protection, and cache-backed workflows.

## Migration Strategy

Use Render's pre-deploy command on the web service:

```bash
npm run prisma:deploy
```

That maps to:

```bash
prisma migrate deploy --schema=src/prisma/schema.prisma
```

Do not run `prisma migrate dev` in production. The worker service does not run migrations; it starts only after its own build succeeds and shares the migrated database.

## Required Web Service Environment

Set these on `beba-api`. Values marked secret must be entered through Render secret env vars or generated values, never committed.

```text
NODE_ENV=production
API_PREFIX=api
APP_URL=https://your-render-api.onrender.com
FRONTEND_URL=https://your-vercel-frontend.vercel.app
CORS_ORIGIN=https://your-vercel-frontend.vercel.app
DATABASE_URL=<from beba-postgres connectionString>
DIRECT_URL=<from beba-postgres connectionString>
REDIS_URL=<from beba-redis connectionString>
BULL_REDIS_URL=<from beba-redis connectionString>
REDIS_TLS=true
JWT_SECRET=<generated secret>
JWT_REFRESH_SECRET=<generated different secret>
JWT_ACCESS_EXPIRATION=15m
JWT_REFRESH_EXPIRATION=7d
SWAGGER_USER=<secret>
SWAGGER_PASSWORD=<secret>
AFRICAS_TALKING_USERNAME=<secret>
AFRICAS_TALKING_API_KEY=<secret>
AFRICAS_TALKING_SENDER_ID=<secret>
MPESA_CONSUMER_KEY=<secret>
MPESA_CONSUMER_SECRET=<secret>
MPESA_PASSKEY=<secret>
MPESA_SHORTCODE=<paybill or till>
MPESA_B2C_SHORTCODE=<b2c shortcode>
MPESA_INITIATOR_NAME=<initiator>
MPESA_SECURITY_CREDENTIAL=<encrypted credential>
MPESA_ENVIRONMENT=production
MPESA_CALLBACK_URL=https://your-render-api.onrender.com/api
MPESA_B2C_RESULT_URL=https://your-render-api.onrender.com/api/mpesa/webhooks/b2c-result
MPESA_B2C_QUEUE_TIMEOUT_URL=https://your-render-api.onrender.com/api/mpesa/webhooks/b2c-timeout
MPESA_WEBHOOK_SECRET=<secret>
MPESA_ALLOWED_IPS=<comma-separated Safaricom production IPs>
MPESA_STK_RATE_LIMIT_PER_DAY=3
PLUNK_API_KEY=
PLUNK_SECRET_KEY=<secret>
PLUNK_API_URL=https://next-api.useplunk.com/v1/
PLUNK_FROM_EMAIL=noreply@your-verified-domain.example
PLUNK_FROM_NAME=Beba SACCO
ENABLE_PRODUCT_RULES=true
FEATURE_EMAIL_VERIFICATION_ENFORCED=true
R2_ACCOUNT_ID=<secret>
R2_ACCESS_KEY_ID=<secret>
R2_SECRET_ACCESS_KEY=<secret>
R2_BUCKET_NAME=<bucket>
R2_PUBLIC_URL=<public bucket URL>
SENTRY_DSN=<secret>
SENTRY_ENVIRONMENT=production
TINYBIRD_TOKEN=<secret>
TINYBIRD_API_URL=https://api.europe-west2.gcp.tinybird.co
AUDIT_HMAC_SECRET=<secret>
DATA_RETENTION_YEARS=7
BULLMQ_CONCURRENCY_ACCRUAL=3
BULLMQ_CONCURRENCY_RECON=2
BULLMQ_CONCURRENCY_LEDGER=2
BULLMQ_CONCURRENCY_WEBHOOK=10
SLACK_WEBHOOK_URL=<secret optional>
PAGERDUTY_INTEGRATION_KEY=<secret optional>
```

## Required Worker Environment

Set these on `beba-worker`. `JWT_SECRET`, `JWT_REFRESH_SECRET`, `AUDIT_HMAC_SECRET`, database, Redis, M-Pesa, storage, and notification secrets must match the web service.

```text
NODE_ENV=production
WORKER_MODE=true
DATABASE_URL=<from beba-postgres connectionString>
DIRECT_URL=<from beba-postgres connectionString>
REDIS_URL=<from beba-redis connectionString>
BULL_REDIS_URL=<from beba-redis connectionString>
REDIS_TLS=true
JWT_SECRET=<same as web>
JWT_REFRESH_SECRET=<same as web>
AFRICAS_TALKING_USERNAME=<same as web>
AFRICAS_TALKING_API_KEY=<same as web>
AFRICAS_TALKING_SENDER_ID=<same as web>
MPESA_CONSUMER_KEY=<same as web>
MPESA_CONSUMER_SECRET=<same as web>
MPESA_PASSKEY=<same as web>
MPESA_SHORTCODE=<same as web>
MPESA_B2C_SHORTCODE=<same as web>
MPESA_INITIATOR_NAME=<same as web>
MPESA_SECURITY_CREDENTIAL=<same as web>
MPESA_ENVIRONMENT=production
MPESA_CALLBACK_URL=<same as web>
MPESA_B2C_RESULT_URL=<same as web>
MPESA_B2C_QUEUE_TIMEOUT_URL=<same as web>
MPESA_WEBHOOK_SECRET=<same as web>
MPESA_ALLOWED_IPS=<same as web>
PLUNK_API_KEY=
PLUNK_SECRET_KEY=<same as web>
PLUNK_API_URL=https://next-api.useplunk.com/v1/
PLUNK_FROM_EMAIL=<same as web>
PLUNK_FROM_NAME=Beba SACCO
ENABLE_PRODUCT_RULES=true
R2_ACCOUNT_ID=<same as web>
R2_ACCESS_KEY_ID=<same as web>
R2_SECRET_ACCESS_KEY=<same as web>
R2_BUCKET_NAME=<same as web>
R2_PUBLIC_URL=<same as web>
SENTRY_DSN=<same as web>
SENTRY_ENVIRONMENT=production
TINYBIRD_TOKEN=<same as web>
AUDIT_HMAC_SECRET=<same as web>
BULLMQ_CONCURRENCY_ACCRUAL=3
BULLMQ_CONCURRENCY_RECON=2
BULLMQ_CONCURRENCY_LEDGER=2
BULLMQ_CONCURRENCY_WEBHOOK=10
SLACK_WEBHOOK_URL=<same as web optional>
PAGERDUTY_INTEGRATION_KEY=<same as web optional>
```

## Backup Variables

The backup scripts use S3-compatible storage. If you schedule backups on Render, add:

```text
MINIO_ENDPOINT=<s3-compatible endpoint>
MINIO_BUCKET=<backup bucket>
MINIO_ACCESS_KEY=<secret>
MINIO_SECRET_KEY=<secret>
BACKUP_RETENTION_DAYS=30
```

## Vercel Frontend Variables

Set these in the Next.js project on Vercel:

```text
NEXT_PUBLIC_API_URL=https://your-render-api.onrender.com/api
NEXT_PUBLIC_MINIO_PUBLIC_URL=<R2_PUBLIC_URL or public storage base URL>
NEXT_PUBLIC_FRONTEND_URL=https://your-vercel-frontend.vercel.app
NEXT_PUBLIC_SENTRY_DSN=<frontend Sentry DSN optional>
```

Keep server-only secrets out of Vercel public variables. Anything prefixed with `NEXT_PUBLIC_` is visible in the browser.

## Production Smoke Checks

After deployment:

```bash
curl https://your-render-api.onrender.com/api/health/ping
curl https://your-render-api.onrender.com/api/docs
npm run test:e2e -- golden-path --runInBand
```

Run the golden-path test against a disposable staging database, not the live production tenant.
