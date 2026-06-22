#!/usr/bin/env node
'use strict';

const autocannon = require('autocannon');

const config = {
  baseUrl: (process.env.LOAD_BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  tenantId: process.env.LOAD_TENANT_ID || process.env.TENANT_ID,
  memberIdentifier: process.env.LOAD_MEMBER_EMAIL || process.env.LOAD_MEMBER_PHONE,
  memberPassword: process.env.LOAD_MEMBER_PASSWORD,
  adminIdentifier:
    process.env.LOAD_ADMIN_EMAIL ||
    process.env.LOAD_ADMIN_PHONE ||
    process.env.LOAD_MEMBER_EMAIL ||
    process.env.LOAD_MEMBER_PHONE,
  adminPassword: process.env.LOAD_ADMIN_PASSWORD || process.env.LOAD_MEMBER_PASSWORD,
  duration: Number(process.env.LOAD_DURATION_SECONDS || 60),
  connections: Number(process.env.LOAD_CONNECTIONS || 2000),
  mpesaConnections: Number(process.env.LOAD_MPESA_CONNECTIONS || 50),
};

function requireEnv(value, name) {
  if (!value) {
    throw new Error(`Missing ${name}. Set it before running npm run test:load.`);
  }
  return value;
}

function loginPayload(identifier, password) {
  const body = { password };
  if (/^\+?[1-9]\d{7,14}$/.test(identifier)) {
    body.phone = identifier;
  } else {
    body.email = identifier;
  }
  return body;
}

async function postJson(path, body) {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-ID': config.tenantId,
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`POST ${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function login(label, identifier, password) {
  const result = await postJson('/api/v1/auth/login', loginPayload(identifier, password));
  const token = result?.data?.accessToken || result?.accessToken || result?.token;
  if (!token) {
    throw new Error(`${label} login succeeded but no access token was returned`);
  }
  return token;
}

function mpesaCallbackBody() {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: `LOAD-MR-${suffix}`,
        CheckoutRequestID: `ws_CO_LOAD_${suffix}`,
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: 1 },
            { Name: 'MpesaReceiptNumber', Value: `LOAD${suffix}` },
            { Name: 'TransactionDate', Value: 20260622120000 },
            { Name: 'PhoneNumber', Value: 254700000000 },
          ],
        },
      },
    },
  };
}

function runAutocannon(options) {
  return new Promise((resolve, reject) => {
    const instance = autocannon(options, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
    autocannon.track(instance, { renderProgressBar: true, renderResultsTable: false });
  });
}

async function runScenario(name, path, token, overrides = {}) {
  const headers = {
    'X-Tenant-ID': config.tenantId,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(overrides.headers || {}),
  };

  const result = await runAutocannon({
    title: name,
    url: `${config.baseUrl}${path}`,
    method: overrides.method || 'GET',
    connections: overrides.connections || config.connections,
    duration: overrides.duration || config.duration,
    headers,
    body: overrides.body,
    setupClient: overrides.setupClient,
  });

  return { name, result, expectedStatuses: overrides.expectedStatuses || [200] };
}

function countUnexpectedStatuses(result, expectedStatuses) {
  const stats = result.statusCodeStats || {};
  const codes = Object.keys(stats);
  if (codes.length === 0) {
    return expectedStatuses.every((status) => status >= 200 && status < 300)
      ? result.non2xx || 0
      : 0;
  }

  return codes.reduce((total, code) => {
    if (expectedStatuses.includes(Number(code))) {
      return total;
    }
    const value = stats[code];
    return total + (typeof value === 'number' ? value : value.count || 0);
  }, 0);
}

function summarize({ name, result, expectedStatuses }) {
  const total = result.requests?.total || 0;
  const failed = (result.errors || 0) + countUnexpectedStatuses(result, expectedStatuses);
  return {
    Scenario: name,
    'Req/sec': Number(result.requests?.average || 0).toFixed(2),
    'Avg Latency': `${Number(result.latency?.average || 0).toFixed(2)} ms`,
    p95: `${Number(result.latency?.p95 || 0).toFixed(2)} ms`,
    p99: `${Number(result.latency?.p99 || 0).toFixed(2)} ms`,
    'Error %': total === 0 ? '0.00%' : `${((failed / total) * 100).toFixed(2)}%`,
  };
}

async function main() {
  requireEnv(config.tenantId, 'LOAD_TENANT_ID');
  const memberIdentifier = requireEnv(config.memberIdentifier, 'LOAD_MEMBER_EMAIL or LOAD_MEMBER_PHONE');
  const memberPassword = requireEnv(config.memberPassword, 'LOAD_MEMBER_PASSWORD');
  const adminIdentifier = requireEnv(config.adminIdentifier, 'LOAD_ADMIN_EMAIL/PHONE or member fallback');
  const adminPassword = requireEnv(config.adminPassword, 'LOAD_ADMIN_PASSWORD or LOAD_MEMBER_PASSWORD');

  console.log(`Load target: ${config.baseUrl}`);
  console.log(`Tenant: ${config.tenantId}`);
  console.log(`Connections: ${config.connections}; duration: ${config.duration}s`);

  const memberToken = await login('member', memberIdentifier, memberPassword);
  const adminToken =
    adminIdentifier === memberIdentifier && adminPassword === memberPassword
      ? memberToken
      : await login('admin', adminIdentifier, adminPassword);

  const results = [];
  results.push(await runScenario('Member dashboard', '/api/v1/members/dashboard', memberToken));
  results.push(await runScenario('Admin dashboard stats', '/api/v1/admin/dashboard/stats', adminToken));
  results.push(
    await runScenario(
      'FOSA statement',
      '/api/v1/members/accounts/fosa/statement?page=1&limit=20',
      memberToken,
    ),
  );
  results.push(
    await runScenario('M-Pesa callback', '/api/v1/mpesa/callback', null, {
      method: 'POST',
      connections: config.mpesaConnections,
      expectedStatuses: [200, 429],
      headers: { 'Content-Type': 'application/json' },
      setupClient: (client) => {
        client.setBody(JSON.stringify(mpesaCallbackBody()));
      },
    }),
  );

  console.log('\nLoad test summary (target error rate: 0%)');
  console.table(results.map(summarize));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
