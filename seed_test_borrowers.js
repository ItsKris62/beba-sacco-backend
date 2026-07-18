const fs = require('fs');
const path = require('path');

// Use DATABASE_URL from environment if already set (allows targeting production).
// Fall back to reading from .env for local dev.
if (!process.env.DATABASE_URL) {
  try {
    const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    const dbUrl = envContent.match(/DATABASE_URL="([^"]+)"/)?.[1];
    if (dbUrl) process.env.DATABASE_URL = dbUrl;
  } catch {
    // .env not found — DATABASE_URL must be set in the environment
  }
}

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set. Pass it as an env var or add it to .env');
  process.exit(1);
}

const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');
const p = new PrismaClient();

const OUTPUT_FILE = path.join(__dirname, 'seed_test_borrowers_output.txt');
const lines = [];
function log(msg) {
  lines.push(msg);
  console.log(msg);
}

// New test members: created so that member@beba-sacco.com has enough
// eligible KYC-approved co-members to nominate as loan guarantors, and so
// each of the three can also apply for and repay a loan of their own.
const NEW_MEMBERS = [
  {
    email: 'member2@beba-sacco.com',
    firstName: 'Jane',
    lastName: 'Wanjiru',
    phone: '+254712345679',
    memberNumber: 'M-000002',
    nationalId: '23456789',
    kraPin: 'A002345678B',
    employer: 'Nairobi County',
    occupation: 'Nurse',
    dateOfBirth: new Date('1990-03-22'),
    fosaBalance: 60000,
    bosaBalance: 150000,
  },
  {
    email: 'member3@beba-sacco.com',
    firstName: 'Peter',
    lastName: 'Mwangi',
    phone: '+254712345680',
    memberNumber: 'M-000003',
    nationalId: '34567890',
    kraPin: 'A003456789B',
    employer: 'Kenya Power',
    occupation: 'Technician',
    dateOfBirth: new Date('1988-11-05'),
    fosaBalance: 45000,
    bosaBalance: 95000,
  },
];

async function run() {
  log('=== SEEDING TEST BORROWER/GUARANTOR ACCOUNTS ===');

  const tenant = await p.tenant.findUnique({ where: { slug: 'beba-sacco' } });
  if (!tenant) {
    throw new Error('beba-sacco tenant not found — run seed_demo_accounts.js first');
  }
  log('Tenant ID: ' + tenant.id);

  // The original demo member (member@beba-sacco.com) was seeded with KYC
  // stuck at PENDING_UPLOAD, which blocks loan applications entirely
  // (validateMemberEligibility requires kycStatus === APPROVED). Approve it
  // so the existing demo borrower is actually usable for end-to-end testing.
  const existingMemberUser = await p.user.findFirst({
    where: { tenantId: tenant.id, email: 'member@beba-sacco.com' },
  });
  if (existingMemberUser) {
    await p.member.update({
      where: { userId: existingMemberUser.id },
      data: { kycStatus: 'APPROVED' },
    });
    log('Approved KYC for existing demo member: member@beba-sacco.com');
  }

  const memberHash = await argon2.hash('Member@1234', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });

  for (const m of NEW_MEMBERS) {
    const user = await p.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: m.email } },
      update: { passwordHash: memberHash, accountStatus: 'ACTIVE' },
      create: {
        tenantId: tenant.id,
        email: m.email,
        passwordHash: memberHash,
        firstName: m.firstName,
        lastName: m.lastName,
        phone: m.phone,
        role: 'MEMBER',
        accountStatus: 'ACTIVE',
        emailVerified: true,
      },
    });
    log('User upserted: ' + user.email);

    const member = await p.member.upsert({
      where: { userId: user.id },
      update: { kycStatus: 'APPROVED', isActive: true, isBlacklisted: false },
      create: {
        tenantId: tenant.id,
        userId: user.id,
        memberNumber: m.memberNumber,
        nationalId: m.nationalId,
        kraPin: m.kraPin,
        employer: m.employer,
        occupation: m.occupation,
        dateOfBirth: m.dateOfBirth,
        isActive: true,
        kycStatus: 'APPROVED',
        joinedAt: new Date('2024-01-01'),
      },
    });
    log('Member profile upserted: ' + member.memberNumber + ' (KYC APPROVED)');

    await p.account.upsert({
      where: { tenantId_accountNumber: { tenantId: tenant.id, accountNumber: 'ACC-FOSA-' + m.memberNumber.replace('M-', '') } },
      update: { balance: m.fosaBalance },
      create: {
        tenantId: tenant.id,
        memberId: member.id,
        accountNumber: 'ACC-FOSA-' + m.memberNumber.replace('M-', ''),
        accountType: 'FOSA',
        balance: m.fosaBalance,
        isActive: true,
      },
    });
    await p.account.upsert({
      where: { tenantId_accountNumber: { tenantId: tenant.id, accountNumber: 'ACC-BOSA-' + m.memberNumber.replace('M-', '') } },
      update: { balance: m.bosaBalance },
      create: {
        tenantId: tenant.id,
        memberId: member.id,
        accountNumber: 'ACC-BOSA-' + m.memberNumber.replace('M-', ''),
        accountType: 'BOSA',
        balance: m.bosaBalance,
        isActive: true,
      },
    });
    log('Accounts upserted: ACC-FOSA-' + m.memberNumber.replace('M-', '') + ' (KES ' + m.fosaBalance + '), ACC-BOSA-' + m.memberNumber.replace('M-', '') + ' (KES ' + m.bosaBalance + ')');
  }

  log('\n=== SUMMARY ===');
  log('Tenant ID: ' + tenant.id);
  log('X-Tenant-ID header: ' + tenant.id);
  log('member@beba-sacco.com  / Member@1234  (KYC now APPROVED) — M-000001, FOSA 50000 / BOSA 120000');
  log('member2@beba-sacco.com / Member@1234  (KYC APPROVED)     — M-000002, FOSA 60000 / BOSA 150000');
  log('member3@beba-sacco.com / Member@1234  (KYC APPROVED)     — M-000003, FOSA 45000 / BOSA 95000');
  log('\nAll three members are mutually eligible to guarantor each other\'s loans (FOSA accounts, KYC APPROVED, not blacklisted).');
  log('=== DONE ===');

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
