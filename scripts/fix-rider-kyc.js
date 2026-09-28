/**
 * Quick fix script:
 * 1. Re-run rider seed to update Lucy's balances
 * 2. Clear all 6 test riders from KYC queue (mark KYC fully approved with
 *    review timestamps) and delete/approve any lingering documents.
 *
 * Usage: node scripts/fix-rider-kyc.js
 */

const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  try {
    const envContent = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const dbUrl = envContent.match(/DATABASE_URL="([^"]+)"/)?.[1];
    if (dbUrl) process.env.DATABASE_URL = dbUrl;
  } catch {}
}
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const RIDER_EMAILS = [
  'rider1@beba-sacco.com',
  'rider2@beba-sacco.com',
  'rider3@beba-sacco.com',
  'rider4@beba-sacco.com',
  'rider5@beba-sacco.com',
  'rider6@beba-sacco.com',
];

async function main() {
  console.log('🔧 Fixing rider KYC & documents...\n');

  // 1. Find all rider users + their member records
  const riders = await prisma.user.findMany({
    where: { email: { in: RIDER_EMAILS } },
    select: { id: true, email: true, firstName: true, lastName: true, member: { select: { id: true, memberNumber: true } } },
    orderBy: { email: 'asc' },
  });

  console.log(`  Found ${riders.length} rider(s)\n`);

  for (const rider of riders) {
    if (!rider.member) {
      console.log(`  ⚠️  ${rider.email} has no member profile — skipping`);
      continue;
    }

    const memberId = rider.member.id;

    // 2. Update member KYC status to fully APPROVED with review metadata
    await prisma.member.update({
      where: { id: memberId },
      data: {
        kycStatus: 'APPROVED',
        kycReviewedAt: new Date(),
        kycReviewedByUserId: null, // system-cleared
        kycRejectionReason: null,
        kycReviewNotes: 'Test rider — KYC auto-cleared for testing',
        kycChecklist: null,
      },
    });

    // 3. Delete any pending documents so they don't show in queues
    const docs = await prisma.document.findMany({
      where: { memberId },
      select: { id: true, status: true, type: true },
    });

    if (docs.length > 0) {
      // Mark all documents as APPROVED (or delete them)
      const updated = await prisma.document.updateMany({
        where: { memberId },
        data: {
          status: 'APPROVED',
          reviewedAt: new Date(),
          rejectionReason: null,
        },
      });
      console.log(`  ✅ ${rider.firstName} ${rider.lastName} — KYC cleared, ${updated.count} doc(s) approved`);
    } else {
      console.log(`  ✅ ${rider.firstName} ${rider.lastName} — KYC cleared, no documents to clear`);
    }
  }

  // 4. Update Lucy Akinyi's balances
  console.log('\n💰 Updating Lucy Akinyi balances...');
  const lucyMember = riders.find(r => r.email === 'rider6@beba-sacco.com');
  if (lucyMember && lucyMember.member) {
    await prisma.account.updateMany({
      where: { memberId: lucyMember.member.id, accountType: 'FOSA' },
      data: { balance: 25000 },
    });
    await prisma.account.updateMany({
      where: { memberId: lucyMember.member.id, accountType: 'BOSA' },
      data: { balance: 40000 },
    });
    console.log('  ✅ Lucy Akinyi — FOSA: KES 25,000 | BOSA: KES 40,000');
  }

  console.log('\n✅ All done — riders are cleared from KYC queue.');
}

main()
  .catch((e) => {
    console.error('❌ Failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
