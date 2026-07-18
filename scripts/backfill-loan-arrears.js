/**
 * Phase 2 data migration: recompute Loan.arrearsDays / arrearsAmount / staging
 * (and, where applicable, transition status -> DEFAULTED) for every active
 * loan using the NEW installment-based logic, replacing the old values that
 * were computed against Loan.dueDate (the loan's final maturity date) — see
 * FinancialService.applyOverdueInstallmentsAndArrears() for the live
 * equivalent of this same formula, now run daily instead of this one-off.
 *
 * This does NOT retroactively accrue missed daily penalties for the period the
 * old buggy job was running — it only recomputes arrears/staging from
 * whatever LoanRepayment.principalDue/interestDue/penaltyDue/*Paid values
 * already exist right now. Going forward, the daily accrual job keeps those
 * penalty fields (and therefore this rollup) correctly maintained.
 *
 * Safe by default: running with no flags is a DRY RUN — it only prints what
 * would change. Pass --apply to actually write the updates.
 *
 * Usage:
 *   node scripts/backfill-loan-arrears.js                 # dry run, all tenants
 *   node scripts/backfill-loan-arrears.js --apply          # apply, all tenants
 *   node scripts/backfill-loan-arrears.js --tenant=<id>     # scope to one tenant (dry run)
 *   node scripts/backfill-loan-arrears.js --tenant=<id> --apply
 */

const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  try {
    const envContent = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const dbUrl = envContent.match(/DATABASE_URL="([^"]+)"/)?.[1];
    if (dbUrl) process.env.DATABASE_URL = dbUrl;
  } catch {
    // .env not found — DATABASE_URL must be set in the environment
  }
}

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set. Pass it as an env var or add it to backend/.env');
  process.exit(1);
}

const { PrismaClient, LoanStatus } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const TENANT_ARG = process.argv.find((a) => a.startsWith('--tenant='));
const TENANT_ID = TENANT_ARG ? TENANT_ARG.split('=')[1] : null;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function classifyStaging(arrearsDays) {
  if (arrearsDays >= 90) return 'NPL';
  if (arrearsDays >= 30) return 'WATCHLIST';
  return 'PERFORMING';
}

function dec(v) {
  return Number(v ?? 0);
}

/** Same formula as FinancialService.applyOverdueInstallmentsAndArrears()'s rollup step. */
function computeArrears(installments, today) {
  const overdue = installments.filter((i) => i.status !== 'PAID' && new Date(i.dueDate) < today);
  if (overdue.length === 0) {
    return { arrearsDays: 0, arrearsAmount: 0, staging: classifyStaging(0) };
  }
  overdue.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
  const earliestDueDate = new Date(overdue[0].dueDate);
  const arrearsDays = Math.floor((today.getTime() - earliestDueDate.getTime()) / MS_PER_DAY);

  const arrearsAmount = overdue.reduce((sum, row) => {
    const due = dec(row.principalDue) + dec(row.interestDue) + dec(row.penaltyDue);
    const paid = dec(row.principalPaid) + dec(row.interestPaid) + dec(row.penaltyPaid);
    return sum + Math.max(due - paid, 0);
  }, 0);

  return { arrearsDays, arrearsAmount: Math.round(arrearsAmount * 10000) / 10000, staging: classifyStaging(arrearsDays) };
}

async function run() {
  console.log(`=== Phase 2 arrears backfill — ${APPLY ? 'APPLY' : 'DRY RUN'} ===`);
  if (TENANT_ID) console.log(`Scoped to tenant: ${TENANT_ID}`);

  const loans = await prisma.loan.findMany({
    where: {
      status: { in: [LoanStatus.ACTIVE, LoanStatus.DISBURSED, LoanStatus.DEFAULTED] },
      ...(TENANT_ID && { tenantId: TENANT_ID }),
    },
    select: {
      id: true,
      tenantId: true,
      loanNumber: true,
      status: true,
      arrearsDays: true,
      arrearsAmount: true,
      staging: true,
    },
  });

  console.log(`Found ${loans.length} loan(s) to evaluate.\n`);

  const today = new Date();
  let changed = 0;
  let wouldDefault = 0;

  for (const loan of loans) {
    const installments = await prisma.loanRepayment.findMany({
      where: { tenantId: loan.tenantId, loanId: loan.id, status: { not: 'PAID' } },
      select: {
        dueDate: true,
        status: true,
        principalDue: true,
        interestDue: true,
        penaltyDue: true,
        principalPaid: true,
        interestPaid: true,
        penaltyPaid: true,
      },
    });

    const next = computeArrears(installments, today);
    const oldArrearsDays = loan.arrearsDays;
    const oldArrearsAmount = dec(loan.arrearsAmount);
    const oldStaging = loan.staging;

    const staysDefaulted = loan.status === LoanStatus.DEFAULTED;
    const transitionsToDefaulted = !staysDefaulted && next.staging === 'NPL';

    const unchanged =
      oldArrearsDays === next.arrearsDays &&
      Math.abs(oldArrearsAmount - next.arrearsAmount) < 0.0001 &&
      oldStaging === next.staging &&
      !transitionsToDefaulted;

    if (unchanged) continue;

    changed++;
    if (transitionsToDefaulted) wouldDefault++;

    console.log(
      `Loan ${loan.loanNumber ?? loan.id} (${loan.status}): ` +
        `arrearsDays ${oldArrearsDays} -> ${next.arrearsDays}, ` +
        `arrearsAmount ${oldArrearsAmount.toFixed(2)} -> ${next.arrearsAmount.toFixed(2)}, ` +
        `staging ${oldStaging} -> ${next.staging}` +
        (transitionsToDefaulted ? ' [-> DEFAULTED]' : ''),
    );

    if (APPLY) {
      await prisma.loan.update({
        where: { id: loan.id },
        data: {
          arrearsDays: next.arrearsDays,
          arrearsAmount: next.arrearsAmount.toString(),
          staging: next.staging,
          ...(transitionsToDefaulted && { status: LoanStatus.DEFAULTED }),
        },
      });
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Evaluated: ${loans.length}`);
  console.log(`${APPLY ? 'Updated' : 'Would update'}: ${changed}`);
  console.log(`${APPLY ? 'Transitioned' : 'Would transition'} to DEFAULTED: ${wouldDefault}`);
  if (!APPLY && changed > 0) {
    console.log(`\nThis was a DRY RUN — no data was written. Re-run with --apply to persist these changes.`);
  }

  await prisma.$disconnect();
}

run().catch(async (e) => {
  console.error('FATAL ERROR:', e);
  await prisma.$disconnect();
  process.exit(1);
});
