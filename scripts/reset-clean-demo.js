/**
 * Reset the configured database to a clean demo state.
 *
 * Keeps:
 *   - Location hierarchy tables: County, Constituency, Ward
 *   - Prisma migration metadata: _prisma_migrations
 *
 * Deletes:
 *   - All tenant, user, member, financial, audit, queue, import, stage,
 *     partner, report, auth/session, and other application data.
 *
 * Then runs the existing demo-account seed.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const REQUIRED_FLAG = '--yes';
const PRESERVED_TABLES = new Set(['County', 'Constituency', 'Ward', '_prisma_migrations']);

function loadDotEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    return;
  }

  const content = fs.readFileSync(ENV_FILE, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (process.env[key]) {
      continue;
    }

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function formatDbTarget(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '[unparseable DATABASE_URL]';
  }
}

function runNodeScript(relativePath) {
  const scriptPath = path.join(ROOT, relativePath);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${relativePath} exited with status ${result.status}`);
  }
}

function quoteIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function truncateNonLocationTables() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  try {
    const rows = await prisma.$queryRaw`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name ASC
    `;

    const tablesToTruncate = rows
      .map((row) => row.table_name)
      .filter((tableName) => !PRESERVED_TABLES.has(tableName));

    if (tablesToTruncate.length === 0) {
      console.log('No non-location application tables found to truncate.');
      return;
    }

    const tableList = tablesToTruncate
      .map((tableName) => `"public".${quoteIdentifier(tableName)}`)
      .join(', ');

    console.log(`Truncating ${tablesToTruncate.length} non-location tables...`);
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
    console.log('Non-location application data cleared.');
  } finally {
    await prisma.$disconnect();
  }
}

async function verifyCleanDemoState() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  try {
    const [
      counties,
      constituencies,
      wards,
      tenants,
      users,
      members,
      accounts,
      loanProducts,
      loans,
      memberApplications,
      stages,
    ] = await Promise.all([
      prisma.county.count(),
      prisma.constituency.count(),
      prisma.ward.count(),
      prisma.tenant.count(),
      prisma.user.count(),
      prisma.member.count(),
      prisma.account.count(),
      prisma.loanProduct.count(),
      prisma.loan.count(),
      prisma.memberApplication.count(),
      prisma.stage.count(),
    ]);

    const demoUsers = await prisma.user.findMany({
      orderBy: { email: 'asc' },
      select: { email: true, role: true, isActive: true, tenantId: true },
    });

    console.log('\nClean demo state:');
    console.log(`  Locations: ${counties} counties, ${constituencies} constituencies, ${wards} wards`);
    console.log(`  Demo data: ${tenants} tenant, ${users} users, ${members} member, ${accounts} accounts`);
    console.log(`  Loan products: ${loanProducts}; loans: ${loans}`);
    console.log(`  Cleared queues: ${memberApplications} member applications, ${stages} stages`);
    console.log('  Demo users:');
    for (const user of demoUsers) {
      console.log(`    - ${user.email} (${user.role}, active=${user.isActive})`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  if (!process.argv.includes(REQUIRED_FLAG)) {
    console.error(`Refusing to reset the database without ${REQUIRED_FLAG}.`);
    console.error(`Usage: node scripts/reset-clean-demo.js ${REQUIRED_FLAG}`);
    process.exit(1);
  }

  loadDotEnv();

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Add it to .env or export it before running.');
    process.exit(1);
  }

  console.log(`Reset target: ${formatDbTarget(process.env.DATABASE_URL)}`);
  console.log('Refreshing location hierarchy first...');
  runNodeScript('scripts/seed-locations.js');

  await truncateNonLocationTables();

  console.log('\nSeeding demo accounts...');
  runNodeScript('seed_demo_accounts.js');

  await verifyCleanDemoState();
}

main().catch((error) => {
  console.error('\nReset failed:', error.message);
  process.exit(1);
});
