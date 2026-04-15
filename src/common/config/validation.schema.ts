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
  // Application
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test', 'staging')
    .default('development'),
  PORT: Joi.number().default(3000),
  API_PREFIX: Joi.string().default('api'),

  // Database
  DATABASE_URL: Joi.string().required(),

  // JWT
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),

  // Redis (Upstash)
  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().required(),
  REDIS_TLS: Joi.boolean().default(true),

  // Cloudflare R2
  R2_ACCOUNT_ID: Joi.string().required(),
  R2_ACCESS_KEY_ID: Joi.string().required(),
  R2_SECRET_ACCESS_KEY: Joi.string().required(),
  R2_BUCKET_NAME: Joi.string().required(),
  R2_PUBLIC_URL: Joi.string().uri().required(),

  // Tinybird
  TINYBIRD_API_URL: Joi.string().uri().default('https://api.tinybird.co'),
  TINYBIRD_TOKEN: Joi.string().required(),

  // Sentry
  SENTRY_DSN: Joi.string().uri().optional(),
  SENTRY_ENVIRONMENT: Joi.string().optional(),

  // M-Pesa (optional for development)
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
  MPESA_PASSKEY: Joi.string().optional(),
  MPESA_SHORTCODE: Joi.string().default('174379'),
  MPESA_INITIATOR_NAME: Joi.string().default('testapi'),
  MPESA_SECURITY_CREDENTIAL: Joi.string().optional(),
  MPESA_CALLBACK_URL: Joi.string().uri().optional(),
  MPESA_ENVIRONMENT: Joi.string().valid('sandbox', 'production').default('sandbox'),
  MPESA_WEBHOOK_SECRET: Joi.string().optional(),

  // Plunk Transactional Email
  PLUNK_API_KEY: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  PLUNK_FROM_EMAIL: Joi.string().email().default('noreply@beba-sacco.com'),
  PLUNK_FROM_NAME: Joi.string().default('Beba SACCO'),

  // CORS
  CORS_ORIGIN: Joi.string().default('http://localhost:3001'),

  // Rate Limiting
  RATE_LIMIT_TTL: Joi.number().default(60),
  RATE_LIMIT_MAX: Joi.number().default(100),

  // Multi-Tenancy
  DEFAULT_TENANT_ID: Joi.string().optional(),

  // Phase 4 – Data Retention (Kenya Data Protection Act)
  DATA_RETENTION_YEARS: Joi.number().integer().min(1).default(7),

  // Phase 4 – Alerting
  SLACK_WEBHOOK_URL: Joi.string().uri().optional(),
  PAGERDUTY_INTEGRATION_KEY: Joi.string().optional(),

  // Phase 4 – MinIO/S3 Backups
  MINIO_ENDPOINT: Joi.string().uri().optional(),
  MINIO_BUCKET: Joi.string().optional(),
  MINIO_ACCESS_KEY: Joi.string().optional(),
  MINIO_SECRET_KEY: Joi.string().optional(),
  BACKUP_RETENTION_DAYS: Joi.number().integer().min(1).default(30),

  // Phase 4 – BullMQ clustering (optional overrides)
  BULLMQ_CONCURRENCY_ACCRUAL: Joi.number().integer().default(3),
  BULLMQ_CONCURRENCY_RECON: Joi.number().integer().default(2),
  BULLMQ_CONCURRENCY_LEDGER: Joi.number().integer().default(2),
  BULLMQ_CONCURRENCY_WEBHOOK: Joi.number().integer().default(10),
});

