/**
 * Backfill Member <-> MemberApplication Links
 *
 * One-time script to populate Member.memberApplicationId for members that were
 * created before that relation existed (migration 20260716120000). Historically
 * Member and MemberApplication were only ever joined by a loose (tenantId, nationalId)
 * string match at read time — this script makes that link durable and queryable.
 *
 * Matching rule mirrors the one onboarding.service.ts already uses for its own
 * idempotency check: same tenant, Member.nationalId === MemberApplication.idNumber,
 * application status APPROVED. applications.service.ts#create() rejects a new
 * application whose idNumber duplicates an existing one for the tenant, so this
 * match is expected to be unique; the script still guards against and reports the
 * unexpected case where it isn't.
 *
 * Usage:
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     src/database/scripts/backfill-member-applications.ts [--dry-run]
 *
 * Or via npm script:
 *   npm run backfill:member-applications
 *   npm run backfill:member-applications -- --dry-run
 */

import { ApplicationStatus, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface BackfillStats {
  total: number;
  linked: number;
  ambiguous: number;
  orphans: number;
  errors: number;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Backfill Member <-> MemberApplication Links');
  console.log(`  Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const unlinkedMembers = await prisma.member.findMany({
    where: { memberApplicationId: null, nationalId: { not: null } },
    select: { id: true, tenantId: true, memberNumber: true, nationalId: true },
    orderBy: { joinedAt: 'asc' },
  });

  console.log(`Found ${unlinkedMembers.length} member(s) without a linked application.\n`);

  if (unlinkedMembers.length === 0) {
    console.log('✅ All members with a nationalId are already linked. Nothing to do.');
    return;
  }

  const stats: BackfillStats = {
    total: unlinkedMembers.length,
    linked: 0,
    ambiguous: 0,
    orphans: 0,
    errors: 0,
  };

  for (const [index, member] of unlinkedMembers.entries()) {
    const progress = `[${index + 1}/${stats.total}]`;

    try {
      const candidates = await prisma.memberApplication.findMany({
        where: {
          tenantId: member.tenantId,
          idNumber: member.nationalId!,
          status: ApplicationStatus.APPROVED,
        },
        select: { id: true },
      });

      if (candidates.length === 0) {
        console.log(`${progress} ⏭️  ${member.memberNumber}: no matching APPROVED application (orphan)`);
        stats.orphans++;
        continue;
      }

      if (candidates.length > 1) {
        console.warn(
          `${progress} ⚠️  ${member.memberNumber}: ${candidates.length} matching applications found ` +
          `for nationalId ${member.nationalId} — skipping, needs manual review`,
        );
        stats.ambiguous++;
        continue;
      }

      const [application] = candidates;

      if (dryRun) {
        console.log(`${progress} DRY RUN: Would link ${member.memberNumber} -> application ${application.id}`);
        stats.linked++;
        continue;
      }

      await prisma.member.update({
        where: { id: member.id },
        data: { memberApplicationId: application.id },
      });
      console.log(`${progress} ✅ ${member.memberNumber}: linked to application ${application.id}`);
      stats.linked++;
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
  console.log(`  Successfully linked: ${stats.linked}`);
  console.log(`  Orphans (no matching application): ${stats.orphans}`);
  console.log(`  Ambiguous (multiple matches, skipped): ${stats.ambiguous}`);
  console.log(`  Errors: ${stats.errors}`);
  console.log(`  Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (stats.errors > 0 || stats.ambiguous > 0) {
    console.log('⚠️  Some members were not linked. Review the warnings above.');
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
