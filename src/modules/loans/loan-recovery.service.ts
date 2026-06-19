import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { AccountType, GuarantorStatus, Prisma, TransactionStatus, TransactionType } from '@prisma/client';
import { createHash } from 'crypto';
import { Queue } from 'bullmq';
import { Decimal } from 'decimal.js';
import { PrismaService } from '../../prisma/prisma.service';
import {
  GUARANTOR_RECOVERY_NOTICE_JOB,
  InitiateGuarantorRecoveryJobPayload,
  QUEUE_NAMES,
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
}

export interface LoanRecoverySummary {
  totalRecovered: Decimal;
  remainingDebt: Decimal;
}

@Injectable()
export class LoanRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
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
        removeOnFail: false,
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

    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({
        where: { id: loanId, tenantId },
        select: {
          id: true,
          loanNumber: true,
          outstandingBalance: true,
          loanProduct: { select: { requiredAccountType: true } },
          guarantors: {
            where: { tenantId, status: GuarantorStatus.ACCEPTED },
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
      const allocations = await this.allocateRecovery(tx, tenantId, loan.guarantors, accountType, defaultAmount);
      const totalRecovered = allocations.reduce((sum, allocation) => sum.plus(allocation.deduction), new Decimal(0));
      const recoveryDate = new Date();

      for (const allocation of allocations) {
        if (allocation.deduction.isZero()) {
          continue;
        }

        const account = await tx.account.findFirst({
          where: {
            tenantId,
            memberId: allocation.guarantor.memberId,
            accountType,
            isActive: true,
          },
          select: { id: true, balance: true },
        });

        if (!account) {
          continue;
        }

        const balanceBefore = new Decimal(account.balance.toString());
        const balanceAfter = balanceBefore.minus(allocation.deduction).toDecimalPlaces(4);
        const amount = allocation.deduction.toDecimalPlaces(4).toString();
        const accountUpdate = await tx.account.updateMany({
          where: { id: account.id, tenantId, isActive: true },
          data: {
            balance: balanceAfter.toString(),
            lockedBalance: { decrement: amount },
            version: { increment: 1 },
          },
        });

        if (accountUpdate.count !== 1) {
          throw new BadRequestException(
            `RECOVERY_ACCOUNT_UPDATE_FAILED: guarantor ${allocation.guarantor.memberId} account was not updated`,
          );
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

        await tx.transaction.create({
          data: {
            tenantId,
            accountId: account.id,
            loanId,
            type: TransactionType.LOAN_REPAYMENT,
            status: TransactionStatus.COMPLETED,
            amount,
            balanceBefore: balanceBefore.toDecimalPlaces(4).toString(),
            balanceAfter: balanceAfter.toString(),
            reference: `GUARANTOR-RECOVERY-${allocation.guarantor.id}-${recoveryDate.getTime()}`,
            description: `Guarantor recovery for loan ${loan.loanNumber}`,
            processedBy: actorId,
          },
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
            recoveredAmount: allocation.deduction.toNumber(),
            recoveryDate: recoveryDate.toISOString(),
          },
        });
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
    });
  }

  private async allocateRecovery(
    tx: Prisma.TransactionClient,
    tenantId: string,
    guarantors: AcceptedGuarantorRecoveryRow[],
    accountType: AccountType,
    defaultAmount: Decimal,
  ): Promise<RecoveryAllocation[]> {
    const capacities = await Promise.all(
      guarantors.map(async (guarantor) => {
        const account = await tx.account.findFirst({
          where: { tenantId, memberId: guarantor.memberId, accountType, isActive: true },
          select: { balance: true, lockedBalance: true },
        });

        const guaranteeCapacity = new Decimal(guarantor.guaranteedAmount.toString()).minus(
          new Decimal(guarantor.recoveredAmount.toString()),
        );
        const accountCapacity = account
          ? Decimal.min(new Decimal(account.balance.toString()), new Decimal(account.lockedBalance.toString()))
          : new Decimal(0);

        return {
          guarantor,
          capacity: Decimal.min(guaranteeCapacity, accountCapacity).toDecimalPlaces(4),
        };
      }),
    );

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
