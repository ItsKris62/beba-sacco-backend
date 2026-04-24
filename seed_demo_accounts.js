const fs = require('fs');
const path = require('path');

const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
const dbUrl = envContent.match(/DATABASE_URL="([^"]+)"/)?.[1];
process.env.DATABASE_URL = dbUrl;

const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');
const p = new PrismaClient();

const OUTPUT_FILE = path.join(__dirname, 'seed_demo_output.txt');
const lines = [];
function log(msg) {
  lines.push(msg);
  console.log(msg);
}

async function run() {
  log('=== SEEDING DEMO ACCOUNTS ===');

  // Upsert the Beba SACCO tenant
  const tenant = await p.tenant.upsert({
    where: { slug: 'beba-sacco' },
    update: { status: 'ACTIVE' },
    create: {
      name: 'Beba SACCO',
      slug: 'beba-sacco',
      schemaName: 'tenant_beba_sacco',
      status: 'ACTIVE',
      contactEmail: 'admin@beba-sacco.com',
      contactPhone: '+254700000000',
      address: 'Nairobi, Kenya',
      settings: {}
    }
  });
  log('Tenant ID: ' + tenant.id);

  // Hash passwords with argon2id (same as auth service)
  const adminHash = await argon2.hash('Admin@1234', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
  const memberHash = await argon2.hash('Member@1234', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });

  // Upsert admin user
  const adminUser = await p.user.upsert({
    where: { email: 'admin@beba-sacco.com' },
    update: { passwordHash: adminHash, isActive: true, tenantId: tenant.id },
    create: {
      tenantId: tenant.id,
      email: 'admin@beba-sacco.com',
      passwordHash: adminHash,
      firstName: 'Beba',
      lastName: 'Admin',
      phone: '+254700000001',
      role: 'MANAGER',
      isActive: true,
      emailVerified: true
    }
  });
  log('Admin user upserted: ' + adminUser.email + ' (role: ' + adminUser.role + ')');

  // Upsert member user
  const memberUser = await p.user.upsert({
    where: { email: 'member@beba-sacco.com' },
    update: { passwordHash: memberHash, isActive: true, tenantId: tenant.id },
    create: {
      tenantId: tenant.id,
      email: 'member@beba-sacco.com',
      passwordHash: memberHash,
      firstName: 'John',
      lastName: 'Kamau',
      phone: '+254712345678',
      role: 'MEMBER',
      isActive: true,
      emailVerified: true
    }
  });
  log('Member user upserted: ' + memberUser.email + ' (role: ' + memberUser.role + ')');

  // Upsert member profile
  const member = await p.member.upsert({
    where: { userId: memberUser.id },
    update: {},
    create: {
      tenantId: tenant.id,
      userId: memberUser.id,
      memberNumber: 'M-000001',
      nationalId: '12345678',
      kraPin: 'A001234567B',
      employer: 'Nairobi County',
      occupation: 'Civil Servant',
      dateOfBirth: new Date('1985-06-15'),
      isActive: true,
      joinedAt: new Date('2024-01-01')
    }
  });
  log('Member profile upserted: ' + member.memberNumber);

  // Upsert accounts
  await p.account.upsert({
    where: { tenantId_accountNumber: { tenantId: tenant.id, accountNumber: 'ACC-FOSA-000001' } },
    update: {},
    create: { tenantId: tenant.id, memberId: member.id, accountNumber: 'ACC-FOSA-000001', accountType: 'FOSA', balance: 50000, isActive: true }
  });
  await p.account.upsert({
    where: { tenantId_accountNumber: { tenantId: tenant.id, accountNumber: 'ACC-BOSA-000001' } },
    update: {},
    create: { tenantId: tenant.id, memberId: member.id, accountNumber: 'ACC-BOSA-000001', accountType: 'BOSA', balance: 120000, isActive: true }
  });
  log('Accounts upserted: ACC-FOSA-000001, ACC-BOSA-000001');

  // Upsert loan products
  await p.loanProduct.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'Development Loan' } },
    update: {},
    create: { tenantId: tenant.id, name: 'Development Loan', description: 'General development loan', minAmount: 10000, maxAmount: 500000, interestRate: 0.12, interestType: 'REDUCING_BALANCE', maxTenureMonths: 36, processingFeeRate: 0.01, gracePeriodMonths: 1, isActive: true }
  });
  await p.loanProduct.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'Jipange Loan' } },
    update: {},
    create: { tenantId: tenant.id, name: 'Jipange Loan', description: 'Short-term emergency loan', minAmount: 5000, maxAmount: 100000, interestRate: 0.15, interestType: 'FLAT', maxTenureMonths: 12, processingFeeRate: 0.02, gracePeriodMonths: 0, isActive: true }
  });
  log('Loan products upserted');

  log('\n=== SUMMARY ===');
  log('Tenant ID: ' + tenant.id);
  log('Admin login:  admin@beba-sacco.com  / Admin@1234  (role: MANAGER)');
  log('Member login: member@beba-sacco.com / Member@1234 (role: MEMBER)');
  log('X-Tenant-ID header: ' + tenant.id);
  log('\n=== DONE ===');

  fs.writeFileSync(OUTPUT_FILE, lines.join('\n'), 'utf8');
  await p.$disconnect();
}

run().catch(async e => {
  const msg = 'FATAL ERROR: ' + e.message + '\n' + e.stack;
  fs.writeFileSync(OUTPUT_FILE, msg, 'utf8');
  console.error(msg);
  await p.$disconnect();
  process.exit(1);
});
