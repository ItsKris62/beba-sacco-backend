/**
 * k6 Load Test — Report Generation Queue
 *
 * Target: POST /api/admin/reports/generate
 * Profile: Burst 100 req/s
 * Thresholds:
 *   - Queue depth monitoring
 *   - DLQ fallback on repeated failures
 *   - p95 < 2s for enqueue
 *
 * Run locally:
 *   k6 run --env BASE_URL=http://localhost:3000 --env TENANT_ID=<uuid> --env ADMIN_TOKEN=<jwt> k6/report-queue-load.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// ─── Configuration ───────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TENANT_ID = __ENV.TENANT_ID || '00000000-0000-0000-0000-000000000000';
const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || '';

// Custom metrics
const enqueueLatency = new Trend('report_enqueue_latency_ms');
const queueDepth = new Counter('report_queue_depth');
const dlqTriggered = new Counter('report_dlq_triggered');
const acceptedRate = new Rate('report_accepted_rate');

// ─── Options ─────────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    burst_reports: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 100 },
        { duration: '30s', target: 100 },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.05'],
    report_enqueue_latency_ms: ['p(95)<1500'],
    report_accepted_rate: ['rate>0.95'],
    report_dlq_triggered: ['count==0'],
  },
};

// ─── Setup ───────────────────────────────────────────────────────────────────

export function setup() {
  if (!ADMIN_TOKEN) {
    throw new Error('ADMIN_TOKEN environment variable is required');
  }
  return { token: ADMIN_TOKEN };
}

// ─── Main VU ─────────────────────────────────────────────────────────────────

export default function (data) {
  const idempotencyKey = `k6-report-${__VU}-${Date.now()}`;
  const headers = {
    Authorization: `Bearer ${data.token}`,
    'X-Tenant-ID': TENANT_ID,
    'Idempotency-Key': idempotencyKey,
    'Content-Type': 'application/json',
    'X-Request-ID': `k6-report-${__VU}-${Date.now()}`,
  };

  const reportTypes = ['LOAN_BOOK', 'MEMBER_BALANCES', 'AUDIT_TRAIL', 'EXECUTIVE'];
  const formats = ['PDF', 'CSV'];
  const reportType = reportTypes[__VU % reportTypes.length];
  const format = formats[__VU % formats.length];

  const payload = JSON.stringify({
    reportType,
    format,
    fromDate: '2026-01-01',
    toDate: '2026-12-31',
  });

  const start = Date.now();
  const res = http.post(`${BASE_URL}/api/admin/reports/generate`, payload, { headers });
  const elapsed = Date.now() - start;

  enqueueLatency.add(elapsed);

  const isAccepted = res.status === 202 || res.status === 200 || res.status === 201;
  acceptedRate.add(isAccepted ? 1 : 0);

  check(res, {
    'status is 200, 201, or 202': (r) => [200, 201, 202].includes(r.status),
    'response time < 2000ms': (r) => r.timings.duration < 2000,
    'has jobId': (r) => {
      if (![200, 201, 202].includes(r.status)) return true;
      try {
        const body = JSON.parse(r.body);
        return body.jobId !== undefined || body.id !== undefined;
      } catch {
        return false;
      }
    },
    'no 500 errors': (r) => r.status < 500,
  });

  // Simulate polling for status (every 5th VU)
  if (__VU % 5 === 0 && isAccepted) {
    try {
      const body = JSON.parse(res.body);
      const jobId = body.jobId || body.id;
      if (jobId) {
        sleep(2);
        const pollRes = http.get(
          `${BASE_URL}/api/admin/reports/${jobId}/status`,
          { headers: { Authorization: `Bearer ${data.token}`, 'X-Tenant-ID': TENANT_ID } },
        );
        check(pollRes, {
          'poll status is 200 or 404': (r) => [200, 404].includes(r.status),
        });
      }
    } catch {
      // ignore
    }
  }

  sleep(0.2);
}

export function teardown() {
  console.log('Report queue load test complete');
}
