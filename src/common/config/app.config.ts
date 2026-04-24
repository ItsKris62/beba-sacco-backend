import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  // Application
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  apiPrefix: process.env.API_PREFIX || 'api',
  appName: process.env.APP_NAME || 'Beba SACCO Backend',
  appVersion: process.env.APP_VERSION || '1.0.0',
  /** Frontend base URL — used to build password reset links in emails */
  appUrl: process.env.APP_URL || 'http://localhost:3001',

  // Database
  databaseUrl: process.env.DATABASE_URL,

  // JWT
  jwt: {
    secret: process.env.JWT_SECRET,
    accessExpiration: process.env.JWT_ACCESS_EXPIRATION || '15m',
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    refreshExpiration: process.env.JWT_REFRESH_EXPIRATION || '7d',
  },

  // Redis (Upstash) – ioredis TCP connection
  redis: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
    tls: process.env.REDIS_TLS === 'true',
    // Upstash REST API (for lightweight HTTP-based reads outside ioredis)
    restUrl: process.env.UPSTASH_REDIS_REST_URL,
    restToken: process.env.UPSTASH_REDIS_REST_TOKEN,
  },

  // Cloudflare R2
  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucketName: process.env.R2_BUCKET_NAME,
    publicUrl: process.env.R2_PUBLIC_URL,
  },

  // Tinybird
  tinybird: {
    apiUrl: process.env.TINYBIRD_API_URL || 'https://api.tinybird.co',
    token: process.env.TINYBIRD_TOKEN,
  },

  // Sentry
  sentry: {
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
  },

  // M-Pesa (Safaricom Daraja)
  mpesa: {
    consumerKey: process.env.MPESA_CONSUMER_KEY,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET,
    passkey: process.env.MPESA_PASSKEY,
    shortcode: process.env.MPESA_SHORTCODE || '174379',
    b2cShortcode: process.env.MPESA_B2C_SHORTCODE || process.env.MPESA_SHORTCODE || '600000',
    initiatorName: process.env.MPESA_INITIATOR_NAME || 'testapi',
    securityCredential: process.env.MPESA_SECURITY_CREDENTIAL,
    callbackUrl: process.env.MPESA_CALLBACK_URL,
    b2cResultUrl: process.env.MPESA_B2C_RESULT_URL || process.env.MPESA_CALLBACK_URL,
    b2cQueueTimeoutUrl: process.env.MPESA_B2C_QUEUE_TIMEOUT_URL || process.env.MPESA_CALLBACK_URL,
    environment: process.env.MPESA_ENVIRONMENT || 'sandbox',
    webhookSecret: process.env.MPESA_WEBHOOK_SECRET,
    allowedIps: (process.env.MPESA_ALLOWED_IPS || '').split(',').map((ip) => ip.trim()).filter(Boolean),
    stkRateLimitPerDay: parseInt(process.env.MPESA_STK_RATE_LIMIT_PER_DAY || '3', 10),
  },

  // Plunk Transactional Email
  plunk: {
    apiKey: process.env.PLUNK_API_KEY,
    fromEmail: process.env.PLUNK_FROM_EMAIL || 'noreply@beba-sacco.com',
    fromName: process.env.PLUNK_FROM_NAME || 'Beba SACCO',
  },

  // Security
  cors: {
    origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3001'],
  },
  rateLimit: {
    ttl: parseInt(process.env.RATE_LIMIT_TTL || '60', 10),
    limit: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  },

  // Multi-Tenancy
  defaultTenantId: process.env.DEFAULT_TENANT_ID,
}));
