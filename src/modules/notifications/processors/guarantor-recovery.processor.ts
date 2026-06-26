import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { AccountType, GuarantorStatus, LoanStatus, NotificationChannel, NotificationStatus, Prisma } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { Decimal } from 'decimal.js';
import { PrismaService } from '../../../prisma/prisma.service';
import { LoanRecoveryService } from '../../loans/loan-recovery.service';
import {
  EmailJobPayload,
  ExecuteGuarantorDebitJobPayload,
  GUARANTOR_DEBIT_JOB,
  GUARANTOR_RECOVERY_NOTICE_JOB,
  InitiateGuarantorRecoveryJobPayload,
  QUEUE_NAMES,
  SmsJobPayload,
} from '../../queue/queue.constants';

@Processor(QUEUE_NAMES.GUARANTOR_RECOVERY, { concurrency: 2 })
export class GuarantorRecoveryProcessor extends WorkerHost {
  private readonly logger = new Logger(GuarantorRecoveryProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recovery: LoanRecoveryService,
    @InjectQueue(QUEUE_NAMES.GUARANTOR_RECOVERY)
    private readonly recoveryQueue: Queue<InitiateGuarantorRecoveryJobPayload | ExecuteGuarantorDebitJobPayload>,
    @InjectQueue(QUEUE_NAMES.SMS)
    private readonly smsQueue: Queue<SmsJobPayload>,
    @InjectQueue(QUEUE_NAMES.EMAIL)
    private readonly emailQueue: Queue<EmailJobPayload>,
  ) {
    super();
  }

  async process(job: Job<InitiateGuarantorRecoveryJobPayload | ExecuteGuarantorDebitJobPayload>): Promise<void> {
    if (job.name === GUARANTOR_RECOVERY_NOTICE_JOB) {
      await this.sendNoticeAndScheduleDebit(job.data as InitiateGuarantorRecoveryJobPayload);
      return;
    }
    if (job.name === GUARANTOR_DEBIT_JOB) {
      await this.executeDelayedDebit(job.data as ExecuteGuarantorDebitJobPayload);
      return;
    }
    throw new BadRequestException(`Unsupported guarantor recovery job ${job.name}`);
  }

  private async sendNoticeAndScheduleDebit(payload: InitiateGuarantorRecoveryJobPayload): Promise<void> {
    const loan = await this.prisma.loan.findFirst({
      where: { id: payload.loanId, tenantId: payload.tenantId },
      include: {
        member: { include: { user: true } },
        guarantors: {
          where: { tenantId: payload.tenantId, status: GuarantorStatus.ACCEPTED },
          include: { member: { include: { user: true } } },
        },
      },
    });
    if (!loan) {
      throw new NotFoundException('Loan not found for guarantor recovery notice');
    }
    if (!this.isStillDefaulted(loan.status, loan.arrearsDays)) {
      this.logger.log(`Recovery notice skipped loan=${loan.id} status=${loan.status} arrearsDays=${loan.arrearsDays}`);
      return;
    }

    const executionDate = new Date();
    executionDate.setDate(executionDate.getDate() + 7);
    const amount = new Decimal(payload.defaultAmount).toFixed(2);
    const borrowerName = `${loan.member.user.firstName} ${loan.member.user.lastName}`;
    const executionDateText = executionDate.toISOString().split('T')[0];

    for (const guarantor of loan.guarantors) {
      const message = `NOTICE: ${borrowerName} is in default. KES ${amount} will be deducted from your account on ${executionDateText} to cover their guarantee. Contact support to dispute.`;
      const phone = guarantor.member.user.phone ?? guarantor.member.user.phoneNumber;
      if (phone) {
        await this.smsQueue.add('send', {
          type: 'GUARANTOR_RECOVERY_NOTICE',
          phone,
          message,
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        });
        await this.logNotification(payload.tenantId, guarantor.memberId, NotificationChannel.SMS, phone, 'GUARANTOR_RECOVERY_NOTICE', message);
      }
      if (guarantor.member.user.email) {
        await this.emailQueue.add('send', {
          type: 'SYSTEM_NOTICE',
          to: guarantor.member.user.email,
          firstName: guarantor.member.user.firstName,
          subject: `Notice of intent: guarantor recovery for loan ${loan.loanNumber}`,
          body: message,
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        });
        await this.logNotification(payload.tenantId, guarantor.memberId, NotificationChannel.EMAIL, guarantor.member.user.email, 'GUARANTOR_RECOVERY_NOTICE', message);
      }
    }

    await this.recoveryQueue.add(
      GUARANTOR_DEBIT_JOB,
      {
        tenantId: payload.tenantId,
        loanId: payload.loanId,
        actorId: payload.actorId,
        defaultAmount: payload.defaultAmount,
        executeAfterIso: executionDate.toISOString(),
      },
      {
        jobId: `${GUARANTOR_DEBIT_JOB}:${payload.tenantId}:${payload.loanId}`,
        delay: Decimal.max(new Decimal(executionDate.getTime()).minus(new Date().getTime()), new Decimal(0)).toNumber(),
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { age: 86400, count: 50 },
      },
    );
    await this.audit(payload.tenantId, 'GUARANTOR_RECOVERY.DEBIT_SCHEDULED', payload.loanId, {
      executeAfterIso: executionDate.toISOString(),
      defaultAmount: payload.defaultAmount,
    });
  }

  private async executeDelayedDebit(payload: ExecuteGuarantorDebitJobPayload): Promise<void> {
    const loan = await this.prisma.loan.findFirst({
      where: { id: payload.loanId, tenantId: payload.tenantId },
      include: {
        guarantors: {
          where: { tenantId: payload.tenantId, status: GuarantorStatus.ACCEPTED },
          include: { member: { include: { user: true, accounts: { where: { accountType: AccountType.FOSA, isActive: true } } } } },
        },
      },
    });
    if (!loan) {
      throw new NotFoundException('Loan not found for guarantor debit');
    }
    if (!this.isStillDefaulted(loan.status, loan.arrearsDays)) {
      await this.audit(payload.tenantId, 'GUARANTOR_RECOVERY.DEBIT_SKIPPED', payload.loanId, {
        reason: 'LOAN_NO_LONGER_DEFAULTED',
        status: loan.status,
        arrearsDays: loan.arrearsDays,
      });
      return;
    }

    const beforeRecovered = new Map(
      loan.guarantors.map((guarantor) => [guarantor.id, new Decimal(guarantor.recoveredAmount.toString())]),
    );
    const summary = await this.recovery.recoverFromGuarantors(
      payload.loanId,
      payload.tenantId,
      new Decimal(payload.defaultAmount),
      payload.actorId,
    );

    const updated = await this.prisma.loanGuarantor.findMany({
      where: { loanId: payload.loanId, tenantId: payload.tenantId, status: GuarantorStatus.ACCEPTED },
      include: { member: { include: { user: true } } },
    });

    for (const guarantor of updated) {
      const previous = beforeRecovered.get(guarantor.id) ?? new Decimal(0);
      const deducted = new Decimal(guarantor.recoveredAmount.toString()).minus(previous).toDecimalPlaces(4);
      if (deducted.lessThanOrEqualTo(0)) {
        continue;
      }
      const message = `Guarantor recovery completed: KES ${deducted.toFixed(2)} has been deducted for loan ${loan.loanNumber}.`;
      const phone = guarantor.member.user.phone ?? guarantor.member.user.phoneNumber;
      if (phone) {
        await this.smsQueue.add('send', { type: 'GUARANTOR_RECOVERY_DEBITED', phone, message }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        });
      }
      if (guarantor.member.user.email) {
        await this.emailQueue.add('send', {
          type: 'SYSTEM_NOTICE',
          to: guarantor.member.user.email,
          firstName: guarantor.member.user.firstName,
          subject: `Guarantor recovery completed for loan ${loan.loanNumber}`,
          body: message,
        });
      }
    }

    await this.audit(payload.tenantId, 'GUARANTOR_RECOVERY.DEBIT_EXECUTED', payload.loanId, {
      totalRecovered: summary.recoverySummary.totalRecovered.toFixed(4),
      remainingDebt: summary.recoverySummary.remainingDebt.toFixed(4),
    });
  }

  @OnWorkerEvent('completed')
  async onCompleted(job: Job): Promise<void> {
    const data = job.data as { tenantId?: string; loanId?: string };
    if (data.tenantId) {
      await this.audit(data.tenantId, 'QUEUE.JOB_COMPLETED', data.loanId, { queue: QUEUE_NAMES.GUARANTOR_RECOVERY, jobId: job.id, name: job.name });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, error: Error): Promise<void> {
    const data = job.data as { tenantId?: string; loanId?: string };
    if (data.tenantId) {
      await this.audit(data.tenantId, 'QUEUE.JOB_FAILED', data.loanId, {
        queue: QUEUE_NAMES.GUARANTOR_RECOVERY,
        jobId: job.id,
        name: job.name,
        error: error.message,
      });
    }
  }

  private isStillDefaulted(status: LoanStatus, arrearsDays: number): boolean {
    return status === LoanStatus.DEFAULTED || arrearsDays >= 14;
  }

  private async logNotification(
    tenantId: string,
    memberId: string,
    channel: NotificationChannel,
    recipient: string,
    templateId: string,
    message: string,
  ): Promise<void> {
    await this.prisma.notificationLog.create({
      data: {
        tenantId,
        memberId,
        channel,
        recipient,
        templateId,
        payload: { message },
        status: NotificationStatus.PENDING,
      },
    });
  }

  private async audit(
    tenantId: string,
    action: string,
    entityId: string | undefined,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: { tenantId, actorId: 'SYSTEM', action, entityType: 'Queue', entityId, metadata: metadata as Prisma.InputJsonValue },
    });
  }
}
