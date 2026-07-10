import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { AccountType, GuarantorStatus, Prisma, TransactionStatus, TransactionType } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { Queue } from 'bullmq';
import { Decimal } from 'decimal.js';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { LedgerService } from '../accounting/ledger.service';
import {
  GUARANTOR_FORFEITURE_LOCK_TTL_SECONDS,
  GUARANTOR_RECOVERY_NOTICE_JOB,
  InitiateGuarantorRecoveryJobPayload,
  QUEUE_NAMES,
  guarantorForfeitureReference,
  guarantorForfeitureLockKey,
} from '../queue/queue.constants';

interface AcceptedGuarantorRecoveryRow {
  id: string;
  memberId: string;
  guaranteedAmount: Prisma.Decimal;
  recoveredAmount: Prisma.Decimal;
}

interface RecoveryAllocation {
  guarantor: AcceptedGuarantorRecoveryRow;
  deduction: Decimal;
  account?: {
    id: string;
    balance: Prisma.Decimal;
    frozenSavings: Prisma.Decimal;
  };
}

export interface LoanRecoverySummary {
  totalRecovered: Decimal;
  remainingDebt: Decimal;
}

@Injectable()
export class LoanRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly ledger: LedgerService,
    @InjectQueue(QUEUE_NAMES.GUARANTOR_RECOVERY)
    private readonly guarantorRecoveryQueue: Queue<InitiateGuarantorRecoveryJobPayload>,
  ) {}

  async initiateGuarantorRecovery(
    loanId: string,
    tenantId: string,
    defaultAmount: Decimal,
    actorId: string,
  ): Promise<{ jobId: string }> {
    if (!defaultAmount.isFinite() || defaultAmount.lessThanOrEqualTo(0)) {
      throw new BadRequestException('INVALID_DEFAULT_AMOUNT: defaultAmount must be greater than zero');
    }

    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, tenantId },
      select: { 
        id: true, 
        arrearsDays: true, 
        status: true,
        loanProduct: { select: { gracePeriodDays: true } } 
      },
    });
    if (!loan) {
      throw new NotFoundException('Loan not found');
    }
    
    const gracePeriod = loan.loanProduct?.gracePeriodDays ?? 14;
    
    if (loan.arrearsDays < gracePeriod && loan.status !== 'DEFAULTED') {
      throw new BadRequestException(`GUARANTOR_RECOVERY_NOTICE_REQUIRES_T${gracePeriod}_DEFAULT`);
    }

    const jobId = `${GUARANTOR_RECOVERY_NOTICE_JOB}:${tenantId}:${loanId}`;
    await this.guarantorRecoveryQueue.add(
      GUARANTOR_RECOVERY_NOTICE_JOB,
      {
        loanId,
        tenantId,
        actorId,
        defaultAmount: defaultAmount.toDecimalPlaces(4).toString(),
        noticeDateIso: new Date().toISOString(),
      },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { age: 86400, count: 50 },
      },
    );

    await this.prisma.auditLog.create({
      data: {
        tenantId,
        actorId,
        action: 'GUARANTOR_RECOVERY.NOTICE_QUEUED',
        entityType: 'Loan',
        entityId: loanId,
        metadata: { defaultAmount: defaultAmount.toDecimalPlaces(4).toString(), jobId },
      },
    });
    return { jobId };
  }

  async recoverFromGuarantors(
    loanId: string,
    tenantId: string,
    defaultAmount: Decimal,
    actorId: string,
  ): Promise<{ recoverySummary: LoanRecoverySummary }> {
    if (!defaultAmount.isFinite() || defaultAmount.lessThanOrEqualTo(0)) {
      throw new BadRequestException('INVALID_DEFAULT_AMOUNT: defaultAmount must be greater than zero');
    }

    // Distributed lock: GuarantorDefaultOffsetProcessor's daily cron can target the
    // exact same loan's guarantors concurrently with this delayed post-notice debit
    // (both fire once a loan is far enough in arrears). Without this, they could
    // both read the same pre-recovery balance and both deduct — a double-debit of
    // the guarantor's savings. Throw (don't silently no-op) so the caller's BullMQ
    // job retries with backoff rather than reporting a false "recovered nothing".
    const lockKey = guarantorForfeitureLockKey(tenantId, loanId);
    const lockToken = await this.redis.acquireLock(lockKey, GUARANTOR_FORFEITURE_LOCK_TTL_SECONDS);
    if (!lockToken) {
      throw new ConflictException(
        `GUARANTOR_FORFEITURE_LOCKED: another forfeiture/recovery is already in progress for loan ${loanId}`,
      );
    }

    try {
      return await this.recoverFromGuarantorsLocked(loanId, tenantId, defaultAmount, actorId);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken);
    }
  }

  private async recoverFromGuarantorsLocked(
    loanId: string,
    tenantId: string,
    defaultAmount: Decimal,
    actorId: string,
  ): Promise<{ recoverySummary: LoanRecoverySummary }> {
    const recoveryAttemptId = randomUUID();
    const txClient = this.prisma.direct ?? this.prisma;

    return txClient.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({
        where: { id: loanId, tenantId },
        select: {
          id: true,
          loanNumber: true,
          outstandingBalance: true,
          loanProduct: { select: { requiredAccountType: true } },
          guarantors: {
            // holdReleasedAt: null matches the cron path's filter (GuarantorDefaultOffsetProcessor) —
            // a guarantor whose hold was already released (by either path) must never be
            // selected for a second round of recovery.
            where: { tenantId, status: GuarantorStatus.ACCEPTED, holdReleasedAt: null },
            select: {
              id: true,
              memberId: true,
              guaranteedAmount: true,
              recoveredAmount: true,
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (!loan) {
        throw new NotFoundException('Loan not found');
      }

      if (loan.guarantors.length === 0) {
        throw new BadRequestException('NO_ACCEPTED_GUARANTORS: loan has no accepted guarantors for recovery');
      }

      const accountType = loan.loanProduct.requiredAccountType ?? AccountType.FOSA;
      const allocations = await this.allocateRecovery(tx, tenantId, loan.guarantors, accountType, defaultAmount, new Decimal(loan.outstandingBalance.toString()));
      let totalRecovered = new Decimal(0);
      const recoveryDate = new Date();

      for (const allocation of allocations) {
        if (allocation.deduction.isZero()) {
          continue;
        }

        const account = allocation.account;
        if (!account) {
          continue;
        }

        // Shared format with GuarantorDefaultOffsetProcessor. The attempt suffix
        // prevents one partial recovery from blocking later recovery attempts.
        const reference = guarantorForfeitureReference(
          tenantId,
          loanId,
          account.id,
          recoveryAttemptId,
        );
        const existingRecovery = await tx.transaction.findFirst({ where: { tenantId, reference } });
        if (existingRecovery) {
          continue;
        }

        const lockedRows = await tx.$queryRaw<Array<{
          balance: Prisma.Decimal;
          frozenSavings: Prisma.Decimal;
          version: number;
        }>>`
          SELECT balance, "frozenSavings", version FROM "Account" WHERE id = ${account.id} FOR UPDATE
        `;
        const lockedAccount = lockedRows[0];
        if (!lockedAccount) {
          throw new ConflictException('Concurrent balance modification, retry');
        }

        const balanceBefore = new Decimal(lockedAccount.balance.toString());
        const frozenSavings = new Decimal(lockedAccount.frozenSavings.toString());
        const actualDeduction = Decimal.min(
          allocation.deduction,
          balanceBefore,
          frozenSavings,
        ).toDecimalPlaces(4);
        if (actualDeduction.lessThanOrEqualTo(0)) {
          continue;
        }

        const balanceAfter = balanceBefore.minus(actualDeduction).toDecimalPlaces(4);
        const amount = actualDeduction.toString();
        const accountUpdate = await tx.account.updateMany({
          where: { id: account.id, tenantId, isActive: true, version: lockedAccount.version },
          data: {
            balance: balanceAfter.toString(),
            frozenSavings: { decrement: amount },
            version: { increment: 1 },
          },
        });

        if (accountUpdate.count !== 1) {
          throw new ConflictException('Concurrent balance modification, retry');
        }

        const guarantorUpdate = await tx.loanGuarantor.updateMany({
          where: { id: allocation.guarantor.id, tenantId, status: GuarantorStatus.ACCEPTED },
          data: {
            recoveredAmount: { increment: amount },
            recoveryDate,
          },
        });

        if (guarantorUpdate.count !== 1) {
          throw new BadRequestException(
            `RECOVERY_GUARANTOR_UPDATE_FAILED: guarantor ${allocation.guarantor.memberId} was not updated`,
          );
        }

        const recoveryTxn = await tx.transaction.create({
          data: {
            tenantId,
            accountId: account.id,
            loanId,
            type: TransactionType.LOAN_REPAYMENT,
            status: TransactionStatus.COMPLETED,
            amount,
            balanceBefore: balanceBefore.toDecimalPlaces(4).toString(),
            balanceAfter: balanceAfter.toString(),
            reference,
            description: `Guarantor recovery for loan ${loan.loanNumber}`,
            processedBy: actorId,
          },
        });

        // GL leg: debit the guarantor's own deposit-liability code, credit
        // LOAN_RECEIVABLE — tx.account.updateMany() above is the only balance
        // mutation; this call is GL-only (see LedgerService.postGuarantorForfeitureEntry).
        await this.ledger.postGuarantorForfeitureEntry({
          tx,
          tenantId,
          reference,
          amount: actualDeduction,
          accountType,
          transactionId: recoveryTxn.id,
          actorId,
          description: `Guarantor recovery for loan ${loan.loanNumber}`,
        });

        await this.createAuditLogInTransaction(tx, {
          tenantId,
          actorId,
          action: 'AUDIT_RECOVERY',
          entityType: 'LoanGuarantor',
          entityId: allocation.guarantor.id,
          metadata: {
            loanId,
            loanNumber: loan.loanNumber,
            guarantorMemberId: allocation.guarantor.memberId,
            accountType,
            recoveredAmount: actualDeduction.toNumber(),
            recoveryDate: recoveryDate.toISOString(),
          },
        });

        totalRecovered = totalRecovered.plus(actualDeduction);
      }

      if (totalRecovered.greaterThan(0)) {
        const outstandingBefore = new Decimal(loan.outstandingBalance.toString());
        const outstandingDeduction = Decimal.min(outstandingBefore, totalRecovered).toDecimalPlaces(4);
        await tx.loan.updateMany({
          where: { id: loanId, tenantId },
          data: {
            outstandingBalance: { decrement: outstandingDeduction.toString() },
          },
        });
      }

      return {
        recoverySummary: {
          totalRecovered,
          remainingDebt: Decimal.max(defaultAmount.minus(totalRecovered), new Decimal(0)),
        },
      };
    }, { isolationLevel: 'Serializable' as const });
  }

  private async allocateRecovery(
    tx: Prisma.TransactionClient,
    tenantId: string,
    guarantors: AcceptedGuarantorRecoveryRow[],
    accountType: AccountType,
    defaultAmount: Decimal,
    outstandingBalance: Decimal,
  ): Promise<RecoveryAllocation[]> {
    const sumHolds = guarantors.reduce((sum, g) => sum.plus(g.guaranteedAmount.toString()), new Decimal(0));
    const guarantorMemberIds = guarantors.map((guarantor) => guarantor.memberId);
    const accounts = await tx.account.findMany({
      where: { tenantId, memberId: { in: guarantorMemberIds }, accountType, isActive: true },
      select: { id: true, memberId: true, balance: true, frozenSavings: true },
    });
    const accountMap = new Map(accounts.map((account) => [account.memberId, account]));

    const capacities = guarantors.map((guarantor) => {
        const account = accountMap.get(guarantor.memberId);
        let guaranteeCapacity = new Decimal(guarantor.guaranteedAmount.toString()).minus(
          new Decimal(guarantor.recoveredAmount.toString()),
        );

        if (sumHolds.greaterThan(0) && outstandingBalance.lessThan(sumHolds)) {
          const ratio = outstandingBalance.div(sumHolds);
          guaranteeCapacity = guaranteeCapacity.times(ratio).toDecimalPlaces(4);
        }
        const accountCapacity = account
          ? Decimal.min(new Decimal(account.balance.toString()), new Decimal(account.frozenSavings.toString()))
          : new Decimal(0);

        return {
          guarantor,
          capacity: Decimal.min(guaranteeCapacity, accountCapacity).toDecimalPlaces(4),
          account,
        };
      });

    let remainingDebt = defaultAmount.toDecimalPlaces(4);
    let remainingCapacity = capacities.reduce((sum, item) => sum.plus(item.capacity), new Decimal(0));
    const allocations: RecoveryAllocation[] = [];

    for (const item of capacities) {
      if (remainingDebt.isZero() || remainingCapacity.isZero() || item.capacity.lessThanOrEqualTo(0)) {
        allocations.push({ guarantor: item.guarantor, deduction: new Decimal(0) });
        continue;
      }

      const proportionalShare = remainingDebt.times(item.capacity).div(remainingCapacity).toDecimalPlaces(4);
      const deduction = Decimal.min(item.capacity, proportionalShare, remainingDebt).toDecimalPlaces(4);
      allocations.push({ guarantor: item.guarantor, deduction });
      remainingDebt = remainingDebt.minus(deduction).toDecimalPlaces(4);
      remainingCapacity = remainingCapacity.minus(item.capacity).toDecimalPlaces(4);
    }

    return allocations;
  }

  private async createAuditLogInTransaction(
    tx: Prisma.TransactionClient,
    data: {
      tenantId: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    const timestamp = new Date();
    const prevEntry = await tx.auditLog.findFirst({
      where: { tenantId: data.tenantId },
      orderBy: { timestamp: 'desc' },
      select: { entryHash: true },
    });
    const prevHash = prevEntry?.entryHash ?? null;
    const entryHash = createHash('sha256')
      .update(
        [
          data.tenantId,
          data.actorId,
          data.action,
          data.entityType,
          data.entityId,
          timestamp.toISOString(),
          prevHash ?? '',
        ].join('|'),
        'utf8',
      )
      .digest('hex');

    await tx.auditLog.create({
      data: {
        tenantId: data.tenantId,
        actorId: data.actorId,
        action: data.action,
        entityType: data.entityType,
        entityId: data.entityId,
        metadata: data.metadata as Prisma.InputJsonValue,
        timestamp,
        prevHash,
        entryHash,
      },
    });
  }
}

