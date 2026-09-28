/**
 * Seed 6 test rider-members with varied FOSA + BOSA balances,
 * create a stage ("Kitisuru Boda Stage") under Kitisuru ward,
 * and assign every rider to it.
 *
 * Fully idempotent (upserts everywhere) — safe to re-run.
 *
 * Usage:
 *   node scripts/seed-test-riders.js
 *
 * Requires:
 *   - Location data already seeded (node scripts/seed-locations.js)
 *   - Beba SACCO tenant already exists
 */

const fs = require('fs');
const path = require('path');

// ─── Env bootstrap ──────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  try {
    const envContent = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const dbUrl = envContent.match(/DATABASE_URL="([^"]+)"/)?.[1];
    if (dbUrl) process.env.DATABASE_URL = dbUrl;
  } catch {
    // .env not found — DATABASE_URL must be set in environment
  }
}
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');
const prisma = new PrismaClient();

// ─── Constants ──────────────────────────────────────────────────────────────

const TENANT_ID = '1011f6c3-5e43-4e59-affa-b7212d278688';
const RIDER_PASSWORD = 'Rider@2026!';
const ARGON2_OPTS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 };

// Ward code for Kitisuru (seeded by seed-locations.js)
const KITISURU_WARD_CODE = 'KE-047-001-001';
const STAGE_NAME = 'Kitisuru Boda Stage';

/**
 * Six riders with different financial profiles to exercise
 * various UI / business-logic scenarios:
 *
 *  1. High earner – large balances in both accounts
 *  2. Moderate saver – decent BOSA, small FOSA
 *  3. New rider – minimal opening balances
 *  4. FOSA-heavy – all liquidity in FOSA, low BOSA
 *  5. BOSA-heavy – savings-oriented, lean FOSA
 *  6. Zero-balance – freshly opened accounts
 */
const RIDERS = [
  {
    email: 'rider1@beba-sacco.com',
    firstName: 'James',
    lastName: 'Mwangi',
    phone: '+254711000001',
    idNumber: 'RIDER-ID-001',
    memberNumber: 'R-0001',
    nationalId: '40001001',
    kraPin: 'A400010011B',
    fosaBalance: 85_000,
    bosaBalance: 250_000,
    position: 'MEMBER',
  },
  {
    email: 'rider2@beba-sacco.com',
    firstName: 'Faith',
    lastName: 'Nyambura',
    phone: '+254711000002',
    idNumber: 'RIDER-ID-002',
    memberNumber: 'R-0002',
    nationalId: '40001002',
    kraPin: 'A400010022B',
    fosaBalance: 12_500,
    bosaBalance: 65_000,
    position: 'MEMBER',
  },
  {
    email: 'rider3@beba-sacco.com',
    firstName: 'Kevin',
    lastName: 'Odhiambo',
    phone: '+254711000003',
    idNumber: 'RIDER-ID-003',
    memberNumber: 'R-0003',
    nationalId: '40001003',
    kraPin: 'A400010033B',
    fosaBalance: 3_200,
    bosaBalance: 8_500,
    position: 'MEMBER',
  },
  {
    email: 'rider4@beba-sacco.com',
    firstName: 'Mercy',
    lastName: 'Wangari',
    phone: '+254711000004',
    idNumber: 'RIDER-ID-004',
    memberNumber: 'R-0004',
    nationalId: '40001004',
    kraPin: 'A400010044B',
    fosaBalance: 120_000,
    bosaBalance: 15_000,
    position: 'MEMBER',
  },
  {
    email: 'rider5@beba-sacco.com',
    firstName: 'Brian',
    lastName: 'Kipchoge',
    phone: '+254711000005',
    idNumber: 'RIDER-ID-005',
    memberNumber: 'R-0005',
    nationalId: '40001005',
    kraPin: 'A400010055B',
    fosaBalance: 5_000,
    bosaBalance: 180_000,
    position: 'MEMBER',
  },
  {
    email: 'rider6@beba-sacco.com',
    firstName: 'Lucy',
    lastName: 'Akinyi',
    phone: '+254711000006',
    idNumber: 'RIDER-ID-006',
    memberNumber: 'R-0006',
    nationalId: '40001006',
    kraPin: 'A400010066B',
    fosaBalance: 25_000,
    bosaBalance: 40_000,
    position: 'MEMBER',
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

async function upsertRiderUser(tenantId, rider, passwordHash) {
  return prisma.user.upsert({
    where: { tenantId_email: { tenantId, email: rider.email } },
    update: { passwordHash, role: 'MEMBER', accountStatus: 'ACTIVE' },
    create: {
      tenantId,
      email: rider.email,
      passwordHash,
      firstName: rider.firstName,
      lastName: rider.lastName,
      phone: rider.phone,
      idNumber: rider.idNumber,
      role: 'MEMBER',
      accountStatus: 'ACTIVE',
      emailVerified: true,
      phoneVerified: true,
      mustChangePassword: false,
    },
  });
}

async function upsertMember(tenantId, userId, rider) {
  return prisma.member.upsert({
    where: { userId },
    update: { kycStatus: 'APPROVED', isActive: true },
    create: {
      tenantId,
      userId,
      memberNumber: rider.memberNumber,
      nationalId: rider.nationalId,
      kraPin: rider.kraPin,
      kycStatus: 'APPROVED',
      isActive: true,
    },
  });
}

async function upsertAccount(tenantId, memberId, accountNumber, accountType, balance) {
  return prisma.account.upsert({
    where: { tenantId_accountNumber: { tenantId, accountNumber } },
    update: { balance, isActive: true },
    create: {
      tenantId,
      memberId,
      accountNumber,
      accountType,
      balance,
      isActive: true,
    },
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('🏍️  Seeding 6 test riders...\n');

  // 1. Verify tenant exists
  const tenant = await prisma.tenant.findUnique({ where: { id: TENANT_ID } });
  if (!tenant) {
    console.error(`❌ Tenant ${TENANT_ID} not found. Run seed_demo_accounts.js first.`);
    process.exit(1);
  }
  console.log(`  Tenant: "${tenant.name}" (${tenant.id})`);

  // 2. Locate Kitisuru ward (must exist from seed-locations.js)
  let ward = await prisma.ward.findUnique({ where: { code: KITISURU_WARD_CODE } });
  if (!ward) {
    console.log('  ⚠️  Kitisuru ward not found — creating minimal location hierarchy...');
    // Create a minimal County → Constituency → Ward chain for the stage
    const county = await prisma.county.upsert({
      where: { code: 'KE-047' },
      create: { code: 'KE-047', name: 'Nairobi City' },
      update: {},
    });
    const constituency = await prisma.constituency.upsert({
      where: { code: 'KE-047-001' },
      create: { code: 'KE-047-001', name: 'Westlands', countyId: county.id },
      update: {},
    });
    ward = await prisma.ward.upsert({
      where: { code: KITISURU_WARD_CODE },
      create: { code: KITISURU_WARD_CODE, name: 'Kitisuru', constituencyId: constituency.id },
      update: {},
    });
  }
  console.log(`  Ward: "${ward.name}" (${ward.id})`);

  // 3. Upsert the stage
  const stage = await prisma.stage.upsert({
    where: { name_wardId_tenantId: { name: STAGE_NAME, wardId: ward.id, tenantId: TENANT_ID } },
    update: {},
    create: { name: STAGE_NAME, wardId: ward.id, tenantId: TENANT_ID },
  });
  console.log(`  Stage: "${stage.name}" (${stage.id})\n`);

  // 4. Hash the shared rider password once
  const passwordHash = await argon2.hash(RIDER_PASSWORD, ARGON2_OPTS);

  // 5. Seed each rider
  const summary = [];

  for (const rider of RIDERS) {
    // User
    const user = await upsertRiderUser(TENANT_ID, rider, passwordHash);

    // Member profile
    const member = await upsertMember(TENANT_ID, user.id, rider);

    // FOSA + BOSA accounts
    const fosaAccNum = `${rider.memberNumber}-FOSA`;
    const bosaAccNum = `${rider.memberNumber}-BOSA`;
    await upsertAccount(TENANT_ID, member.id, fosaAccNum, 'FOSA', rider.fosaBalance);
    await upsertAccount(TENANT_ID, member.id, bosaAccNum, 'BOSA', rider.bosaBalance);

    // Assign to stage (StageAssignment — links User to Stage)
    await prisma.stageAssignment.upsert({
      where: { userId_stageId: { userId: user.id, stageId: stage.id } },
      update: { position: rider.position, isActive: true },
      create: {
        userId: user.id,
        stageId: stage.id,
        position: rider.position,
        isActive: true,
      },
    });

    // Also create MemberStage (links Member to Stage)
    await prisma.memberStage.upsert({
      where: { memberId_stageId: { memberId: member.id, stageId: stage.id } },
      update: { isActive: true },
      create: {
        memberId: member.id,
        stageId: stage.id,
        isActive: true,
      },
    });

    const fosaFormatted = rider.fosaBalance.toLocaleString('en-KE');
    const bosaFormatted = rider.bosaBalance.toLocaleString('en-KE');
    console.log(
      `  ✅ ${rider.firstName} ${rider.lastName} (${rider.email})` +
      `  FOSA: KES ${fosaFormatted} | BOSA: KES ${bosaFormatted} | ${rider.position}`,
    );

    summary.push({
      email: rider.email,
      userId: user.id,
      memberId: member.id,
      memberNumber: rider.memberNumber,
      position: rider.position,
      fosaBalance: rider.fosaBalance,
      bosaBalance: rider.bosaBalance,
    });
  }

  console.log('\n─────────────────────────────────────────────────────');
  console.log('📋 SUMMARY');
  console.log('─────────────────────────────────────────────────────');
  console.log(`  Tenant ID:   ${TENANT_ID}`);
  console.log(`  Stage:       ${STAGE_NAME} (${stage.id})`);
  console.log(`  Password:    ${RIDER_PASSWORD}`);
  console.log(`  Riders:      ${summary.length}`);
  console.log('─────────────────────────────────────────────────────\n');
  console.log(JSON.stringify({ tenantId: TENANT_ID, stage: { id: stage.id, name: STAGE_NAME }, password: RIDER_PASSWORD, riders: summary }, null, 2));
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
