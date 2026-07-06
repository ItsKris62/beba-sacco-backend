/**
 * Backfill Missing FOSA/BOSA Accounts
 *
 * One-time script to provision missing accounts for existing members
 * who were created via code paths that didn't auto-provision them.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     src/database/scripts/backfill-missing-accounts.ts [--dry-run]
 *
 * Or via npm script:
 *   npm run backfill:accounts
 *   npm run backfill:accounts -- --dry-run
 */

import { PrismaClient } from '@prisma/client';
import { provisionMemberAccounts } from '../../modules/accounts/utils/provision-accounts.util';

const prisma = new PrismaClient();

interface BackfillStats {
  total: number;
  provisioned: number;
  skipped: number;
  errors: number;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Backfill Missing FOSA/BOSA Accounts');
  console.log(`  Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // Find active members missing one or both account types
  const membersWithGaps = await prisma.$queryRaw<
    Array<{ id: string; memberNumber: string; tenantId: string; account_count: bigint }>
  >`
    SELECT m.id, m."memberNumber", m."tenantId",
           (
             SELECT COUNT(DISTINCT a."accountType")
             FROM "Account" a
             WHERE a."memberId" = m.id
               AND a."accountType" IN ('FOSA', 'BOSA')
               AND a."isActive" = true
           ) AS account_count
    FROM "Member" m
    WHERE m."isActive" = true
    HAVING (
      SELECT COUNT(DISTINCT a."accountType")
      FROM "Account" a
      WHERE a."memberId" = m.id
        AND a."accountType" IN ('FOSA', 'BOSA')
        AND a."isActive" = true
    ) < 2
    ORDER BY m."createdAt" ASC
  `;

  console.log(`Found ${membersWithGaps.length} member(s) with missing accounts.\n`);

  if (membersWithGaps.length === 0) {
    console.log('✅ All active members have both FOSA and BOSA accounts. Nothing to do.');
    return;
  }

  const stats: BackfillStats = { total: membersWithGaps.length, provisioned: 0, skipped: 0, errors: 0 };

  for (const [index, member] of membersWithGaps.entries()) {
    const existingCount = Number(member.account_count);
    const progress = `[${index + 1}/${stats.total}]`;

    try {
      if (dryRun) {
        console.log(
          `${progress} DRY RUN: Would provision accounts for ${member.memberNumber} ` +
          `(tenant: ${member.tenantId}, existing: ${existingCount}/2)`,
        );
        stats.provisioned++;
        continue;
      }

      const result = await prisma.$transaction(async (tx) => {
        return provisionMemberAccounts(tx, member.tenantId, member.id);
      });

      if (result.created.length > 0) {
        console.log(
          `${progress} ✅ ${member.memberNumber}: created ${result.created.join(', ')}` +
          (result.skipped.length > 0 ? ` (skipped: ${result.skipped.join(', ')})` : ''),
        );
        stats.provisioned++;
      } else {
        console.log(`${progress} ⏭️  ${member.memberNumber}: already has both accounts`);
        stats.skipped++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${progress} ❌ ${member.memberNumber}: ${message}`);
      stats.errors++;
      // Continue processing remaining members — don't crash on individual failures
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Backfill Summary');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Total members processed: ${stats.total}`);
  console.log(`  Successfully provisioned: ${stats.provisioned}`);
  console.log(`  Skipped (already complete): ${stats.skipped}`);
  console.log(`  Errors: ${stats.errors}`);
  console.log(`  Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (stats.errors > 0) {
    console.log('⚠️  Some members failed. Review the errors above and re-run the script.');
    process.exitCode = 1;
  } else {
    console.log('✅ Backfill completed successfully.');
  }
}

main()
  .catch((error) => {
    console.error('Fatal error during backfill:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
