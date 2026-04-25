import * as Joi from 'joi';

/**
 * Environment Variables Validation Schema
 *
 * Validates all required environment variables at application startup
 * Application will fail to start if validation fails (fail-fast principle)
 *
 * TODO: Phase 1 - Add validation for M-Pesa credentials
 * TODO: Phase 2 - Add validation for production-specific variables
 */
export const validationSchema = Joi.object({
  // ── Application ────────────────────────────────────────────────────────────
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test', 'staging')
    .default('development'),
  PORT: Joi.number().default(3000),
  API_PREFIX: Joi.string().default('api'),
  // Frontend base URL — used in password-reset email links; must be a real URL in prod
  APP_URL: Joi.string().uri().required(),

  // ── Database (Neon PostgreSQL) ─────────────────────────────────────────────
  // DATABASE_URL  = pooler URL  (PgBouncer, for runtime queries + BullMQ)
  // DIRECT_URL    = direct URL  (bypasses PgBouncer, required for migrations and
  //                              $transaction calls with explicit isolationLevel)
  DATABASE_URL: Joi.string().required(),
  DIRECT_URL: Joi.string().required(),

  // ── JWT ────────────────────────────────────────────────────────────────────
  JWT_SECRET: Joi.string().min(64).required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(64).required(),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),

  // ── Redis (Upstash) ────────────────────────────────────────────────────────
  // password & TLS optional for local dev (no-auth Redis container)
  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  REDIS_TLS: Joi.boolean().default(false),
  UPSTASH_REDIS_REST_URL: Joi.string().uri().optional(),
  UPSTASH_REDIS_REST_TOKEN: Joi.string().allow('').optional(),

  // ── Cloudflare R2 ──────────────────────────────────────────────────────────
  R2_ACCOUNT_ID: Joi.string().required(),
  R2_ACCESS_KEY_ID: Joi.string().required(),
  R2_SECRET_ACCESS_KEY: Joi.string().required(),
  R2_BUCKET_NAME: Joi.string().required(),
  R2_PUBLIC_URL: Joi.string().uri().required(),

  // ── Tinybird Analytics ─────────────────────────────────────────────────────
  TINYBIRD_API_URL: Joi.string().uri().default('https://api.tinybird.co'),
  TINYBIRD_TOKEN: Joi.string().required(),

  // ── Sentry Error Tracking ──────────────────────────────────────────────────
  SENTRY_DSN: Joi.string().uri().optional(),
  SENTRY_ENVIRONMENT: Joi.string().optional(),

  // ── M-Pesa (Safaricom Daraja) ──────────────────────────────────────────────
  MPESA_CONSUMER_KEY: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  MPESA_CONSUMER_SECRET: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  MPESA_SHORTCODE: Joi.string().default('174379'),
  MPESA_PASSKEY: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  MPESA_B2C_SHORTCODE: Joi.string().optional(),
  MPESA_INITIATOR_NAME: Joi.string().default('testapi'),
  MPESA_SECURITY_CREDENTIAL: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  MPESA_CALLBACK_URL: Joi.string().uri().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  MPESA_B2C_RESULT_URL: Joi.string().uri().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  MPESA_B2C_QUEUE_TIMEOUT_URL: Joi.string().uri().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  MPESA_ENVIRONMENT: Joi.string().valid('sandbox', 'production').default('sandbox'),
  // HMAC secret for validating Safaricom callback signatures (required in production)
  MPESA_WEBHOOK_SECRET: Joi.string().min(32).when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  // Comma-separated Safaricom IP allowlist (required in production for MpesaIpGuard)
  MPESA_ALLOWED_IPS: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  MPESA_STK_RATE_LIMIT_PER_DAY: Joi.number().integer().min(1).default(3),

  // ── Email (Plunk) ──────────────────────────────────────────────────────────
  PLUNK_API_KEY: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  PLUNK_SECRET_KEY: Joi.string().optional(),
  PLUNK_FROM_EMAIL: Joi.string().email().required(),
  PLUNK_FROM_NAME: Joi.string().default('Beba SACCO'),

  // ── CORS & Security ────────────────────────────────────────────────────────
  CORS_ORIGIN: Joi.string().required(),
  RATE_LIMIT_TTL: Joi.number().default(60),
  RATE_LIMIT_MAX: Joi.number().default(100),

  // ── Multi-Tenancy ──────────────────────────────────────────────────────────
  DEFAULT_TENANT_ID: Joi.string().optional(),

  // ── Compliance (Kenya Data Protection Act + SASRA) ─────────────────────────
  DATA_RETENTION_YEARS: Joi.number().integer().min(7).default(7),

  // ── Alerting ───────────────────────────────────────────────────────────────
  SLACK_WEBHOOK_URL: Joi.string().uri().optional(),
  PAGERDUTY_INTEGRATION_KEY: Joi.string().optional(),

  // ── Backup Storage (optional) ──────────────────────────────────────────────
  MINIO_ENDPOINT: Joi.string().uri().optional(),
  MINIO_BUCKET: Joi.string().optional(),
  MINIO_ACCESS_KEY: Joi.string().optional(),
  MINIO_SECRET_KEY: Joi.string().optional(),
  BACKUP_RETENTION_DAYS: Joi.number().integer().min(1).default(30),

  // ── BullMQ Worker Concurrency ──────────────────────────────────────────────
  BULLMQ_CONCURRENCY_ACCRUAL: Joi.number().integer().default(3),
  BULLMQ_CONCURRENCY_RECON: Joi.number().integer().default(2),
  BULLMQ_CONCURRENCY_LEDGER: Joi.number().integer().default(2),
  BULLMQ_CONCURRENCY_WEBHOOK: Joi.number().integer().default(10),
});
