#!/usr/bin/env ts-node
/**
 * sacco-cli – Phase 6 Internal Developer Platform CLI
 *
 * Commands:
 *   sacco tenant:create   – Create a new tenant with region config
 *   sacco seed:test-data  – Seed test data for a tenant
 *   sacco compliance:run  – Run policy compliance check
 *   sacco recon:trigger   – Trigger reconciliation job
 *   sacco dsar:export     – Export DSAR data for a member
 *   sacco canary:status   – Show latest canary deployment status
 *   sacco launch:report   – Generate launch readiness report
 *
 * Auth: SERVICE_ACCOUNT_JWT env var
 * Base URL: API_BASE_URL env var (default: http://localhost:3000/api/v1)
 */

import * as https from 'https';
import * as http from 'http';
import * as readline from 'readline';

const BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';
const JWT = process.env.SERVICE_ACCOUNT_JWT ?? '';
const TENANT_ID = process.env.SACCO_TENANT_ID ?? '';

interface ApiResponse {
  status: number;
  body: unknown;
}

async function apiCall(
  method: string,
  path: string,
  body?: unknown,
  tenantId?: string,
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${path}`);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const payload = body ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${JWT}`,
        'X-Tenant-ID': tenantId ?? TENANT_ID,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data });
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function print(label: string, data: unknown): void {
  console.log(`\n✅ ${label}`);
  console.log(JSON.stringify(data, null, 2));
}

function error(msg: string): void {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function tenantCreate(): Promise<void> {
  const name = await prompt('Tenant name: ');
  const region = await prompt('Region (KE-NAIROBI/UG-KAMPALA/RW-KIGALI) [KE-NAIROBI]: ') || 'KE-NAIROBI';
  const email = await prompt('Admin email: ');

  const res = await apiCall('POST', '/tenants', { name, region, adminEmail: email });
  if (res.status >= 400) error(`Failed to create tenant: ${JSON.stringify(res.body)}`);
  print('Tenant created', res.body);
}

async function seedTestData(): Promise<void> {
  const tenantId = await prompt(`Tenant ID [${TENANT_ID}]: `) || TENANT_ID;
  if (!tenantId) error('SACCO_TENANT_ID not set and no tenant ID provided');

  const res = await apiCall('POST', '/sandbox/reset', {}, tenantId);
  if (res.status >= 400) error(`Seed failed: ${JSON.stringify(res.body)}`);
  print('Test data seeded', res.body);
}

async function complianceRun(): Promise<void> {
  const tenantId = await prompt(`Tenant ID [${TENANT_ID}]: `) || TENANT_ID;
  const policy = await prompt('Policy filter (CBK/SASRA/ODPC/all) [all]: ') || undefined;

  const query = policy && policy !== 'all' ? `?policy=${policy}` : '';
  const res = await apiCall('GET', `/admin/compliance/policy-check${query}`, undefined, tenantId);
  if (res.status >= 400) error(`Compliance check failed: ${JSON.stringify(res.body)}`);
  print('Compliance check result', res.body);
}

async function reconTrigger(): Promise<void> {
  const tenantId = await prompt(`Tenant ID [${TENANT_ID}]: `) || TENANT_ID;
  const date = await prompt('Reconciliation date (YYYY-MM-DD) [today]: ') || new Date().toISOString().split('T')[0];

  const res = await apiCall('POST', '/integrations/reconciliation/trigger', { date }, tenantId);
  if (res.status >= 400) error(`Recon trigger failed: ${JSON.stringify(res.body)}`);
  print('Reconciliation triggered', res.body);
}

async function dsarExport(): Promise<void> {
  const tenantId = await prompt(`Tenant ID [${TENANT_ID}]: `) || TENANT_ID;
  const memberId = await prompt('Member ID: ');
  if (!memberId) error('Member ID is required');

  const res = await apiCall('POST', '/integrations/dsar/export', { memberId }, tenantId);
  if (res.status >= 400) error(`DSAR export failed: ${JSON.stringify(res.body)}`);
  print('DSAR export initiated', res.body);
}

async function canaryStatus(): Promise<void> {
  const res = await apiCall('GET', '/admin/deploy/canary/status');
  if (res.status >= 400) error(`Canary status failed: ${JSON.stringify(res.body)}`);
  print('Canary deployment status', res.body);
}

async function launchReport(): Promise<void> {
  const res = await apiCall('GET', '/admin/deploy/launch-report');
  if (res.status >= 400) error(`Launch report failed: ${JSON.stringify(res.body)}`);
  print('Launch readiness report', res.body);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const COMMANDS: Record<string, () => Promise<void>> = {
  'tenant:create': tenantCreate,
  'seed:test-data': seedTestData,
  'compliance:run': complianceRun,
  'recon:trigger': reconTrigger,
  'dsar:export': dsarExport,
  'canary:status': canaryStatus,
  'launch:report': launchReport,
};

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command || command === '--help' || command === '-h') {
    console.log(`
sacco-cli – SACCO Internal Developer Platform CLI

Usage: sacco <command>

Commands:
  tenant:create    Create a new tenant with region config
  seed:test-data   Seed test data for a tenant (sandbox)
  compliance:run   Run CBK/SASRA/ODPC policy compliance check
  recon:trigger    Trigger M-Pesa reconciliation job
  dsar:export      Export DSAR data for a member
  canary:status    Show latest canary deployment status
  launch:report    Generate launch readiness report

Environment:
  API_BASE_URL          API base URL (default: http://localhost:3000/api/v1)
  SERVICE_ACCOUNT_JWT   Service account JWT token
  SACCO_TENANT_ID       Default tenant ID
`);
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    error(`Unknown command: ${command}. Run 'sacco --help' for usage.`);
    return;
  }

  if (!JWT) {
    error('SERVICE_ACCOUNT_JWT environment variable is required');
    return;
  }

  await handler();
}

main().catch((err: Error) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
