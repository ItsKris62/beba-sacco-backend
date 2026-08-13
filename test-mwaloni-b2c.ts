/**
 * Mwaloni B2C Connectivity & Configuration Test
 *
 * Tests:
 *   1. Configuration validation (all required env vars present)
 *   2. Authentication (POST /authenticate)
 *   3. Balance fetch (POST /get-balance)
 *   4. (Optional) Small B2C send to a test phone number
 *
 * Usage:
 *   npx ts-node test-mwaloni-b2c.ts               # auth + balance only
 *   npx ts-node test-mwaloni-b2c.ts --send 254XXXXXXXXX  # also sends 1 KES to phone
 */

import * as dotenv from 'dotenv';
dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────

const config = {
  enabled: process.env.MWALONI_ENABLED === 'true',
  env: process.env.MWALONI_ENV || 'sandbox',
  debug: process.env.MWALONI_DEBUG === 'true',
  urlProduction: process.env.MWALONI_URL_PRODUCTION || 'https://wallet.mwaloni.com/api/',
  urlSandbox: process.env.MWALONI_URL_SANDBOX || 'https://wallet-stg.mwaloni.com/api/',
  serviceId: process.env.MWALONI_SERVICE_ID || '',
  username: process.env.MWALONI_USERNAME || '',
  password: process.env.MWALONI_PASSWORD || '',
  apiKey: process.env.MWALONI_API_KEY || '',
};

function getBaseUrl(): string {
  const url =
    config.env === 'production' ? config.urlProduction : config.urlSandbox;
  return url.endsWith('/') ? url : `${url}/`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mask(value: string, showChars = 4): string {
  if (value.length <= showChars) return '***';
  return value.slice(0, showChars) + '*'.repeat(value.length - showChars);
}

function separator(title: string): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'─'.repeat(60)}`);
}

// ─── Step 1: Configuration Validation ────────────────────────────────────────

function validateConfig(): boolean {
  separator('STEP 1: Configuration Validation');

  const checks: [string, string, boolean][] = [
    ['MWALONI_ENABLED', config.enabled.toString(), config.enabled],
    ['MWALONI_ENV', config.env, ['sandbox', 'production'].includes(config.env)],
    ['MWALONI_SERVICE_ID', mask(config.serviceId), config.serviceId.trim().length > 0],
    ['MWALONI_USERNAME', mask(config.username), config.username.trim().length > 0],
    ['MWALONI_PASSWORD', mask(config.password, 2), config.password.trim().length > 0],
    ['MWALONI_API_KEY', mask(config.apiKey, 8), config.apiKey.trim().length > 0],
    ['Base URL', getBaseUrl(), getBaseUrl().startsWith('https://')],
  ];

  let allOk = true;
  for (const [name, display, ok] of checks) {
    const icon = ok ? '✅' : '❌';
    console.log(`  ${icon} ${name.padEnd(25)} = ${display}`);
    if (!ok) allOk = false;
  }

  if (!config.enabled) {
    console.log('\n  ⚠️  MWALONI_ENABLED is false — B2C is disabled. Set to true to enable.');
  }

  // Check for whitespace issues
  const wsChecks = [
    ['MWALONI_SERVICE_ID', config.serviceId],
    ['MWALONI_USERNAME', config.username],
    ['MWALONI_PASSWORD', config.password],
    ['MWALONI_API_KEY', config.apiKey],
  ];
  for (const [name, value] of wsChecks) {
    if (value !== value.trim()) {
      console.log(`  ⚠️  ${name} has leading/trailing whitespace — may cause auth failures`);
    }
  }

  console.log(`\n  Config validation: ${allOk ? '✅ PASSED' : '❌ FAILED'}`);
  return allOk;
}

// ─── Step 2: Authentication ──────────────────────────────────────────────────

interface MwaloniAuthResponse {
  status?: string;
  message?: string;
  data?: {
    token?: string;
    tokenType?: string;
    expiresIn?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

async function testAuthentication(): Promise<string | null> {
  separator('STEP 2: Authentication Test');

  const url = `${getBaseUrl()}authenticate`;
  console.log(`  POST ${url}`);
  console.log(`  Headers: Content-Type=application/json, x-api-key=${mask(config.apiKey, 8)}`);
  console.log(`  Body: { username: "${mask(config.username)}", password: "***" }`);

  const startTime = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey.trim(),
      },
      body: JSON.stringify({
        username: config.username.trim(),
        password: config.password.trim(),
      }),
    });

    const elapsed = Date.now() - startTime;
    const body = (await res.json().catch(() => ({}))) as MwaloniAuthResponse;

    console.log(`\n  HTTP Status:     ${res.status} ${res.statusText}`);
    console.log(`  Response Time:   ${elapsed}ms`);
    console.log(`  Provider Status: ${body.status ?? '(missing)'}`);
    console.log(`  Message:         ${body.message ?? '(missing)'}`);

    if (body.data?.token) {
      console.log(`  Token:           ${mask(body.data.token, 8)} (${body.data.token.length} chars)`);
      console.log(`  Token Type:      ${body.data.tokenType ?? '(missing)'}`);
      console.log(`  Expires In:      ${body.data.expiresIn ?? '(missing)'} seconds`);
    } else {
      console.log(`  Token:           ❌ NOT RETURNED`);
    }

    const success = res.ok && body.status === '00' && typeof body.data?.token === 'string';
    console.log(`\n  Authentication: ${success ? '✅ PASSED' : '❌ FAILED'}`);

    if (!success) {
      console.log(`\n  Possible causes:`);
      if (res.status === 401) console.log(`    - API key is invalid or expired`);
      if (body.status === '01') console.log(`    - Username/password credentials are incorrect`);
      if (!res.ok) console.log(`    - Server returned error HTTP ${res.status}`);
    }

    return success ? body.data!.token! : null;
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.log(`\n  ❌ Network Error after ${elapsed}ms`);
    console.log(`  Error: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`\n  Possible causes:`);
    console.log(`    - DNS resolution failure for ${getBaseUrl()}`);
    console.log(`    - TLS/SSL handshake failure`);
    console.log(`    - Firewall blocking outbound HTTPS`);
    return null;
  }
}

// ─── Step 3: Balance Fetch ───────────────────────────────────────────────────

async function testBalance(token: string): Promise<void> {
  separator('STEP 3: Balance Fetch Test');

  const url = `${getBaseUrl()}get-balance`;
  console.log(`  POST ${url}`);
  console.log(`  Headers: Authorization=Bearer ${mask(token, 8)}, x-api-key=${mask(config.apiKey, 8)}`);
  console.log(`  Body: { service_id: "${config.serviceId}" }`);

  const startTime = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey.trim(),
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        service_id: config.serviceId.trim(),
      }),
    });

    const elapsed = Date.now() - startTime;
    const body = await res.json().catch(() => ({}));

    console.log(`\n  HTTP Status:     ${res.status} ${res.statusText}`);
    console.log(`  Response Time:   ${elapsed}ms`);
    console.log(`  Provider Status: ${(body as any).status ?? '(missing)'}`);
    console.log(`  Message:         ${(body as any).message ?? '(missing)'}`);
    console.log(`\n  Full Response:`);
    console.log(`  ${JSON.stringify(body, null, 2).split('\n').join('\n  ')}`);

    // Try to extract balance from various possible field names
    const balanceFields = [
      'balance', 'availableBalance', 'available_balance', 'available',
      'walletBalance', 'wallet_balance', 'actualBalance', 'actual_balance',
      'currentBalance', 'current_balance', 'ledgerBalance', 'ledger_balance',
    ];

    const findBalance = (obj: any, depth = 0): [string, number] | null => {
      if (!obj || typeof obj !== 'object' || depth > 3) return null;
      for (const key of Object.keys(obj)) {
        if (balanceFields.includes(key) && typeof obj[key] === 'number') {
          return [key, obj[key]];
        }
        if (balanceFields.includes(key) && typeof obj[key] === 'string' && !isNaN(Number(obj[key]))) {
          return [key, Number(obj[key])];
        }
      }
      for (const val of Object.values(obj)) {
        if (typeof val === 'object') {
          const found = findBalance(val, depth + 1);
          if (found) return found;
        }
      }
      return null;
    };

    const found = findBalance(body);
    if (found) {
      console.log(`\n  💰 Wallet Balance: KES ${found[1].toLocaleString()} (field: ${found[0]})`);
    } else {
      console.log(`\n  ⚠️  Could not extract a numeric balance from the response`);
    }

    const success = res.ok && (body as any).status === '00';
    console.log(`\n  Balance Fetch: ${success ? '✅ PASSED' : '❌ FAILED'}`);
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.log(`\n  ❌ Network Error after ${elapsed}ms`);
    console.log(`  Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ─── Step 4: (Optional) Small B2C Send Test ──────────────────────────────────

async function testB2cSend(token: string, phoneNumber: string): Promise<void> {
  separator('STEP 4: B2C Send Test (1 KES)');

  const orderNumber = `TEST-${Date.now()}`;
  const amount = 1; // 1 KES — minimum possible

  console.log(`  ⚠️  WARNING: This will send real money (${amount} KES) to ${phoneNumber}`);
  console.log(`  Order Number: ${orderNumber}`);

  const url = `${getBaseUrl()}send-money`;
  const body = {
    channel: 'daraja-mobile',
    service_id: config.serviceId.trim(),
    order_number: orderNumber,
    amount,
    account_number: phoneNumber,
    description: 'B2C connectivity test',
    country_code: 'KE',
    currency_code: 'KES',
  };

  console.log(`\n  POST ${url}`);
  console.log(`  Body: ${JSON.stringify({ ...body, service_id: mask(config.serviceId) }, null, 2).split('\n').join('\n  ')}`);

  const startTime = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey.trim(),
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const elapsed = Date.now() - startTime;
    const resBody = await res.json().catch(() => ({}));

    console.log(`\n  HTTP Status:     ${res.status} ${res.statusText}`);
    console.log(`  Response Time:   ${elapsed}ms`);
    console.log(`  Provider Status: ${(resBody as any).status ?? '(missing)'}`);
    console.log(`  Message:         ${(resBody as any).message ?? '(missing)'}`);
    console.log(`\n  Full Response:`);
    console.log(`  ${JSON.stringify(resBody, null, 2).split('\n').join('\n  ')}`);

    const success = res.ok && (resBody as any).status === '00';
    console.log(`\n  B2C Send: ${success ? '✅ PASSED' : '❌ FAILED'}`);

    if (success) {
      console.log(`\n  ℹ️  Now checking transaction status...`);
      await new Promise((r) => setTimeout(r, 3000)); // wait 3s
      await testTransactionStatus(token, orderNumber);
    }
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.log(`\n  ❌ Network Error after ${elapsed}ms`);
    console.log(`  Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ─── Step 5: Transaction Status Check ────────────────────────────────────────

async function testTransactionStatus(token: string, orderNumber: string): Promise<void> {
  separator('STEP 5: Transaction Status Check');

  const url = `${getBaseUrl()}get-transaction-status`;
  console.log(`  POST ${url}`);
  console.log(`  Body: { orderNumber: "${orderNumber}" }`);

  const startTime = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey.trim(),
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ orderNumber }),
    });

    const elapsed = Date.now() - startTime;
    const body = await res.json().catch(() => ({}));

    console.log(`\n  HTTP Status:     ${res.status} ${res.statusText}`);
    console.log(`  Response Time:   ${elapsed}ms`);
    console.log(`\n  Full Response:`);
    console.log(`  ${JSON.stringify(body, null, 2).split('\n').join('\n  ')}`);
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.log(`\n  ❌ Network Error after ${elapsed}ms`);
    console.log(`  Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔍 Mwaloni B2C Connectivity & Configuration Test');
  console.log(`   Environment: ${config.env}`);
  console.log(`   Base URL:    ${getBaseUrl()}`);
  console.log(`   Timestamp:   ${new Date().toISOString()}`);

  // Step 1: Config validation
  const configOk = validateConfig();
  if (!configOk) {
    console.log('\n❌ Aborting — fix configuration first.\n');
    process.exit(1);
  }

  // Step 2: Authentication
  const token = await testAuthentication();
  if (!token) {
    console.log('\n❌ Aborting — authentication failed. Cannot proceed without a token.\n');
    process.exit(1);
  }

  // Step 3: Balance
  await testBalance(token);

  // Step 4 (optional): B2C send
  const sendArg = process.argv.indexOf('--send');
  if (sendArg !== -1 && process.argv[sendArg + 1]) {
    const phone = process.argv[sendArg + 1];
    await testB2cSend(token, phone);
  } else {
    separator('STEP 4: B2C Send Test (SKIPPED)');
    console.log('  ℹ️  To test an actual B2C send, run:');
    console.log('     npx ts-node test-mwaloni-b2c.ts --send 254XXXXXXXXX');
    console.log('     This will send 1 KES to the specified phone number.');
  }

  separator('SUMMARY');
  console.log('  ✅ Configuration:   Valid');
  console.log(`  ${token ? '✅' : '❌'} Authentication:  ${token ? 'Passed' : 'Failed'}`);
  console.log('  📊 Balance:         See above');
  console.log('');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
