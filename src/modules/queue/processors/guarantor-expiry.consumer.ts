import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { AccountType, GuarantorStatus, LoanStatus, Prisma, TenantStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { Decimal } from 'decimal.js';
import { Job } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { GuarantorValidationService } from '../../loans/guarantor-validation.service';
import {
  GUARANTOR_EXPIRY_CHECK_JOB,
  GuarantorExpiryJobPayload,
  QUEUE_NAMES,
} from '../queue.constants';

interface ExpiredGuarantorRow {
  id: string;
  loanId: string;
  memberId: string;
  guaranteedAmount: Prisma.Decimal;
  holdPlacedAt: Date | null;
  loan: {
    status: LoanStatus;
    principalAmount: Prisma.Decimal;
    loanProduct: {
      minGuarantors: number;
      guarantorCoverageRatio: Prisma.Decimal;
      requiredAccountType: AccountType | null;
    };
  };
}

@Processor(QUEUE_NAMES.LOAN_GUARANTOR_EXPIRY, { concurrency: 1 })
export class GuarantorExpiryConsumer extends WorkerHost {
  private readonly logger = new Logger(GuarantorExpiryConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly guarantorValidation: GuarantorValidationService,
  ) {
    super();
  }

  async process(job: Job<GuarantorExpiryJobPayload>): Promise<void> {
    if (job.name !== GUARANTOR_EXPIRY_CHECK_JOB) return;

    const cutoff = job.data.cutoffIso
      ? new Date(job.data.cutoffIso)
      : new Date(Date.now() - 72 * 60 * 60 * 1000);

    if (job.data.tenantId && job.data.loanId && job.data.guarantorId) {
      await this.expireSpecificGuarantor(job.data.tenantId, job.data.loanId, job.data.guarantorId, new Date());
      return;
    }

    const tenantIds = job.data.tenantId ? [job.data.tenantId] : await this.getActiveTenantIds();

    for (const tenantId of tenantIds) {
      await this.expireTenantGuarantors(tenantId, cutoff);
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<GuarantorExpiryJobPayload>): void {
    this.logger.log(`Guarantor expiry check completed job=${job.id}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<GuarantorExpiryJobPayload>, error: Error): void {
    this.logger.error(`Guarantor expiry check failed job=${job.id}: ${error.message}`, error.stack);
  }

  private async getActiveTenantIds(): Promise<string[]> {
    const tenants = await this.prisma.tenant.findMany({
      where: { status: TenantStatus.ACTIVE },
      select: { id: true },
    });
    return tenants.map((tenant) => tenant.id);
  }

  private async expireTenantGuarantors(tenantId: string, cutoff: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const expired = await tx.loanGuarantor.findMany({
        where: {
          tenantId,
          status: GuarantorStatus.PENDING,
          invitedAt: { lt: cutoff },
        },
        select: {
          id: true,
          loanId: true,
          memberId: true,
          guaranteedAmount: true,
          holdPlacedAt: true,
          loan: {
            select: {
              status: true,
              principalAmount: true,
              loanProduct: {
                select: {
                  minGuarantors: true,
                  guarantorCoverageRatio: true,
                  requiredAccountType: true,
                },
              },
            },
          },
        },
      });

      for (const guarantor of expired) {
        await this.expireGuarantor(tx, tenantId, guarantor, cutoff);
      }
    });
  }

  private async expireSpecificGuarantor(
    tenantId: string,
    loanId: string,
    guarantorId: string,
    cutoff: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const guarantor = await tx.loanGuarantor.findFirst({
        where: {
          tenantId,
          loanId,
          status: GuarantorStatus.PENDING,
          OR: [{ id: guarantorId }, { memberId: guarantorId }],
        },
        select: {
          id: true,
          loanId: true,
          memberId: true,
          guaranteedAmount: true,
          holdPlacedAt: true,
          loan: {
            select: {
              status: true,
              principalAmount: true,
              loanProduct: {
                select: {
                  minGuarantors: true,
                  guarantorCoverageRatio: true,
                  requiredAccountType: true,
                },
              },
            },
          },
        },
      });
      if (guarantor) await this.expireGuarantor(tx, tenantId, guarantor, cutoff);
    });
  }

  private async expireGuarantor(
    tx: Prisma.TransactionClient,
    tenantId: string,
    guarantor: ExpiredGuarantorRow,
    cutoff: Date,
  ): Promise<void> {
    const accountType = this.guarantorValidation.resolveAccountType(guarantor.loan.loanProduct);

    if (guarantor.holdPlacedAt) {
      await this.guarantorValidation.releaseGuarantorHolds(
        tx,
        tenantId,
        [{ memberId: guarantor.memberId, guaranteedAmount: guarantor.guaranteedAmount.toString() }],
        accountType,
      );
    }

    await tx.loanGuarantor.updateMany({
      where: { id: guarantor.id, tenantId, status: GuarantorStatus.PENDING },
      data: {
        status: GuarantorStatus.EXPIRED,
        respondedAt: new Date(),
        notes: 'Consent window expired (72h)',
        holdReleasedAt: guarantor.holdPlacedAt ? new Date() : undefined,
      },
    });

    if (guarantor.holdPlacedAt) {
      await this.createAuditLogInTransaction(tx, {
        tenantId,
        action: 'GUARANTOR.HOLD_RELEASED',
        entityType: 'LoanGuarantor',
        entityId: guarantor.id,
        metadata: {
          loanId: guarantor.loanId,
          guarantorMemberId: guarantor.memberId,
          accountType,
          guaranteedAmount: new Decimal(guarantor.guaranteedAmount.toString()).toNumber(),
          reason: GuarantorStatus.EXPIRED,
          cutoff: cutoff.toISOString(),
        },
      });
    }

    await this.createAuditLogInTransaction(tx, {
      tenantId,
      action: 'GUARANTOR.EXPIRED',
      entityType: 'LoanGuarantor',
      entityId: guarantor.id,
      oldValue: { status: GuarantorStatus.PENDING },
      newValue: { status: GuarantorStatus.EXPIRED },
      metadata: {
        loanId: guarantor.loanId,
        guarantorMemberId: guarantor.memberId,
        cutoff: cutoff.toISOString(),
      },
    });

    await this.rejectLoanForGuarantorTimeout(tx, tenantId, guarantor.loanId, guarantor.loan.loanProduct);
  }

  private async rejectLoanForGuarantorTimeout(
    tx: Prisma.TransactionClient,
    tenantId: string,
    loanId: string,
    product: { requiredAccountType: AccountType | null },
  ): Promise<void> {
    const loan = await tx.loan.findFirst({
      where: { id: loanId, tenantId, status: LoanStatus.PENDING_GUARANTORS },
      select: {
        id: true,
        principalAmount: true,
        status: true,
        loanProduct: {
          select: {
            minGuarantors: true,
            guarantorCoverageRatio: true,
          },
        },
      },
    });

    if (!loan) {
      return;
    }

    const acceptedGuarantors = await tx.loanGuarantor.findMany({
      where: {
        loanId,
        tenantId,
        status: GuarantorStatus.ACCEPTED,
      },
      select: { id: true, memberId: true, guaranteedAmount: true, holdReleasedAt: true },
    });

    const accountType = this.guarantorValidation.resolveAccountType(product);
    for (const guarantor of acceptedGuarantors) {
      if (guarantor.holdReleasedAt) continue;
      await this.guarantorValidation.releaseGuarantorHolds(
        tx,
        tenantId,
        [{ memberId: guarantor.memberId, guaranteedAmount: guarantor.guaranteedAmount.toString() }],
        accountType,
      );
      await tx.loanGuarantor.updateMany({
        where: { id: guarantor.id, tenantId },
        data: { holdReleasedAt: new Date() },
      });
    }

    const totalAccepted = acceptedGuarantors.reduce(
      (sum, item) => sum.plus(new Decimal(item.guaranteedAmount.toString())),
      new Decimal(0),
    );
    const requiredCoverage = new Decimal(loan.principalAmount.toString()).times(
      new Decimal(loan.loanProduct.guarantorCoverageRatio.toString()),
    );

    await tx.loan.updateMany({
      where: { id: loanId, tenantId, status: LoanStatus.PENDING_GUARANTORS },
      data: {
        status: LoanStatus.REJECTED_GUARANTOR_DECLINE,
        notes: 'REJECTED_GUARANTOR_DECLINE',
      },
    });

    await this.createAuditLogInTransaction(tx, {
      tenantId,
      action: 'LOAN.REJECTED_GUARANTOR_DECLINE',
      entityType: 'Loan',
      entityId: loanId,
      oldValue: { status: loan.status },
      newValue: { status: LoanStatus.REJECTED_GUARANTOR_DECLINE },
      metadata: {
        acceptedCount: acceptedGuarantors.length,
        minGuarantors: loan.loanProduct.minGuarantors,
        totalAccepted: totalAccepted.toNumber(),
        requiredCoverage: requiredCoverage.toNumber(),
      },
    });
  }

  private async createAuditLogInTransaction(
    tx: Prisma.TransactionClient,
    data: {
      tenantId: string;
      action: string;
      entityType: string;
      entityId: string;
      oldValue?: Record<string, unknown>;
      newValue?: Record<string, unknown>;
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
          '',
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
        actorId: null,
        action: data.action,
        entityType: data.entityType,
        entityId: data.entityId,
        oldValue: data.oldValue ? (data.oldValue as Prisma.InputJsonValue) : Prisma.JsonNull,
        newValue: data.newValue ? (data.newValue as Prisma.InputJsonValue) : Prisma.JsonNull,
        metadata: data.metadata as Prisma.InputJsonValue,
        timestamp,
        prevHash,
        entryHash,
      },
    });
  }
}
