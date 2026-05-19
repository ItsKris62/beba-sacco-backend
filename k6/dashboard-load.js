/**
 * k6 Load Test — Member Dashboard
 *
 * Target: GET /api/members/dashboard
 * Profile: 500 VUs, 5 minutes
 * Thresholds:
 *   - p95 latency < 1.5s
 *   - Error rate < 1%
 *   - 95th percentile of HTTP req duration
 *
 * Run locally:
 *   k6 run --env BASE_URL=http://localhost:3000 --env TENANT_ID=<uuid> --env MEMBER_TOKEN=<jwt> k6/dashboard-load.js
 *
 * Run in CI (JSON output):
 *   k6 run --out json=k6-results/dashboard.json k6/dashboard-load.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// ─── Configuration ───────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TENANT_ID = __ENV.TENANT_ID || '00000000-0000-0000-0000-000000000000';
const MEMBER_TOKEN = __ENV.MEMBER_TOKEN || '';

// Custom metrics
const cacheHitRate = new Rate('dashboard_cache_hit_rate');
const dbQueryLatency = new Trend('db_query_latency_ms');
const partialResponseRate = new Rate('partial_response_rate');
const problemJsonRate = new Rate('problem_json_rate');
const tenantIsolationFailures = new Counter('tenant_isolation_failures');

// ─── Options ─────────────────────────────────────────────────────────────────

export const options = {
  stages: [
    { duration: '1m', target: 100 },   // Ramp up
    { duration: '3m', target: 500 },   // Steady state
    { duration: '1m', target: 0 },     // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<1500'],          // p95 < 1.5s
    http_req_failed: ['rate<0.01'],              // Error rate < 1%
    dashboard_cache_hit_rate: ['rate>0.30'],     // At least 30% cache hits
    partial_response_rate: ['rate<0.05'],        // <5% partial responses
    problem_json_rate: ['rate<0.01'],            // <1% RFC 7807 errors
    tenant_isolation_failures: ['count==0'],     // Zero cross-tenant leaks
  },
};

// ─── Setup ───────────────────────────────────────────────────────────────────

export function setup() {
  if (!MEMBER_TOKEN) {
    throw new Error('MEMBER_TOKEN environment variable is required');
  }
  return { token: MEMBER_TOKEN };
}

// ─── Main VU ─────────────────────────────────────────────────────────────────

export default function (data) {
  const headers = {
    Authorization: `Bearer ${data.token}`,
    'X-Tenant-ID': TENANT_ID,
    'X-Request-ID': `k6-${__VU}-${Date.now()}`,
  };

  const start = Date.now();
  const res = http.get(`${BASE_URL}/api/members/dashboard`, { headers });
  const elapsed = Date.now() - start;

  // Core checks
  const checks = check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 1500ms': (r) => r.timings.duration < 1500,
    'content-type is JSON': (r) =>
      r.headers['Content-Type']?.includes('application/json'),
    'has member data': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.data?.member !== undefined;
      } catch {
        return false;
      }
    },
    'not partial': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.partial !== true;
      } catch {
        return true;
      }
    },
    'tenant isolation intact': (r) => {
      try {
        const body = JSON.parse(r.body);
        // If we get data for a different tenant, that's a leak
        return body.data?.member?.memberNumber !== 'CROSS_TENANT_LEAK';
      } catch {
        return true;
      }
    },
  });

  // Custom metrics
  const isCacheHit = res.headers['X-Cache'] === 'HIT';
  cacheHitRate.add(isCacheHit ? 1 : 0);
  dbQueryLatency.add(elapsed);

  try {
    const body = JSON.parse(res.body);
    partialResponseRate.add(body.partial === true ? 1 : 0);
  } catch {
    partialResponseRate.add(0);
  }

  problemJsonRate.add(res.headers['Content-Type']?.includes('problem+json') ? 1 : 0);

  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      if (body.data?.member?.tenantId && body.data.member.tenantId !== TENANT_ID) {
        tenantIsolationFailures.add(1);
      }
    } catch {
      // ignore parse errors
    }
  }

  sleep(1);
}

// ─── Teardown ────────────────────────────────────────────────────────────────

export function teardown() {
  console.log('Dashboard load test complete');
}
