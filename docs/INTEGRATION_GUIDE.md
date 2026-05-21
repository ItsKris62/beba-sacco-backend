# Critical Production Fixes Integration Guide

## Environment

Required production variables:

```bash
MPESA_WEBHOOK_SECRET=64+ char HMAC secret shared with callback signer
MPESA_CALLBACK_REPLAY_TTL_SECONDS=900
MPESA_CALLBACK_MAX_SKEW_SECONDS=300
IDEMPOTENCY_TTL_SECONDS=3600
AUDIT_HMAC_SECRET=64+ char audit-chain HMAC root secret
BULL_REDIS_URL=redis://:password@host:6379
```

Tenant shortcode mapping lives in `Tenant.settings`:

```json
{
  "mpesa": {
    "shortcode": "174379",
    "businessShortCode": "174379",
    "c2bShortcode": "174379"
  }
}
```

For shared shortcodes, prefix account references with the tenant slug or tenant id:

```text
test-sacco:ACC-FOSA-000001
```

## Database

Apply the SQL migration:

```bash
psql "$DIRECT_URL" -f prisma/migrations/P0_audit_chain_and_idempotency.sql
npm run prisma:generate
```

The migration creates:

- `AuditEvent`: append-only cryptographic audit events.
- `AuditChainHead`: one row per tenant, locked with `SELECT ... FOR UPDATE`.
- `audit_archive_manifests`: append-only retention manifests pointing to WORM storage.

Do not update or delete `AuditEvent` rows. Retention creates manifests only.

## Redis and BullMQ

Use connection-based Redis for BullMQ through `BULL_REDIS_URL`. The new queues are:

- `mpesa-callback`
- `mpesa-callback-dlq`
- `audit-persist`
- `audit-persist-dlq`

All audit writes use retries and dead-letter routing. HTTP request handling never waits for audit persistence.

## M-PESA Callback Contract

Safaricom callback URL:

```text
https://YOUR_HOST/api/mpesa/callback
```

Headers:

```text
X-Mpesa-Signature: hex HMAC-SHA256(rawBody, MPESA_WEBHOOK_SECRET)
X-Mpesa-Timestamp: ISO timestamp or epoch milliseconds
```

The endpoint is `@Public()`, bypasses tenant middleware, returns:

```json
{ "ResultCode": 0, "ResultDesc": "Accepted" }
```

Invalid signatures, stale timestamps, replays, and unresolved tenants are logged and not enqueued.

## Idempotency

Send `X-Idempotency-Key` on mutating requests. The cache key format is:

```text
idem:{tenantId}:{userId}:{method}:{path}:{sha256(body)}:{idempotencyKey}
```

The middleware returns `409 IDEMPOTENCY_KEY_MISMATCH` when a key is reused with a different body.

## Audit Chain Verification

Use `AuditChainService.verifyTenantChain(tenantId)` in admin tooling or smoke tests. Verification fails when:

- `prevHash` does not match the previous `eventHash`.
- Recomputed event hash differs.
- HMAC signature mismatches `AUDIT_HMAC_SECRET`.

## Swagger

The M-PESA callback operation documents:

- `X-Mpesa-Signature`
- `X-Mpesa-Timestamp`

All protected endpoints still require `Authorization` and `X-Tenant-ID`.
