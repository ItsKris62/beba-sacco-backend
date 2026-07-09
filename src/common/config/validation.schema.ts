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
  API_PREFIX: Joi.string().default('api/v1'),
  // Frontend base URL — used in password-reset email links.
  // Must be HTTPS in production to prevent reset tokens being sent over plain HTTP.
  APP_URL: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string()
      .uri()
      .pattern(/^https:\/\//)
      .required()
      .messages({
        'string.pattern.base':
          'APP_URL must use HTTPS in production (got HTTP or missing protocol)',
      }),
    otherwise: Joi.string().uri().required(),
  }),

  // ── Database (Neon PostgreSQL) ─────────────────────────────────────────────
  // DATABASE_URL  = pooler URL  (PgBouncer, for runtime queries + BullMQ)
  // DIRECT_URL    = direct URL  (bypasses PgBouncer, required for migrations and
  //                              $transaction calls with explicit isolationLevel)
  DATABASE_URL: Joi.string().required(),
  DIRECT_URL: Joi.string().required(),
  DATABASE_DIRECT_URL: Joi.string().optional(),
  WORKER_MODE: Joi.boolean().truthy('true').falsy('false').default(false),
  FEATURE_ADVANCED_FINANCIAL_JOBS: Joi.boolean().truthy('true').falsy('false').default(false),
  PHASE_4_ENABLED: Joi.boolean().truthy('true').falsy('false').optional(),

  // ── JWT ────────────────────────────────────────────────────────────────────
  JWT_SECRET: Joi.string().min(64).required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(64).required(),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),

  // ── Redis (Upstash) – application cache ───────────────────────────────────
  // password & TLS optional for local dev (no-auth Redis container)
  REDIS_HOST: Joi.string().when('REDIS_URL', {
    is: Joi.exist(),
    then: Joi.optional(),
    otherwise: Joi.required(),
  }),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  REDIS_TLS: Joi.boolean().default(false),
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).optional(),
  UPSTASH_REDIS_REST_URL: Joi.string().uri().optional(),
  UPSTASH_REDIS_REST_TOKEN: Joi.string().allow('').optional(),

  // ── Redis (BullMQ queues) – must be separate from app Redis in production
  // Use either BULL_REDIS_URL or BULL_REDIS_HOST/PORT/PASSWORD/TLS.
  // Format: redis://:password@host:port or rediss://:password@host:port (TLS)
  BULL_REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .when('BULL_REDIS_HOST', {
      is: Joi.exist(),
      then: Joi.optional(),
      otherwise: Joi.when('NODE_ENV', {
        is: 'production',
        then: Joi.required(),
        otherwise: Joi.optional(),
      }),
    }),
  BULL_REDIS_HOST: Joi.string().optional(),
  BULL_REDIS_PORT: Joi.number().default(6379),
  BULL_REDIS_PASSWORD: Joi.string().allow('').optional(),
  BULL_REDIS_TLS: Joi.boolean().default(false),

  SWAGGER_USER: Joi.string().optional(),
  SWAGGER_PASSWORD: Joi.string().optional(),

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
  // HMAC secret for validating Safaricom callback signatures.
  // Optional at startup so the app can boot before the client supplies the secret.
  // The webhook controllers enforce this at invocation time in production:
  // - absent in production → 503 on any incoming Daraja webhook
  // - absent in non-production → warning logged, validation skipped (sandbox safe)
  MPESA_WEBHOOK_SECRET: Joi.string().min(32).optional(),
  MPESA_CALLBACK_REPLAY_TTL_SECONDS: Joi.number().integer().min(60).default(900),
  MPESA_CALLBACK_MAX_SKEW_SECONDS: Joi.number().integer().min(30).default(300),
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
  EMAIL_IGNORE_DELIVERY_FAILURES: Joi.boolean().truthy('true').falsy('false').default(false),

  // ── CORS & Security ────────────────────────────────────────────────────────
  CORS_ORIGIN: Joi.string().required(),
  RATE_LIMIT_TTL: Joi.number().default(60),
  RATE_LIMIT_MAX: Joi.number().default(100),
  METRICS_API_KEY: Joi.string().min(32).optional(),
  IDEMPOTENCY_TTL_SECONDS: Joi.number().integer().min(60).default(3600),
  AUDIT_HMAC_SECRET: Joi.string().min(32).optional(),

  // Product rules must be explicitly enabled so loan-product configuration
  // controls guarantor counts, account type, coverage ratio, and savings limits.
  ENABLE_PRODUCT_RULES: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .valid(true)
    .required()
    .messages({
      'any.only': 'ENABLE_PRODUCT_RULES must be true for production loan-rule enforcement',
      'any.required': 'ENABLE_PRODUCT_RULES is required and must be true',
    }),
  FEATURE_EMAIL_VERIFICATION_ENFORCED: Joi.boolean().truthy('true').falsy('false').default(true),
  SMS_OTP_BYPASS_ADMIN_CREATED: Joi.boolean().truthy('true').falsy('false').default(false),

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

  // ── Africa's Talking SMS ───────────────────────────────────────────────────
  AFRICAS_TALKING_USERNAME: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  AFRICAS_TALKING_API_KEY: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  AFRICAS_TALKING_SENDER_ID: Joi.string().optional(),
  SMS_IGNORE_DELIVERY_FAILURES: Joi.boolean().truthy('true').falsy('false').default(false),

  // ── BullMQ Worker Concurrency ──────────────────────────────────────────────
  BULLMQ_CONCURRENCY_ACCRUAL: Joi.number().integer().default(3),
  BULLMQ_CONCURRENCY_RECON: Joi.number().integer().default(2),
  BULLMQ_CONCURRENCY_LEDGER: Joi.number().integer().default(2),
  BULLMQ_CONCURRENCY_WEBHOOK: Joi.number().integer().default(10),
});

