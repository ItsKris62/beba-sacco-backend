import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { LoanStatus, TransactionType, TransactionStatus, InterestType, LoanStaging } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';

/**
 * FinancialService – Phase 4
 *
 * Handles:
 *   1. Daily interest & penalty accrual
 *   2. Loan staging tag updates (PERFORMING / WATCHLIST / NPL)
 *   3. Loan repayment schedule: enqueue delayed instalment jobs
 *   4. Guarantor exposure enforcement
 *   5. Ledger integrity check (SUM credit – SUM debit = account balance)
 */
@Injectable()
export class FinancialService {
  private readonly logger = new Logger(FinancialService.name);

  // Idempotency lock TTL – 25 hours (longer than the 24h cron cadence)
  private readonly ACCRUAL_LOCK_TTL = 90_000; // 25 h in seconds

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // 1. INTEREST & PENALTY ACCRUAL
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Run daily interest + penalty accrual for ALL active loans in a tenant.
   *
   * Idempotency: Redis lock key `accrual:{tenantId}:{accrualDate}` prevents
   * duplicate runs if the cron fires twice in a day.
   *
   * Per-loan idempotency: `Loan.lastAccrualDate` checked before posting.
   */
  async runDailyAccrual(tenantId: string, accrualDate: string): Promise<{ processed: number; skipped: number }> {
    const lockKey = `accrual:${tenantId}:${accrualDate}`;

    // Distributed lock – SET NX with 25h TTL
    const locked = await this.redis.set(lockKey, '1', this.ACCRUAL_LOCK_TTL, true);
    if (!locked) {
      this.logger.warn(`Accrual already ran for tenant=${tenantId} date=${accrualDate} – skipping`);
      return { processed: 0, skipped: 0 };
    }

    const dateObj = new Date(accrualDate);
    const activeLoanStatuses: LoanStatus[] = [LoanStatus.ACTIVE, LoanStatus.DISBURSED];

    const loans = await this.prisma.loan.findMany({
      where: {
        tenantId,
        status: { in: activeLoanStatuses },
        // Skip loans already accrued today
        OR: [
          { lastAccrualDate: null },
          { lastAccrualDate: { lt: dateObj } },
        ],
      },
      include: {
        loanProduct: { select: { interestType: true } },
        member: {
          include: { accounts: { where: { accountType: 'FOSA', isActive: true }, take: 1 } },
        },
      },
    });

    let processed = 0;
    let skipped = 0;

    for (const loan of loans) {
      try {
        await this.accrueInterestForLoan(loan, dateObj);
        processed++;
      } catch (err) {
        this.logger.error(`Accrual failed for loan ${loan.id}`, err);
        skipped++;
      }
    }

    this.logger.log(`Accrual complete: tenant=${tenantId} date=${accrualDate} processed=${processed} skipped=${skipped}`);
    return { processed, skipped };
  }

  private async accrueInterestForLoan(
    loan: {
      id: string;
      tenantId: string;
      outstandingBalance: Decimal;
      principalAmount: Decimal;
      interestRate: Decimal;
      dueDate: Date | null;
      arrearsDays: number;
      loanProduct: { interestType: string };
      member: { accounts: { id: string; balance: Decimal }[] };
    },
    accrualDate: Date,
  ): Promise<void> {
    const outstanding = new Decimal(loan.outstandingBalance.toString());
    if (outstanding.lte(0)) return;

    const annualRate = new Decimal(loan.interestRate.toString());
    // Daily interest = outstanding * (annual_rate / 365)
    const dailyInterest = outstanding.times(annualRate).dividedBy(365).toDecimalPlaces(4);

    // Penalty: if past due date, add a daily penalty of 0.1% of outstanding
    const isPastDue = loan.dueDate && accrualDate > loan.dueDate;
    const dailyPenalty = isPastDue
      ? outstanding.times(0.001).toDecimalPlaces(4)
      : new Decimal(0);

    // Determine arrears days (days since due date)
    let newArrearsDays = 0;
    if (isPastDue && loan.dueDate) {
      const msPerDay = 24 * 60 * 60 * 1000;
      newArrearsDays = Math.floor((accrualDate.getTime() - loan.dueDate.getTime()) / msPerDay);
    }

    // Staging classification
    const staging = this.classifyStaging(newArrearsDays);

    // Find FOSA account to post the charge
    const fosaAccount = loan.member.accounts[0];
    if (!fosaAccount) {
      this.logger.warn(`No FOSA account for loan ${loan.id} – skipping accrual`);
      return;
    }

    const accrualDateStr = accrualDate.toISOString().split('T')[0];

    await this.prisma.$transaction(async (tx) => {
      // Post interest accrual transaction
      if (dailyInterest.gt(0)) {
        const balBefore = new Decimal(fosaAccount.balance.toString());
        const balAfter = balBefore.minus(dailyInterest); // debit from FOSA

        await tx.transaction.create({
          data: {
            tenantId: loan.tenantId,
            accountId: fosaAccount.id,
            loanId: loan.id,
            type: TransactionType.INTEREST_ACCRUAL,
            status: TransactionStatus.COMPLETED,
            amount: dailyInterest.toDecimalPlaces(4).toString(),
            balanceBefore: balBefore.toDecimalPlaces(4).toString(),
            balanceAfter: balAfter.toDecimalPlaces(4).toString(),
            reference: `ACCRUAL-${loan.id}-${accrualDateStr}-${uuidv4().split('-')[0]}`,
            description: `Daily interest accrual – ${accrualDateStr}`,
            processedBy: 'SYSTEM',
          },
        });

        await tx.account.update({
          where: { id: fosaAccount.id },
          data: { balance: balAfter.toDecimalPlaces(4).toString() },
        });
      }

      // Post penalty transaction
      if (dailyPenalty.gt(0)) {
        const refreshedAccount = await tx.account.findUnique({
          where: { id: fosaAccount.id },
          select: { balance: true },
        });
        const balBefore = new Decimal(refreshedAccount!.balance.toString());
        const balAfter = balBefore.minus(dailyPenalty);

        await tx.transaction.create({
          data: {
            tenantId: loan.tenantId,
            accountId: fosaAccount.id,
            loanId: loan.id,
            type: TransactionType.PENALTY,
            status: TransactionStatus.COMPLETED,
            amount: dailyPenalty.toDecimalPlaces(4).toString(),
            balanceBefore: balBefore.toDecimalPlaces(4).toString(),
            balanceAfter: balAfter.toDecimalPlaces(4).toString(),
            reference: `PENALTY-${loan.id}-${accrualDateStr}-${uuidv4().split('-')[0]}`,
            description: `Overdue penalty – ${accrualDateStr}`,
            processedBy: 'SYSTEM',
          },
        });

        await tx.account.update({
          where: { id: fosaAccount.id },
          data: { balance: balAfter.toDecimalPlaces(4).toString() },
        });
      }

      // Update loan arrears + staging
      await tx.loan.update({
        where: { id: loan.id },
        data: {
          arrearsDays: newArrearsDays,
          arrearsAmount: isPastDue
            ? new Decimal(loan.outstandingBalance.toString())
                .toDecimalPlaces(4)
                .toString()
            : '0',
          staging,
          lastAccrualDate: accrualDate,
          // Transition to DEFAULTED if NPL
          ...(staging === LoanStaging.NPL &&
            loan.loanProduct && { status: LoanStatus.DEFAULTED }),
        },
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. STAGING CLASSIFICATION
  // ─────────────────────────────────────────────────────────────────────────

  classifyStaging(arrearsDays: number): LoanStaging {
    if (arrearsDays >= 90) return LoanStaging.NPL;
    if (arrearsDays >= 30) return LoanStaging.WATCHLIST;
    return LoanStaging.PERFORMING;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. GUARANTOR EXPOSURE TRACKER
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns total active guarantee exposure for a member.
   * Blocks new guarantee if exposure > 150% of FOSA balance.
   */
  async getGuarantorExposure(
    memberId: string,
    tenantId: string,
  ): Promise<{ totalExposure: number; fosaBalance: number; exposureRatio: number; canGuarantee: boolean }> {
    const [guarantees, fosaAccount] = await Promise.all([
      this.prisma.guarantor.findMany({
        where: {
          memberId,
          tenantId,
          status: 'ACCEPTED',
          loan: { status: { in: [LoanStatus.ACTIVE, LoanStatus.DISBURSED, LoanStatus.APPROVED] } },
        },
        select: { guaranteedAmount: true },
      }),
      this.prisma.account.findFirst({
        where: { memberId, tenantId, accountType: 'FOSA', isActive: true },
        select: { balance: true },
      }),
    ]);

    const totalExposure = guarantees.reduce(
      (sum, g) => sum.plus(g.guaranteedAmount.toString()),
      new Decimal(0),
    );

    const fosaBalance = fosaAccount
      ? new Decimal(fosaAccount.balance.toString())
      : new Decimal(0);

    const maxAllowed = fosaBalance.times(1.5);
    const canGuarantee = totalExposure.lt(maxAllowed);
    const exposureRatio = fosaBalance.gt(0)
      ? totalExposure.dividedBy(fosaBalance).toNumber()
      : 0;

    return {
      totalExposure: totalExposure.toNumber(),
      fosaBalance: fosaBalance.toNumber(),
      exposureRatio,
      canGuarantee,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. LEDGER INTEGRITY CHECK
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Verifies that SUM(credits) - SUM(debits) == stored account balance for
   * every account in the tenant.
   *
   * Credit types: DEPOSIT, LOAN_DISBURSEMENT, INTEREST_EARNED, DIVIDEND_PAYOUT
   * Debit types:  WITHDRAWAL, LOAN_REPAYMENT, INTEREST_ACCRUAL, PENALTY, FEE_CHARGE
   *
   * Returns list of accounts with drift (expected vs actual).
   */
  async runLedgerIntegrityCheck(tenantId: string): Promise<{
    checked: number;
    driftCount: number;
    drifts: { accountId: string; accountNumber: string; expected: number; actual: number; drift: number }[];
  }> {
    const CREDIT_TYPES = [
      TransactionType.DEPOSIT,
      TransactionType.LOAN_DISBURSEMENT,
      TransactionType.INTEREST_EARNED,
      TransactionType.DIVIDEND_PAYOUT,
    ];
    const DEBIT_TYPES = [
      TransactionType.WITHDRAWAL,
      TransactionType.LOAN_REPAYMENT,
      TransactionType.INTEREST_ACCRUAL,
      TransactionType.PENALTY,
      TransactionType.FEE_CHARGE,
    ];

    const accounts = await this.prisma.account.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, accountNumber: true, balance: true },
    });

    const drifts: { accountId: string; accountNumber: string; expected: number; actual: number; drift: number }[] = [];

    for (const account of accounts) {
      const [credits, debits] = await this.prisma.$transaction([
        this.prisma.transaction.aggregate({
          where: {
            accountId: account.id,
            status: TransactionStatus.COMPLETED,
            type: { in: CREDIT_TYPES },
          },
          _sum: { amount: true },
        }),
        this.prisma.transaction.aggregate({
          where: {
            accountId: account.id,
            status: TransactionStatus.COMPLETED,
            type: { in: DEBIT_TYPES },
          },
          _sum: { amount: true },
        }),
      ]);

      const totalCredits = credits._sum.amount
        ? new Decimal(credits._sum.amount.toString())
        : new Decimal(0);
      const totalDebits = debits._sum.amount
        ? new Decimal(debits._sum.amount.toString())
        : new Decimal(0);

      const expectedBalance = totalCredits.minus(totalDebits);
      const actualBalance = new Decimal(account.balance.toString());
      const drift = actualBalance.minus(expectedBalance).abs().toNumber();

      if (drift > 0.0001) {
        drifts.push({
          accountId: account.id,
          accountNumber: account.accountNumber,
          expected: expectedBalance.toNumber(),
          actual: actualBalance.toNumber(),
          drift,
        });
      }
    }

    if (drifts.length > 0) {
      this.logger.error(
        `LEDGER DRIFT DETECTED tenant=${tenantId}: ${drifts.length} account(s) out of balance`,
        drifts,
      );
    }

    return { checked: accounts.length, driftCount: drifts.length, drifts };
  }
}
