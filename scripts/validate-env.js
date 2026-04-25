#!/usr/bin/env node
/**
 * validate-env.js
 *
 * Post-rotation environment variable validation script.
 * Run BEFORE deploying to confirm all required vars are set and meet
 * minimum strength requirements — without printing any secret values.
 *
 * Usage:
 *   node scripts/validate-env.js             # validates process.env (Render context)
 *   node -r dotenv/config scripts/validate-env.js  # validates local .env file
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = one or more checks failed (check output for details)
 */

'use strict';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RESET  = '\x1b[0m';
const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';

let passed = 0;
let failed = 0;
let warned = 0;

function ok(name, detail = '') {
  passed++;
  console.log(`  ${GREEN}✅ PASS${RESET}  ${name}${detail ? `  (${detail})` : ''}`);
}

function fail(name, reason) {
  failed++;
  console.log(`  ${RED}❌ FAIL${RESET}  ${name}  → ${reason}`);
}

function warn(name, reason) {
  warned++;
  console.log(`  ${YELLOW}⚠️  WARN${RESET}  ${name}  → ${reason}`);
}

function section(title) {
  console.log(`\n${BOLD}${CYAN}── ${title} ──${RESET}`);
}

function check(name, { required = true, minLen = 0, notContains = [], isUrl = false, isEnum = null, notEqual = null } = {}) {
  const val = process.env[name];

  if (!val || val.trim() === '') {
    if (required) {
      fail(name, 'Missing or empty (required)');
    } else {
      warn(name, 'Not set (optional — set for full functionality)');
    }
    return;
  }

  // Check for unfilled placeholder values
  const placeholders = [
    'REPLACE_WITH', 'your-', 'change_me', 'YOUR_', 'placeholder',
    'your_', 'example', 'REPLACE', 'TODO',
  ];
  for (const p of placeholders) {
    if (val.toLowerCase().includes(p.toLowerCase())) {
      fail(name, `Contains placeholder text "${p}" — replace with a real value`);
      return;
    }
  }

  // Minimum length
  if (minLen > 0 && val.length < minLen) {
    fail(name, `Too short: ${val.length} chars (minimum ${minLen})`);
    return;
  }

  // URL validation
  if (isUrl) {
    try {
      const u = new URL(val);
      if (!['http:', 'https:'].includes(u.protocol)) {
        fail(name, `Invalid protocol "${u.protocol}" — must be http or https`);
        return;
      }
    } catch {
      fail(name, 'Not a valid URL');
      return;
    }
  }

  // Enum validation
  if (isEnum && !isEnum.includes(val)) {
    fail(name, `"${val}" is not one of: ${isEnum.join(', ')}`);
    return;
  }

  // Must not equal another variable (e.g. JWT secrets must differ)
  if (notEqual) {
    const other = process.env[notEqual];
    if (other && val === other) {
      fail(name, `Must be different from ${notEqual}`);
      return;
    }
  }

  // Banned values — known leaked secrets (partial match on first 8 chars)
  const bannedPrefixes = notContains;
  for (const banned of bannedPrefixes) {
    if (val.startsWith(banned)) {
      fail(name, `Contains a known compromised value — rotate immediately`);
      return;
    }
  }

  ok(name, `${val.length} chars`);
}

// ─── Main validation ──────────────────────────────────────────────────────────

console.log(`\n${BOLD}Beba SACCO — Environment Variable Validator${RESET}`);
console.log(`Timestamp: ${new Date().toISOString()} (EAT = UTC+3)`);
console.log(`NODE_ENV: ${process.env.NODE_ENV ?? 'not set'}`);

const isProduction = process.env.NODE_ENV === 'production';

// ── Application ───────────────────────────────────────────────────────────────
section('Application');
check('NODE_ENV',    { required: true, isEnum: ['development', 'production', 'staging', 'test'] });
check('PORT',        { required: false });
check('API_PREFIX',  { required: false });
check('APP_URL',     { required: true, isUrl: true });

// ── Database ──────────────────────────────────────────────────────────────────
section('Database (Neon PostgreSQL)');

// Detect old password in DATABASE_URL
const dbUrl = process.env.DATABASE_URL ?? '';
if (dbUrl.includes('npg_JOuCMRct31NU')) {
  fail('DATABASE_URL', '⛔ Contains the compromised password "npg_JOuCMRct31NU" — rotate NOW');
} else {
  check('DATABASE_URL',  { required: true, minLen: 50 });
}

const directUrl = process.env.DIRECT_URL ?? '';
if (directUrl.includes('npg_JOuCMRct31NU')) {
  fail('DIRECT_URL', '⛔ Contains the compromised password "npg_JOuCMRct31NU" — rotate NOW');
} else {
  check('DIRECT_URL', { required: true, minLen: 50 });
}

// Validate pooler vs direct URL structure
if (dbUrl && directUrl) {
  const dbHasPooler    = dbUrl.includes('-pooler.');
  const directHasPooler = directUrl.includes('-pooler.');
  if (!dbHasPooler)    warn('DATABASE_URL',  'Missing "-pooler." in hostname — should use pooler URL for runtime');
  if (directHasPooler) warn('DIRECT_URL',    'Contains "-pooler." in hostname — should use DIRECT (non-pooler) URL');
  if (dbHasPooler && !directHasPooler) ok('DATABASE_URL vs DIRECT_URL', 'Pooler/direct split is correct');
}

// ── JWT ───────────────────────────────────────────────────────────────────────
section('JWT Authentication');

const knownLeakedJwtPrefix = 'KNtBLDWM';
const knownLeakedRefreshPrefix = 'Vz/SaJ+R';

const jwtSecret = process.env.JWT_SECRET ?? '';
if (jwtSecret.startsWith(knownLeakedJwtPrefix)) {
  fail('JWT_SECRET', '⛔ Known compromised value detected — rotate immediately');
} else {
  check('JWT_SECRET',         { required: true, minLen: 64, notEqual: 'JWT_REFRESH_SECRET' });
}

const refreshSecret = process.env.JWT_REFRESH_SECRET ?? '';
if (refreshSecret.startsWith(knownLeakedRefreshPrefix)) {
  fail('JWT_REFRESH_SECRET', '⛔ Known compromised value detected — rotate immediately');
} else {
  check('JWT_REFRESH_SECRET', { required: true, minLen: 64 });
}

check('JWT_ACCESS_EXPIRATION',  { required: false });
check('JWT_REFRESH_EXPIRATION', { required: false });

// ── Redis ─────────────────────────────────────────────────────────────────────
section('Redis (Upstash)');

const knownLeakedRedisPrefix = 'gQAAAAA';
const redisPass = process.env.REDIS_PASSWORD ?? '';
if (redisPass.startsWith(knownLeakedRedisPrefix)) {
  fail('REDIS_PASSWORD', '⛔ Known compromised value detected — rotate immediately');
} else {
  check('REDIS_PASSWORD',           { required: true, minLen: 20 });
}

check('REDIS_HOST',               { required: true, minLen: 10 });
check('REDIS_PORT',               { required: false });
check('REDIS_TLS',                { required: false, isEnum: ['true', 'false'] });
check('UPSTASH_REDIS_REST_URL',   { required: false, isUrl: true });
check('UPSTASH_REDIS_REST_TOKEN', { required: false, minLen: 20 });

if (isProduction && process.env.REDIS_TLS !== 'true') {
  fail('REDIS_TLS', 'Must be "true" in production — Upstash requires TLS');
}

// ── Cloudflare R2 ─────────────────────────────────────────────────────────────
section('Cloudflare R2 Storage');

const knownLeakedR2Prefix = 'cfat_ASe';
const r2Secret = process.env.R2_SECRET_ACCESS_KEY ?? '';
if (r2Secret.startsWith(knownLeakedR2Prefix)) {
  fail('R2_SECRET_ACCESS_KEY', '⛔ Known compromised value detected — rotate immediately');
} else {
  check('R2_SECRET_ACCESS_KEY', { required: true, minLen: 20 });
}

// Check R2_ACCOUNT_ID ≠ R2_ACCESS_KEY_ID (they were identical in the leaked file)
const r2AccountId = process.env.R2_ACCOUNT_ID ?? '';
const r2KeyId     = process.env.R2_ACCESS_KEY_ID ?? '';
if (r2AccountId && r2KeyId && r2AccountId === r2KeyId) {
  fail('R2_ACCOUNT_ID vs R2_ACCESS_KEY_ID',
    'Both are identical — R2_ACCOUNT_ID should be your Cloudflare Account ID, R2_ACCESS_KEY_ID should be the token key. Re-check after rotation.');
} else {
  check('R2_ACCOUNT_ID',    { required: true, minLen: 10 });
  check('R2_ACCESS_KEY_ID', { required: true, minLen: 10 });
}
check('R2_BUCKET_NAME', { required: true });
check('R2_PUBLIC_URL',  { required: true, isUrl: true });

// ── M-Pesa ────────────────────────────────────────────────────────────────────
section('M-Pesa (Safaricom Daraja)');

const knownLeakedDarajaKey = 'mdzroqz3';
const mpesaKey = process.env.MPESA_CONSUMER_KEY ?? '';
if (mpesaKey.startsWith(knownLeakedDarajaKey)) {
  fail('MPESA_CONSUMER_KEY', '⛔ Known compromised value detected — rotate immediately');
} else {
  check('MPESA_CONSUMER_KEY',    { required: isProduction, minLen: 10 });
}

const knownLeakedDarajaSecret = 'QDvszGue';
const mpesaSecret = process.env.MPESA_CONSUMER_SECRET ?? '';
if (mpesaSecret.startsWith(knownLeakedDarajaSecret)) {
  fail('MPESA_CONSUMER_SECRET', '⛔ Known compromised value detected — rotate immediately');
} else {
  check('MPESA_CONSUMER_SECRET', { required: isProduction, minLen: 8 });
}

check('MPESA_SHORTCODE',     { required: true });
check('MPESA_ENVIRONMENT',   { required: true, isEnum: ['sandbox', 'production'] });
check('MPESA_CALLBACK_URL',  { required: isProduction, isUrl: true });

if (isProduction) {
  check('MPESA_PASSKEY',             { required: true, minLen: 20 });
  check('MPESA_SECURITY_CREDENTIAL', { required: true, minLen: 20 });
  check('MPESA_WEBHOOK_SECRET',      { required: true, minLen: 32 });
  check('MPESA_ALLOWED_IPS',         { required: true, minLen: 15 });
  check('MPESA_B2C_SHORTCODE',       { required: true });
  check('MPESA_B2C_RESULT_URL',      { required: true, isUrl: true });
  check('MPESA_B2C_QUEUE_TIMEOUT_URL', { required: true, isUrl: true });

  if (process.env.MPESA_CALLBACK_URL?.includes('localhost') ||
      process.env.MPESA_CALLBACK_URL?.includes('ngrok')) {
    fail('MPESA_CALLBACK_URL', 'Points to localhost/ngrok in production — must be your Render URL');
  }
} else {
  check('MPESA_WEBHOOK_SECRET', { required: false });
  check('MPESA_ALLOWED_IPS',    { required: false });
}

// Check for ngrok in any env (should never be in production)
if (isProduction && process.env.NGROK_AUTHTOKEN) {
  fail('NGROK_AUTHTOKEN', 'Must not be set in production — dev-only tool');
}

// ── Email ─────────────────────────────────────────────────────────────────────
section('Email (Plunk)');

const knownLeakedPlunkKey = 'pk_77c9e5';
const plunkKey = process.env.PLUNK_API_KEY ?? '';
if (plunkKey.startsWith(knownLeakedPlunkKey)) {
  fail('PLUNK_API_KEY', '⛔ Known compromised value detected — rotate immediately');
} else {
  check('PLUNK_API_KEY',    { required: isProduction });
}

const knownLeakedPlunkSecret = 'sk_9a482e';
const plunkSecret = process.env.PLUNK_SECRET_KEY ?? '';
if (plunkSecret.startsWith(knownLeakedPlunkSecret)) {
  fail('PLUNK_SECRET_KEY', '⛔ Known compromised value detected — rotate immediately');
} else {
  check('PLUNK_SECRET_KEY', { required: false });
}

check('PLUNK_FROM_EMAIL', { required: true, minLen: 5 });
check('PLUNK_FROM_NAME',  { required: false });

// ── Tinybird ──────────────────────────────────────────────────────────────────
section('Tinybird Analytics');

const knownLeakedTinybird = 'p.eyJ1IjogImUzYTY2';
const tinybirdToken = process.env.TINYBIRD_TOKEN ?? '';
if (tinybirdToken.startsWith(knownLeakedTinybird)) {
  fail('TINYBIRD_TOKEN', '⛔ Known compromised value detected — rotate immediately');
} else {
  check('TINYBIRD_TOKEN',   { required: true, minLen: 20 });
}
check('TINYBIRD_API_URL', { required: true, isUrl: true });

// ── Sentry ────────────────────────────────────────────────────────────────────
section('Sentry Error Tracking');
check('SENTRY_DSN',         { required: isProduction, isUrl: true });
check('SENTRY_ENVIRONMENT', { required: false });

// ── CORS ──────────────────────────────────────────────────────────────────────
section('CORS & Security');
const corsOrigin = process.env.CORS_ORIGIN ?? '';
if (isProduction && corsOrigin.includes('localhost')) {
  warn('CORS_ORIGIN', 'Contains localhost in production — frontend will be blocked from the SACCO domain');
}
check('CORS_ORIGIN', { required: true });

// ── Compliance ────────────────────────────────────────────────────────────────
section('Compliance');
const retentionYears = parseInt(process.env.DATA_RETENTION_YEARS ?? '7');
if (isNaN(retentionYears) || retentionYears < 7) {
  fail('DATA_RETENTION_YEARS', `Must be ≥ 7 years (SASRA/ODPC requirement). Got: ${process.env.DATA_RETENTION_YEARS}`);
} else {
  ok('DATA_RETENTION_YEARS', `${retentionYears} years ≥ 7-year SASRA minimum`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`${BOLD}Results:${RESET}`);
console.log(`  ${GREEN}Passed:  ${passed}${RESET}`);
console.log(`  ${YELLOW}Warnings: ${warned}${RESET}`);
console.log(`  ${RED}Failed:  ${failed}${RESET}`);

if (failed > 0) {
  console.log(`\n${RED}${BOLD}❌ VALIDATION FAILED — ${failed} issue(s) must be resolved before deployment.${RESET}\n`);
  process.exit(1);
} else if (warned > 0) {
  console.log(`\n${YELLOW}${BOLD}⚠️  VALIDATION PASSED WITH WARNINGS — review warnings before production traffic.${RESET}\n`);
  process.exit(0);
} else {
  console.log(`\n${GREEN}${BOLD}✅ ALL CHECKS PASSED — environment is ready for deployment.${RESET}\n`);
  process.exit(0);
}
