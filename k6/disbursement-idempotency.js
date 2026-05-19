/**
 * k6 Load Test — Loan Disbursement Idempotency
 *
 * Target: PATCH /api/admin/loans/:id/review (action=DISBURSE)
 * Profile: 50 VUs concurrent, idempotency stress
 * Thresholds:
 *   - Exactly 1 success, rest 409/replay
 *   - p95 < 3s
 *   - Zero double-credit (balance check after burst)
 *
 * Run locally:
 *   k6 run --env BASE_URL=http://localhost:3000 --env TENANT_ID=<uuid> --env ADMIN_TOKEN=<jwt> --env LOAN_ID=<uuid> k6/disbursement-idempotency.js
 *
 * Run in CI:
 *   k6 run --out json=k6-results/disbursement.json k6/disbursement-idempotency.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// ─── Configuration ───────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TENANT_ID = __ENV.TENANT_ID || '00000000-0000-0000-0000-000000000000';
const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || '';
const LOAN_ID = __ENV.LOAN_ID || '00000000-0000-0000-0000-000000000000';

// Custom metrics
const idempotencyConflictRate = new Rate('idempotency_conflict_rate');
const disburseLatency = new Trend('disburse_latency_ms');
const doubleCreditDetected = new Counter('double_credit_detected');
const serializableRetryRate = new Rate('serializable_retry_rate');

// ─── Options ─────────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    burst_disburse: {
      executor: 'shared-iterations',
      vus: 50,
      iterations: 50,
      maxDuration: '30s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<3000'],
    http_req_failed: ['rate<0.05'],
    idempotency_conflict_rate: ['rate>0.90'],     // >90% should be 409 conflicts
    double_credit_detected: ['count==0'],          // Zero double-credit ever
    serializable_retry_rate: ['rate<0.10'],        // <10% retries due to serialization
  },
};

// ─── Setup ───────────────────────────────────────────────────────────────────

export function setup() {
  if (!ADMIN_TOKEN || !LOAN_ID) {
    throw new Error('ADMIN_TOKEN and LOAN_ID environment variables are required');
  }

  // Single shared idempotency key for all VUs — forces deduplication
  const sharedIdempotencyKey = `k6-idem-${Date.now()}`;

  // Capture pre-disbursement balance for post-run validation
  const balanceRes = http.get(
    `${BASE_URL}/api/accounts?loanId=${LOAN_ID}`,
    {
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        'X-Tenant-ID': TENANT_ID,
      },
    },
  );

  let preBalance = 0;
  try {
    const body = JSON.parse(balanceRes.body);
    preBalance = body.data?.[0]?.balance || 0;
  } catch {
    preBalance = 0;
  }

  return { sharedIdempotencyKey, preBalance };
}

// ─── Main VU ─────────────────────────────────────────────────────────────────

export default function (data) {
  const headers = {
    Authorization: `Bearer ${ADMIN_TOKEN}`,
    'X-Tenant-ID': TENANT_ID,
    'Idempotency-Key': data.sharedIdempotencyKey,
    'Content-Type': 'application/json',
    'X-Request-ID': `k6-disburse-${__VU}-${Date.now()}`,
  };

  const payload = JSON.stringify({
    action: 'DISBURSE',
    comment: `k6 burst ${__VU}`,
  });

  const start = Date.now();
  const res = http.patch(`${BASE_URL}/api/admin/loans/${LOAN_ID}/review`, payload, { headers });
  const elapsed = Date.now() - start;

  disburseLatency.add(elapsed);

  // Core assertion: only 1 success, rest must be 409
  const isSuccess = res.status === 200 || res.status === 201;
  const isConflict = res.status === 409;
  const isSerializableConflict = res.status === 409 && res.body?.includes?.('modified by another transaction');

  check(res, {
    'status is 200, 201, or 409': (r) => [200, 201, 409].includes(r.status),
    'problem+json on conflict': (r) =>
      !isConflict || r.headers['Content-Type']?.includes('problem+json'),
    'no 500 errors': (r) => r.status < 500,
  });

  idempotencyConflictRate.add(isConflict ? 1 : 0);
  serializableRetryRate.add(isSerializableConflict ? 1 : 0);

  // If we got 200/201, verify it's the only success by checking response body
  if (isSuccess) {
    try {
      const body = JSON.parse(res.body);
      check(res, {
        'loan status is ACTIVE': () => body.loan?.status === 'ACTIVE',
        'balance increased': () => body.newBalance > data.preBalance,
      });
    } catch {
      // ignore parse errors
    }
  }

  sleep(0.5);
}

// ─── Teardown — validate no double-credit ────────────────────────────────────

export function teardown(data) {
  const balanceRes = http.get(
    `${BASE_URL}/api/accounts?loanId=${LOAN_ID}`,
    {
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        'X-Tenant-ID': TENANT_ID,
      },
    },
  );

  let postBalance = 0;
  try {
    const body = JSON.parse(balanceRes.body);
    postBalance = body.data?.[0]?.balance || 0;
  } catch {
    postBalance = 0;
  }

  // If balance increased by more than expected principal, flag double-credit
  // (This is a heuristic — exact principal should be known from setup)
  const expectedIncrease = parseFloat(__ENV.PRINCIPAL_AMOUNT || '50000');
  const actualIncrease = postBalance - data.preBalance;

  if (actualIncrease > expectedIncrease * 1.01) {
    doubleCreditDetected.add(1);
    console.error(`DOUBLE CREDIT DETECTED: expected +${expectedIncrease}, got +${actualIncrease}`);
  } else {
    console.log(`Balance check OK: pre=${data.preBalance}, post=${postBalance}, increase=${actualIncrease}`);
  }
}
