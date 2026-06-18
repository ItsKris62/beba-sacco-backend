# Beba SACCO Deployment Checklist

## Render Services

Deploy `backend/render.yaml` as a Render Blueprint. It provisions:

- Managed PostgreSQL: `beba-postgres`
- Managed Redis: `beba-redis`
- Web service: `beba-api`
- Background worker: `beba-worker`

The worker must remain a separate Render service from the API. BullMQ processors should run only in the worker so API traffic cannot starve repayment, reminder, reconciliation, webhook, and recovery jobs.

## Backend Environment

Set these on both `beba-api` and `beba-worker` unless noted otherwise. Use Render generated values or secret dashboard values; do not commit real secrets.

Core:

```env
NODE_ENV=production
DATABASE_URL=<render-postgres-connection-string>
DIRECT_URL=<render-postgres-direct-connection-string>
REDIS_URL=<render-redis-connection-string>
BULL_REDIS_URL=<render-redis-connection-string>
REDIS_TLS=true
JWT_SECRET=<64-byte-random-secret>
JWT_REFRESH_SECRET=<different-64-byte-random-secret>
AUDIT_HMAC_SECRET=<64-char-hex-secret>
CORS_ORIGIN=https://<vercel-frontend-domain>
APP_URL=https://<vercel-frontend-domain>
FRONTEND_URL=https://<vercel-frontend-domain>
```

M-Pesa:

```env
MPESA_CONSUMER_KEY=<daraja-consumer-key>
MPESA_CONSUMER_SECRET=<daraja-consumer-secret>
MPESA_PASSKEY=<daraja-passkey>
MPESA_SHORTCODE=<stk-shortcode>
MPESA_B2C_SHORTCODE=<b2c-shortcode>
MPESA_INITIATOR_NAME=<initiator-name>
MPESA_SECURITY_CREDENTIAL=<encrypted-security-credential>
MPESA_ENVIRONMENT=production
MPESA_CALLBACK_URL=https://<render-api-domain>/api
MPESA_B2C_RESULT_URL=https://<render-api-domain>/api/mpesa/webhooks/b2c-result
MPESA_B2C_QUEUE_TIMEOUT_URL=https://<render-api-domain>/api/mpesa/webhooks/b2c-timeout
MPESA_WEBHOOK_SECRET=<64-char-hex-secret>
MPESA_ALLOWED_IPS=<safaricom-ip-allowlist>
MPESA_STK_RATE_LIMIT_PER_DAY=3
```

Object storage, SMS, and email:

```env
MINIO_ENDPOINT=<s3-compatible-endpoint-if-using-minio>
MINIO_ACCESS_KEY=<minio-access-key>
MINIO_SECRET_KEY=<minio-secret-key>
MINIO_BUCKET=<bucket-name>
R2_ACCOUNT_ID=<cloudflare-account-id>
R2_ACCESS_KEY_ID=<r2-access-key-id>
R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
R2_BUCKET_NAME=<r2-bucket-name>
R2_PUBLIC_URL=<public-r2-url>
AFRICAS_TALKING_USERNAME=<sms-username>
AFRICAS_TALKING_API_KEY=<sms-api-key>
AFRICAS_TALKING_SENDER_ID=<sms-sender-id>
AWS_SES_ACCESS_KEY_ID=<ses-access-key-if-using-ses>
AWS_SES_SECRET_ACCESS_KEY=<ses-secret-key-if-using-ses>
AWS_SES_REGION=<ses-region>
AWS_SES_FROM_EMAIL=<verified-from-email>
PLUNK_API_KEY=<plunk-public-key-if-using-plunk>
PLUNK_SECRET_KEY=<plunk-secret-key-if-using-plunk>
PLUNK_FROM_EMAIL=<verified-from-email>
```

Operational:

```env
ENABLE_PRODUCT_RULES=true
FEATURE_EMAIL_VERIFICATION_ENFORCED=true
DATA_RETENTION_YEARS=7
SENTRY_DSN=<sentry-dsn>
SENTRY_ENVIRONMENT=production
TINYBIRD_TOKEN=<tinybird-token>
SLACK_WEBHOOK_URL=<slack-webhook-url>
PAGERDUTY_INTEGRATION_KEY=<pagerduty-key>
BULLMQ_CONCURRENCY_ACCRUAL=3
BULLMQ_CONCURRENCY_RECON=2
BULLMQ_CONCURRENCY_LEDGER=2
BULLMQ_CONCURRENCY_WEBHOOK=10
```

## Vercel Frontend Environment

Set these in the Vercel project for `beba-app-frontend`:

```env
NEXT_PUBLIC_API_URL=https://<render-api-domain>/api
NEXT_PUBLIC_APP_URL=https://<vercel-frontend-domain>
NEXT_PUBLIC_MINIO_PUBLIC_URL=<public-object-storage-url>
NEXT_PUBLIC_TENANT_ID=<default-tenant-uuid-if-required>
```

The frontend should use absolute API URLs from `NEXT_PUBLIC_API_URL`. The included `vercel.json` rewrites `/api/*` to the Render backend as a compatibility fallback.

## Release Order

1. Deploy Render Blueprint.
2. Set all required Render secrets.
3. Confirm `beba-api` pre-deploy migration succeeds.
4. Confirm `beba-worker` is running separately.
5. Deploy Vercel frontend with `NEXT_PUBLIC_API_URL` pointed at Render.
6. Smoke-test auth, member dashboard, loan application, support tickets, statements, M-Pesa callback health, and queue processing.
