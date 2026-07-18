/**
 * Phase 3 data migration: recompute the principalDue/interestDue split on
 * every existing LoanRepayment row (they were created with interestDue
 * hard-coded to 0 and principalDue set to the WHOLE instalment), and fix
 * amountPaid (it was seeded to the scheduled instalment amount at creation
 * instead of 0, and was never updated by the repayment waterfall since).
 *
 * Uses the exact same amortization split as LoansService.
 * buildAmortizationSchedule() — REDUCING_BALANCE splits interest off the
 * outstanding balance each period (decreasing interestDue / increasing
 * principalDue); FLAT splits the total-tenure interest evenly (identical
 * interestDue every period). See that method for the authoritative version;
 * this script re-implements it standalone since it has no access to the
 * NestJS DI container.
 *
 * Deliberately does NOT touch `status` (PAID/PARTIAL/PENDING/OVERDUE) — only
 * principalDue, interestDue, and amountPaid, exactly as scoped. Re-deriving
 * status retroactively from the corrected due-amounts is out of scope here.
 *
 * Safe by default: running with no flags is a DRY RUN — it only prints what
 * would change. Pass --apply to actually write the updates.
 *
 * Usage:
 *   node scripts/backfill-loan-schedules.js                  # dry run, all tenants
 *   node scripts/backfill-loan-schedules.js --apply           # apply, all tenants
 *   node scripts/backfill-loan-schedules.js --tenant=<id>      # scope to one tenant (dry run)
 *   node scripts/backfill-loan-schedules.js --tenant=<id> --apply
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

const { PrismaClient, LoanStatus, InterestType } = require('@prisma/client');
const { Decimal } = require('decimal.js');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const TENANT_ARG = process.argv.find((a) => a.startsWith('--tenant='));
const TENANT_ID = TENANT_ARG ? TENANT_ARG.split('=')[1] : null;

/** Mirrors LoansService.buildAmortizationSchedule() exactly. */
function buildAmortizationSchedule(principal, annualRate, tenureMonths, interestType, instalment) {
  const schedule = [];

  if (interestType === InterestType.FLAT) {
    const totalInterest = principal.times(annualRate).times(tenureMonths).dividedBy(12).toDecimalPlaces(4);
    const interestPerPeriod = totalInterest.dividedBy(tenureMonths).toDecimalPlaces(4);

    let principalAccrued = new Decimal(0);
    let interestAccrued = new Decimal(0);
    for (let i = 1; i <= tenureMonths; i++) {
      const isLast = i === tenureMonths;
      const interestDue = isLast ? totalInterest.minus(interestAccrued) : interestPerPeriod;
      const principalDue = isLast
        ? principal.minus(principalAccrued)
        : instalment.minus(interestPerPeriod).toDecimalPlaces(4);
      principalAccrued = principalAccrued.plus(principalDue);
      interestAccrued = interestAccrued.plus(interestDue);
      schedule.push({ principalDue, interestDue });
    }
    return schedule;
  }

  // REDUCING_BALANCE
  const monthlyRate = annualRate.dividedBy(12);
  let outstanding = principal;
  let principalAccrued = new Decimal(0);
  for (let i = 1; i <= tenureMonths; i++) {
    const isLast = i === tenureMonths;
    const interestDue = monthlyRate.isZero() ? new Decimal(0) : outstanding.times(monthlyRate).toDecimalPlaces(4);
    const principalDue = isLast
      ? principal.minus(principalAccrued)
      : Decimal.min(instalment.minus(interestDue).toDecimalPlaces(4), outstanding);
    outstanding = outstanding.minus(principalDue).toDecimalPlaces(4);
    principalAccrued = principalAccrued.plus(principalDue);
    schedule.push({ principalDue, interestDue });
  }
  return schedule;
}

function dec(v) {
  return new Decimal(v?.toString() ?? '0');
}

async function run() {
  console.log(`=== Phase 3 loan schedule backfill — ${APPLY ? 'APPLY' : 'DRY RUN'} ===`);
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
      principalAmount: true,
      interestRate: true,
      tenureMonths: true,
      monthlyInstalment: true,
      loanProduct: { select: { interestType: true } },
    },
  });

  console.log(`Found ${loans.length} loan(s) to evaluate.\n`);

  let loansTouched = 0;
  let rowsChanged = 0;
  let rowsEvaluated = 0;

  for (const loan of loans) {
    const rows = await prisma.loanRepayment.findMany({
      where: { tenantId: loan.tenantId, loanId: loan.id },
      orderBy: { dayNumber: 'asc' },
    });
    if (rows.length === 0) continue;

    const schedule = buildAmortizationSchedule(
      dec(loan.principalAmount),
      dec(loan.interestRate),
      loan.tenureMonths,
      loan.loanProduct.interestType,
      dec(loan.monthlyInstalment),
    );

    let loanHasChanges = false;

    for (const row of rows) {
      rowsEvaluated++;
      const period = schedule[row.dayNumber - 1];
      if (!period) {
        console.warn(
          `  WARN: loan ${loan.loanNumber ?? loan.id} installment dayNumber=${row.dayNumber} has no matching ` +
            `amortization period (tenureMonths=${loan.tenureMonths}) — skipping this row`,
        );
        continue;
      }

      const newPrincipalDue = period.principalDue.toDecimalPlaces(4);
      const newInterestDue = period.interestDue.toDecimalPlaces(4);
      const newAmountPaid = dec(row.principalPaid).plus(dec(row.interestPaid)).plus(dec(row.penaltyPaid)).toDecimalPlaces(4);

      const oldPrincipalDue = dec(row.principalDue);
      const oldInterestDue = dec(row.interestDue);
      const oldAmountPaid = dec(row.amountPaid);

      const unchanged =
        oldPrincipalDue.minus(newPrincipalDue).abs().lessThan('0.0001') &&
        oldInterestDue.minus(newInterestDue).abs().lessThan('0.0001') &&
        oldAmountPaid.minus(newAmountPaid).abs().lessThan('0.0001');

      if (unchanged) continue;

      rowsChanged++;
      loanHasChanges = true;
      console.log(
        `  Loan ${loan.loanNumber ?? loan.id} installment #${row.dayNumber}: ` +
          `principalDue ${oldPrincipalDue.toFixed(2)} -> ${newPrincipalDue.toFixed(2)}, ` +
          `interestDue ${oldInterestDue.toFixed(2)} -> ${newInterestDue.toFixed(2)}, ` +
          `amountPaid ${oldAmountPaid.toFixed(2)} -> ${newAmountPaid.toFixed(2)}`,
      );

      if (APPLY) {
        await prisma.loanRepayment.update({
          where: { id: row.id },
          data: {
            principalDue: newPrincipalDue.toString(),
            interestDue: newInterestDue.toString(),
            amountPaid: newAmountPaid.toString(),
          },
        });
      }
    }

    if (loanHasChanges) loansTouched++;
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Loans evaluated: ${loans.length}`);
  console.log(`Loans with changes: ${loansTouched}`);
  console.log(`Installment rows evaluated: ${rowsEvaluated}`);
  console.log(`Installment rows ${APPLY ? 'updated' : 'would update'}: ${rowsChanged}`);
  if (!APPLY && rowsChanged > 0) {
    console.log(`\nThis was a DRY RUN — no data was written. Re-run with --apply to persist these changes.`);
  }

  await prisma.$disconnect();
}

run().catch(async (e) => {
  console.error('FATAL ERROR:', e);
  await prisma.$disconnect();
  process.exit(1);
});
