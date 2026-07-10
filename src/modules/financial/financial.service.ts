import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import {
  AccountType,
  LoanStatus,
  TransactionType,
  TransactionStatus,
  InterestType,
  LoanStaging,
} from '@prisma/client';
import type { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { LedgerService } from '../accounting/ledger.service';
import { AuditLogJobPayload, QUEUE_NAMES } from '../queue/queue.constants';

/**
 * FinancialService – Phase 4
 *
 * Handles:
 *   1. Daily interest & penalty accrual
 *   2. Loan staging tag updates (PERFORMING / WATCHLIST / NPL)
 *   3. Loan repayment schedule: enqueue delayed instalment jobs
 *   4. LoanGuarantor exposure enforcement
 *   5. Ledger integrity check (SUM credit – SUM debit = account balance)
 */
@Injectable()
export class FinancialService {
  private readonly logger = new Logger(FinancialService.name);

  // Idempotency lock TTL – 25 hours (longer than the 24h cron cadence)
  private readonly ACCRUAL_LOCK_TTL = 90_000; // 25 h in seconds

  // Cap on how many GL-bypass rows a single runLedgerIntegrityCheck() scan
  // returns — keeps the query (and the alert payload) bounded on a large
  // tenant instead of growing unboundedly with the whole transaction history.
  private readonly GL_BYPASS_SCAN_LIMIT = 500;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly ledger: LedgerService,
    @Optional()
    @InjectQueue(QUEUE_NAMES.AUDIT_LOG)
    private readonly auditQueue?: Queue<AuditLogJobPayload>,
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
  async runDailyAccrual(
    tenantId: string,
    accrualDate: string,
  ): Promise<{ processed: number; skipped: number }> {
    const lockKey = `accrual:${tenantId}:${accrualDate}`;

    // Distributed lock – SET NX with 25h TTL
    const locked = await this.redis.set(lockKey, '1', this.ACCRUAL_LOCK_TTL, true);
    if (!locked) {
      this.logger.warn(`Accrual already ran for tenant=${tenantId} date=${accrualDate} – skipping`);
      return { processed: 0, skipped: 0 };
    }

    const dateObj = new Date(accrualDate);
    const correlationId = uuidv4();
    const activeLoanStatuses: LoanStatus[] = [LoanStatus.ACTIVE, LoanStatus.DISBURSED];

    const loans = await this.prisma.loan.findMany({
      where: {
        tenantId,
        status: { in: activeLoanStatuses },
        // Skip loans already accrued today
        OR: [{ lastAccrualDate: null }, { lastAccrualDate: { lt: dateObj } }],
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
        await this.accrueInterestForLoan(loan, dateObj, correlationId);
        processed++;
      } catch (err) {
        this.logger.error(`Accrual failed for loan ${loan.id}`, err);
        skipped++;
      }
    }

    this.logger.log(
      `Accrual complete: tenant=${tenantId} date=${accrualDate} processed=${processed} skipped=${skipped}`,
    );
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
      accruedInterest?: Decimal;
      lastAccrualDate?: Date | null;
      loanProduct: { interestType: string };
      member: { accounts: { id: string; balance: Decimal }[] };
    },
    accrualDate: Date,
    correlationId: string,
  ): Promise<void> {
    const outstanding = new Decimal(loan.outstandingBalance.toString());
    if (outstanding.lte(0)) return;

    const annualRate = new Decimal(loan.interestRate.toString());
    // Daily interest = outstanding * (annual_rate / 365)
    const dailyInterest = outstanding.times(annualRate).dividedBy(365).toDecimalPlaces(4);

    // Penalty: if past due date, add a daily penalty of 0.1% of outstanding
    const isPastDue = loan.dueDate && accrualDate > loan.dueDate;
    const dailyPenalty = isPastDue ? outstanding.times(0.001).toDecimalPlaces(4) : new Decimal(0);

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
    const oldAccrued = new Decimal(loan.accruedInterest?.toString() ?? '0');
    const newAccrued = oldAccrued.plus(dailyInterest).toDecimalPlaces(4);
    const daysElapsed = loan.lastAccrualDate
      ? Math.max(
          1,
          Math.floor(
            (accrualDate.getTime() - loan.lastAccrualDate.getTime()) / (24 * 60 * 60 * 1000),
          ),
        )
      : 1;

    await this.prisma.$transaction(async (tx) => {
      // Post interest accrual transaction — the Account debit and its GL leg
      // (LedgerService.postInterestAccrualEntry) happen in this same transaction,
      // so a GL-code resolution failure rolls back the balance debit too. Never
      // silently drain a balance with no GL trace.
      if (dailyInterest.gt(0)) {
        const balBefore = new Decimal(fosaAccount.balance.toString());
        const balAfter = balBefore.minus(dailyInterest); // debit from FOSA
        // Deterministic — never uuid() here. A retried accrual job must land on the
        // exact same reference so LedgerService's replay check (and the pre-check
        // below) can catch it, instead of double-charging the member.
        const interestReference = `ACCRUAL-${loan.tenantId}-${loan.id}-${accrualDateStr}`;

        const existingInterest = await tx.transaction.findFirst({
          where: { tenantId: loan.tenantId, reference: interestReference },
        });
        if (!existingInterest) {
          const interestTxn = await tx.transaction.create({
            data: {
              tenantId: loan.tenantId,
              accountId: fosaAccount.id,
              loanId: loan.id,
              type: TransactionType.INTEREST_ACCRUAL,
              status: TransactionStatus.COMPLETED,
              amount: dailyInterest.toDecimalPlaces(4).toString(),
              balanceBefore: balBefore.toDecimalPlaces(4).toString(),
              balanceAfter: balAfter.toDecimalPlaces(4).toString(),
              reference: interestReference,
              description: `Daily interest accrual – ${accrualDateStr}`,
              processedBy: 'SYSTEM',
            },
          });

          await tx.account.update({
            where: { id: fosaAccount.id },
            data: { balance: balAfter.toDecimalPlaces(4).toString() },
          });

          await this.ledger.postInterestAccrualEntry({
            tx,
            tenantId: loan.tenantId,
            reference: interestReference,
            amount: dailyInterest,
            accountType: AccountType.FOSA,
            transactionId: interestTxn.id,
            description: `Daily interest accrual – ${accrualDateStr}`,
          });
        }
      }

      // Post penalty transaction — same atomicity/idempotency/GL-safety shape as
      // the interest leg above.
      if (dailyPenalty.gt(0)) {
        const penaltyReference = `PENALTY-${loan.tenantId}-${loan.id}-${accrualDateStr}`;
        const existingPenalty = await tx.transaction.findFirst({
          where: { tenantId: loan.tenantId, reference: penaltyReference },
        });
        if (!existingPenalty) {
          const refreshedAccount = await tx.account.findUnique({
            where: { id: fosaAccount.id },
            select: { balance: true },
          });
          const balBefore = new Decimal(refreshedAccount!.balance.toString());
          const balAfter = balBefore.minus(dailyPenalty);

          const penaltyTxn = await tx.transaction.create({
            data: {
              tenantId: loan.tenantId,
              accountId: fosaAccount.id,
              loanId: loan.id,
              type: TransactionType.PENALTY,
              status: TransactionStatus.COMPLETED,
              amount: dailyPenalty.toDecimalPlaces(4).toString(),
              balanceBefore: balBefore.toDecimalPlaces(4).toString(),
              balanceAfter: balAfter.toDecimalPlaces(4).toString(),
              reference: penaltyReference,
              description: `Overdue penalty – ${accrualDateStr}`,
              processedBy: 'SYSTEM',
            },
          });

          await tx.account.update({
            where: { id: fosaAccount.id },
            data: { balance: balAfter.toDecimalPlaces(4).toString() },
          });

          await this.ledger.postPenaltyDeductionEntry({
            tx,
            tenantId: loan.tenantId,
            reference: penaltyReference,
            amount: dailyPenalty,
            accountType: AccountType.FOSA,
            transactionId: penaltyTxn.id,
            description: `Overdue penalty – ${accrualDateStr}`,
          });
        }
      }

      // Update loan arrears + staging + running accruedInterest total
      await tx.loan.update({
        where: { id: loan.id },
        data: {
          arrearsDays: newArrearsDays,
          arrearsAmount: isPastDue
            ? new Decimal(loan.outstandingBalance.toString()).toDecimalPlaces(4).toString()
            : '0',
          staging,
          lastAccrualDate: accrualDate,
          accruedInterest: { increment: dailyInterest.toDecimalPlaces(4).toNumber() },
          // Transition to DEFAULTED if NPL
          ...(staging === LoanStaging.NPL && loan.loanProduct && { status: LoanStatus.DEFAULTED }),
        },
      });
    });

    this.emitAuditLogNonBlocking(
      {
        tenantId: loan.tenantId,
        actorId: 'SYSTEM',
        userId: 'SYSTEM',
        action: 'INTEREST.ACCRUAL',
        entityType: 'LOAN',
        resource: 'LOAN',
        entityId: loan.id,
        resourceId: loan.id,
        oldValue: { accruedInterest: oldAccrued.toFixed(4) },
        newValue: { accruedInterest: newAccrued.toFixed(4) },
        metadata: {
          dailyRate: annualRate.dividedBy(365).toDecimalPlaces(10).toString(),
          daysElapsed,
          correlationId,
        },
        requestId: `audit:INTEREST.ACCRUAL:${loan.tenantId}:${loan.id}:${accrualDateStr}`,
      },
      `audit:INTEREST.ACCRUAL:${loan.tenantId}:${loan.id}:${accrualDateStr}`,
      correlationId,
    );
  }

  private emitAuditLogNonBlocking(
    payload: AuditLogJobPayload,
    jobId: string,
    correlationId: string,
  ): void {
    setImmediate(() => {
      this.auditQueue
        ?.add('domain-event', payload, {
          jobId,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: { age: 86400, count: 50 },
        })
        .catch((err: unknown) => {
          this.logger.error(
            JSON.stringify({
              event: 'audit.emit_failed',
              action: payload.action,
              entityId: payload.entityId ?? payload.resourceId,
              tenantId: payload.tenantId,
              correlationId,
              spanId: jobId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
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
  ): Promise<{
    totalExposure: number;
    fosaBalance: number;
    exposureRatio: number;
    canGuarantee: boolean;
  }> {
    const [guarantees, fosaAccount] = await Promise.all([
      this.prisma.loanGuarantor.findMany({
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

    const fosaBalance = fosaAccount ? new Decimal(fosaAccount.balance.toString()) : new Decimal(0);

    const maxAllowed = fosaBalance.times(1.5);
    const canGuarantee = totalExposure.lt(maxAllowed);
    const exposureRatio = fosaBalance.gt(0) ? totalExposure.dividedBy(fosaBalance).toNumber() : 0;

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
   * Verifies TWO independent things, and must never conflate them:
   *
   *  1. The math: SUM(credits) - SUM(debits) == stored Account.balance, for
   *     every account in the tenant ("drifts" below).
   *  2. The GL trace: every COMPLETED/REVERSED Transaction has a matching
   *     JournalEntry ("glBypasses" below).
   *
   * Before Phase 3, only (1) ran — and a GL bypass (Account.balance updated
   * directly, skipping LedgerService) leaves the math perfectly balanced: the
   * live balance and the sum of Transaction.amount still agree with each
   * other, because both were written by the same bypassing code path. Only a
   * missing JournalEntry reveals it. Reporting a bypass as though it were a
   * "drift" would also be misleading operationally — a drift means the books
   * don't balance and needs investigation into which number is wrong; a
   * bypass means the books DO balance but a whole leg of double-entry
   * accounting never happened. Different root cause, different fix, so they
   * stay in separate fields.
   *
   * Credit types: DEPOSIT, LOAN_DISBURSEMENT, INTEREST_EARNED, DIVIDEND_PAYOUT
   * Debit types:  WITHDRAWAL, LOAN_REPAYMENT, INTEREST_ACCRUAL, PENALTY, FEE_CHARGE
   */
  async runLedgerIntegrityCheck(tenantId: string): Promise<{
    checked: number;
    driftCount: number;
    drifts: {
      accountId: string;
      accountNumber: string;
      expected: number;
      actual: number;
      drift: number;
    }[];
    glBypassCount: number;
    glBypasses: {
      transactionId: string;
      reference: string;
      type: string;
      accountId: string;
      amount: string;
      createdAt: string;
    }[];
    /** true if more bypasses exist than the GL_BYPASS_SCAN_LIMIT below — the count/list are a lower bound, not exhaustive. */
    glBypassTruncated: boolean;
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

    const drifts: {
      accountId: string;
      accountNumber: string;
      expected: number;
      actual: number;
      drift: number;
    }[] = [];

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

    const { bypasses, truncated } = await this.findGlBypasses(tenantId);
    if (bypasses.length > 0) {
      this.logger.error(
        `GL_BYPASS_DETECTED tenant=${tenantId}: ${bypasses.length} transaction(s) with no ` +
          `matching JournalEntry — Account.balance was mutated outside LedgerService` +
          (truncated ? ` (truncated at ${this.GL_BYPASS_SCAN_LIMIT})` : ''),
        bypasses,
      );
    }

    return {
      checked: accounts.length,
      driftCount: drifts.length,
      drifts,
      glBypassCount: bypasses.length,
      glBypasses: bypasses,
      glBypassTruncated: truncated,
    };
  }

  /**
   * Anti-join Transaction → JournalEntry: find every COMPLETED/REVERSED
   * Transaction with no JournalEntry referencing it. Pushed down as a single
   * SQL NOT EXISTS (indexed via JournalEntry(tenantId, referenceType,
   * referenceId) — see the migration adding that index) instead of an N+1 loop
   * of per-transaction existence checks, so this stays cheap as transaction
   * volume grows.
   *
   * postInternalTransfer() deliberately writes ONE JournalEntry for TWO
   * Transaction rows (source + destination leg), with the JournalEntry
   * referencing only the source leg's id — the destination leg is linked to
   * it via Transaction.linkedTransactionId, not its own JournalEntry. Without
   * accounting for that, every internal transfer's destination leg would
   * false-positive as a bypass here. The `referenceId IN (t.id,
   * t."linkedTransactionId")` check accepts either.
   */
  private async findGlBypasses(tenantId: string): Promise<{
    bypasses: {
      transactionId: string;
      reference: string;
      type: string;
      accountId: string;
      amount: string;
      createdAt: string;
    }[];
    truncated: boolean;
  }> {
    const rows = await this.prisma.$queryRaw<
      { id: string; reference: string; type: string; accountId: string; amount: Decimal; createdAt: Date }[]
    >`
      SELECT t.id, t.reference, t.type, t."accountId", t.amount, t."createdAt"
      FROM "Transaction" t
      WHERE t."tenantId" = ${tenantId}
        AND t.status IN ('COMPLETED', 'REVERSED')
        AND NOT EXISTS (
          SELECT 1 FROM "JournalEntry" je
          WHERE je."tenantId" = t."tenantId"
            AND je."referenceType" = 'TRANSACTION'
            AND je."referenceId" IN (t.id, t."linkedTransactionId")
        )
      ORDER BY t."createdAt" DESC
      LIMIT ${this.GL_BYPASS_SCAN_LIMIT + 1}
    `;

    const truncated = rows.length > this.GL_BYPASS_SCAN_LIMIT;
    const bounded = truncated ? rows.slice(0, this.GL_BYPASS_SCAN_LIMIT) : rows;

    return {
      bypasses: bounded.map((row) => ({
        transactionId: row.id,
        reference: row.reference,
        type: row.type,
        accountId: row.accountId,
        amount: row.amount.toString(),
        createdAt: row.createdAt.toISOString(),
      })),
      truncated,
    };
  }
}
