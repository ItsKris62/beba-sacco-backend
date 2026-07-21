import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationChannel } from '@prisma/client';
import { Queue } from 'bullmq';
import { DOMAIN_EVENTS, DomainEventName } from '../../../common/constants/events';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  SEND_NOTIFICATION_JOB,
  SendNotificationJobPayload,
} from '../queues/notification-job.types';
import { NOTIFICATION_JOB_OPTIONS, NOTIFICATION_QUEUE_NAMES } from '../queues/queue.constants';

type DomainEventPayload = Record<string, unknown> & { tenantId: string };

interface ContactTarget {
  userId: string;
  memberId?: string;
  firstName?: string | null;
  email?: string | null;
  phone?: string | null;
  preferences: {
    emailEnabled: boolean;
    smsEnabled: boolean;
    inAppEnabled: boolean;
  };
}

interface NotificationTemplate {
  eventType: DomainEventName;
  templateId: string;
  subject: string;
  body: string;
  channels: NotificationChannel[];
  entityId?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class NotificationEventListener {
  private readonly logger = new Logger(NotificationEventListener.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(NOTIFICATION_QUEUE_NAMES.EMAIL_QUEUE)
    private readonly emailQueue: Queue<SendNotificationJobPayload>,
    @InjectQueue(NOTIFICATION_QUEUE_NAMES.SMS_QUEUE)
    private readonly smsQueue: Queue<SendNotificationJobPayload>,
    @InjectQueue(NOTIFICATION_QUEUE_NAMES.IN_APP_QUEUE)
    private readonly inAppQueue: Queue<SendNotificationJobPayload>,
  ) {}

  @OnEvent(DOMAIN_EVENTS.LOAN.APPLICATION_RECEIVED)
  async onLoanApplicationReceived(payload: DomainEventPayload): Promise<void> {
    await this.enqueueForMember(payload, {
      eventType: DOMAIN_EVENTS.LOAN.APPLICATION_RECEIVED,
      templateId: 'LOAN_APPLICATION_RECEIVED',
      subject: 'Loan application received',
      body: 'Your loan application has been received and is under review.',
      channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
      entityId: this.asString(payload.loanId),
    });
  }

  @OnEvent(DOMAIN_EVENTS.LOAN.APPROVED)
  async onLoanApproved(payload: DomainEventPayload): Promise<void> {
    await this.enqueueForMember(payload, {
      eventType: DOMAIN_EVENTS.LOAN.APPROVED,
      templateId: 'LOAN_APPROVED',
      subject: 'Loan approved',
      body: 'Your loan application has been approved.',
      channels: [NotificationChannel.SMS, NotificationChannel.EMAIL, NotificationChannel.IN_APP],
      entityId: this.asString(payload.loanId),
    });
  }

  @OnEvent(DOMAIN_EVENTS.LOAN.REJECTED)
  async onLoanRejected(payload: DomainEventPayload): Promise<void> {
    await this.enqueueForMember(payload, {
      eventType: DOMAIN_EVENTS.LOAN.REJECTED,
      templateId: 'LOAN_REJECTED',
      subject: 'Loan not approved',
      body: 'Your loan application was not approved. Please contact the SACCO for details.',
      channels: [NotificationChannel.SMS, NotificationChannel.EMAIL, NotificationChannel.IN_APP],
      entityId: this.asString(payload.loanId),
    });
  }

  @OnEvent(DOMAIN_EVENTS.LOAN.DISBURSED)
  async onLoanDisbursed(payload: DomainEventPayload): Promise<void> {
    await this.enqueueForMember(payload, {
      eventType: DOMAIN_EVENTS.LOAN.DISBURSED,
      templateId: 'LOAN_DISBURSED',
      subject: 'Loan disbursed',
      body: 'Your loan has been disbursed successfully.',
      channels: [NotificationChannel.SMS, NotificationChannel.EMAIL, NotificationChannel.IN_APP],
      entityId: this.asString(payload.loanId),
    });
  }

  @OnEvent(DOMAIN_EVENTS.LOAN.REPAID)
  async onLoanRepaid(payload: DomainEventPayload): Promise<void> {
    await this.enqueueForMember(payload, {
      eventType: DOMAIN_EVENTS.LOAN.REPAID,
      templateId: 'LOAN_REPAID',
      subject: 'Loan fully repaid',
      body: 'Your loan is now fully repaid. Thank you for keeping your account in good standing.',
      channels: [NotificationChannel.SMS, NotificationChannel.EMAIL, NotificationChannel.IN_APP],
      entityId: this.asString(payload.loanId),
    });
  }

  @OnEvent(DOMAIN_EVENTS.GUARANTOR.REQUESTED)
  async onGuarantorRequested(payload: DomainEventPayload): Promise<void> {
    const amount = this.formatAmount(payload.guaranteedAmount);
    await this.enqueueForUser(payload, this.asString(payload.guarantorUserId), {
      eventType: DOMAIN_EVENTS.GUARANTOR.REQUESTED,
      templateId: 'GUARANTOR_REQUESTED',
      subject: 'Guarantor request',
      body: amount
        ? `You have been requested to guarantee a loan for ${amount}.`
        : 'You have been requested to guarantee a loan.',
      channels: [NotificationChannel.SMS, NotificationChannel.EMAIL, NotificationChannel.IN_APP],
      entityId: this.asString(payload.loanId),
    });
  }

  @OnEvent(DOMAIN_EVENTS.GUARANTOR.ACCEPTED)
  async onGuarantorAccepted(payload: DomainEventPayload): Promise<void> {
    await this.enqueueGuarantorResponse(payload, DOMAIN_EVENTS.GUARANTOR.ACCEPTED, 'accepted');
  }

  @OnEvent(DOMAIN_EVENTS.GUARANTOR.REJECTED)
  async onGuarantorRejected(payload: DomainEventPayload): Promise<void> {
    await this.enqueueGuarantorResponse(payload, DOMAIN_EVENTS.GUARANTOR.REJECTED, 'rejected');
  }

  @OnEvent(DOMAIN_EVENTS.GUARANTOR.FORFEITED)
  async onGuarantorForfeited(payload: DomainEventPayload): Promise<void> {
    const amount = this.formatAmount(payload.amountSlashed);
    await this.enqueueForUser(payload, this.asString(payload.guarantorUserId), {
      eventType: DOMAIN_EVENTS.GUARANTOR.FORFEITED,
      templateId: 'GUARANTOR_FORFEITED',
      subject: 'Guarantor recovery posted',
      body: amount
        ? `${amount} has been recovered from your guaranteed savings for a defaulted loan.`
        : 'A guarantor recovery has been posted against your guaranteed savings.',
      channels: [NotificationChannel.SMS, NotificationChannel.EMAIL, NotificationChannel.IN_APP],
      entityId: this.asString(payload.loanId),
    });
  }

  @OnEvent(DOMAIN_EVENTS.MPESA.DEPOSIT_SUCCESS)
  async onMpesaDepositSuccess(payload: DomainEventPayload): Promise<void> {
    const amount = this.formatAmount(payload.amount);
    await this.enqueueForMember(payload, {
      eventType: DOMAIN_EVENTS.MPESA.DEPOSIT_SUCCESS,
      templateId: 'MPESA_DEPOSIT_SUCCESS',
      subject: 'M-Pesa deposit received',
      body: amount
        ? `Your M-Pesa deposit of ${amount} has been posted successfully.`
        : 'Your M-Pesa deposit has been posted successfully.',
      channels: [NotificationChannel.SMS, NotificationChannel.IN_APP],
      entityId: this.asString(payload.transactionRef),
    });
  }

  @OnEvent(DOMAIN_EVENTS.MPESA.DEPOSIT_FAILED)
  async onMpesaDepositFailed(payload: DomainEventPayload): Promise<void> {
    const reason = this.asString(payload.reason);
    await this.enqueueForMember(payload, {
      eventType: DOMAIN_EVENTS.MPESA.DEPOSIT_FAILED,
      templateId: 'MPESA_DEPOSIT_FAILED',
      subject: 'M-Pesa deposit failed',
      body: reason
        ? `Your M-Pesa deposit could not be posted: ${reason}.`
        : 'Your M-Pesa deposit could not be posted.',
      channels: [NotificationChannel.SMS, NotificationChannel.IN_APP],
      entityId: this.asString(payload.transactionRef),
    });
  }

  @OnEvent(DOMAIN_EVENTS.MPESA.REPAYMENT_SUCCESS)
  async onMpesaRepaymentSuccess(payload: DomainEventPayload): Promise<void> {
    const amount = this.formatAmount(payload.amount);
    await this.enqueueForMember(payload, {
      eventType: DOMAIN_EVENTS.MPESA.REPAYMENT_SUCCESS,
      templateId: 'MPESA_REPAYMENT_SUCCESS',
      subject: 'Loan repayment received',
      body: amount
        ? `Your loan repayment of ${amount} has been posted successfully.`
        : 'Your loan repayment has been posted successfully.',
      channels: [NotificationChannel.SMS, NotificationChannel.EMAIL, NotificationChannel.IN_APP],
      entityId: this.asString(payload.transactionRef) ?? this.asString(payload.loanId),
    });
  }

  @OnEvent(DOMAIN_EVENTS.KYC.APPROVED)
  async onKycApproved(payload: DomainEventPayload): Promise<void> {
    await this.enqueueForMember(payload, {
      eventType: DOMAIN_EVENTS.KYC.APPROVED,
      templateId: 'KYC_APPROVED',
      subject: 'KYC approved',
      body: 'Your KYC documents have been approved.',
      channels: [NotificationChannel.SMS, NotificationChannel.EMAIL, NotificationChannel.IN_APP],
      entityId: this.asString(payload.memberId),
    });
  }

  @OnEvent(DOMAIN_EVENTS.KYC.REJECTED)
  async onKycRejected(payload: DomainEventPayload): Promise<void> {
    await this.enqueueForMember(payload, {
      eventType: DOMAIN_EVENTS.KYC.REJECTED,
      templateId: 'KYC_REJECTED',
      subject: 'KYC rejected',
      body: 'Your KYC submission was rejected. Please review and resubmit the required documents.',
      channels: [NotificationChannel.SMS, NotificationChannel.EMAIL, NotificationChannel.IN_APP],
      entityId: this.asString(payload.memberId),
    });
  }

  @OnEvent(DOMAIN_EVENTS.MEMBER.ACCOUNT_ACTIVATED)
  async onMemberAccountActivated(payload: DomainEventPayload): Promise<void> {
    await this.enqueueForMember(payload, {
      eventType: DOMAIN_EVENTS.MEMBER.ACCOUNT_ACTIVATED,
      templateId: 'MEMBER_ACCOUNT_ACTIVATED',
      subject: 'Account activated',
      body: 'Your member account is now active.',
      channels: [NotificationChannel.SMS, NotificationChannel.EMAIL, NotificationChannel.IN_APP],
      entityId: this.asString(payload.memberId),
    });
  }

  @OnEvent(DOMAIN_EVENTS.MEMBER.MONTHLY_STATEMENT_GENERATED)
  async onMonthlyStatementGenerated(payload: DomainEventPayload): Promise<void> {
    await this.enqueueForMember(payload, {
      eventType: DOMAIN_EVENTS.MEMBER.MONTHLY_STATEMENT_GENERATED,
      templateId: 'MONTHLY_STATEMENT_GENERATED',
      subject: 'Monthly statement ready',
      body: 'Your monthly account statement is ready.',
      channels: [NotificationChannel.EMAIL, NotificationChannel.IN_APP],
      entityId: this.asString(payload.statementId) ?? this.asString(payload.memberId),
    });
  }

  private async enqueueGuarantorResponse(
    payload: DomainEventPayload,
    eventType: DomainEventName,
    statusLabel: string,
  ): Promise<void> {
    await this.enqueueForUser(payload, this.asString(payload.guarantorUserId), {
      eventType,
      templateId: `GUARANTOR_${statusLabel.toUpperCase()}`,
      subject: 'Guarantor response recorded',
      body: `Your guarantor response has been recorded as ${statusLabel}.`,
      channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
      entityId: this.asString(payload.loanId),
    });
  }

  private async enqueueForMember(
    payload: DomainEventPayload,
    template: NotificationTemplate,
  ): Promise<void> {
    await this.runSafely(template.eventType, payload, async () => {
      const memberId = this.asString(payload.memberId);
      if (!memberId) {
        this.logger.warn(`Skipping ${template.eventType}; event has no memberId`);
        return;
      }

      const target = await this.findContactByMemberId(payload.tenantId, memberId);
      if (!target) {
        this.logger.warn(`Skipping ${template.eventType}; member ${memberId} not found`);
        return;
      }

      await this.enqueueForTarget(payload, target, template);
    });
  }

  private async enqueueForUser(
    payload: DomainEventPayload,
    userId: string | undefined,
    template: NotificationTemplate,
  ): Promise<void> {
    await this.runSafely(template.eventType, payload, async () => {
      if (!userId) {
        this.logger.warn(`Skipping ${template.eventType}; event has no userId`);
        return;
      }

      const target = await this.findContactByUserId(payload.tenantId, userId);
      if (!target) {
        this.logger.warn(`Skipping ${template.eventType}; user ${userId} not found`);
        return;
      }

      await this.enqueueForTarget(payload, target, template);
    });
  }

  private async enqueueForTarget(
    payload: DomainEventPayload,
    target: ContactTarget,
    template: NotificationTemplate,
  ): Promise<void> {
    const jobs = template.channels
      .filter((channel) => this.isChannelEnabled(channel, target))
      .map((channel) => this.buildJob(payload, target, template, channel))
      .filter((job): job is SendNotificationJobPayload => Boolean(job));

    await Promise.all(
      jobs.map((job) =>
        this.queueForChannel(job.channel).add(SEND_NOTIFICATION_JOB, job, {
          ...NOTIFICATION_JOB_OPTIONS,
          jobId: job.dedupeKey,
        }),
      ),
    );
  }

  private buildJob(
    payload: DomainEventPayload,
    target: ContactTarget,
    template: NotificationTemplate,
    channel: NotificationChannel,
  ): SendNotificationJobPayload | undefined {
    const recipient = this.recipientForChannel(channel, target);
    if (!recipient) {
      return undefined;
    }

    const dedupeKey = [
      payload.tenantId,
      template.eventType,
      channel,
      recipient,
      template.entityId ?? target.memberId ?? target.userId,
      this.asString(payload.status) ?? this.asString(payload.kycStatus) ?? '',
      this.asString(payload.transactionRef) ?? '',
    ].join('|');

    return {
      tenantId: payload.tenantId,
      eventType: template.eventType,
      channel,
      recipient,
      templateId: template.templateId,
      subject: template.subject,
      body: template.body,
      memberId: target.memberId,
      userId: target.userId,
      entityId: template.entityId,
      dedupeKey,
      metadata: {
        ...template.metadata,
        eventPayload: payload,
        title: template.subject,
        type: template.templateId,
      },
    };
  }

  private queueForChannel(channel: NotificationChannel): Queue<SendNotificationJobPayload> {
    switch (channel) {
      case NotificationChannel.EMAIL:
        return this.emailQueue;
      case NotificationChannel.SMS:
        return this.smsQueue;
      case NotificationChannel.IN_APP:
        return this.inAppQueue;
      default:
        throw new Error(`No notification queue configured for ${channel}`);
    }
  }

  private recipientForChannel(channel: NotificationChannel, target: ContactTarget): string | undefined {
    switch (channel) {
      case NotificationChannel.EMAIL:
        return target.email ?? undefined;
      case NotificationChannel.SMS:
        return target.phone ?? undefined;
      case NotificationChannel.IN_APP:
        return target.userId;
      default:
        return undefined;
    }
  }

  private isChannelEnabled(channel: NotificationChannel, target: ContactTarget): boolean {
    switch (channel) {
      case NotificationChannel.EMAIL:
        return target.preferences.emailEnabled;
      case NotificationChannel.SMS:
        return target.preferences.smsEnabled;
      case NotificationChannel.IN_APP:
        return target.preferences.inAppEnabled;
      default:
        return false;
    }
  }

  private async findContactByMemberId(
    tenantId: string,
    memberId: string,
  ): Promise<ContactTarget | undefined> {
    const db = this.prisma.forContext(tenantId);
    const member = await db.member.findFirst({
      where: { id: memberId },
      select: {
        id: true,
        userId: true,
        user: {
          select: {
            id: true,
            email: true,
            phone: true,
            phoneNumber: true,
            firstName: true,
          },
        },
      },
    });

    if (!member) {
      return undefined;
    }

    return this.withPreferences(tenantId, {
      userId: member.userId,
      memberId: member.id,
      firstName: member.user.firstName,
      email: member.user.email,
      phone: member.user.phoneNumber ?? member.user.phone,
      preferences: this.defaultPreferences(),
    });
  }

  private async findContactByUserId(
    tenantId: string,
    userId: string,
  ): Promise<ContactTarget | undefined> {
    const db = this.prisma.forContext(tenantId);
    const user = await db.user.findFirst({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        phoneNumber: true,
        firstName: true,
        member: { select: { id: true } },
      },
    });

    if (!user) {
      return undefined;
    }

    return this.withPreferences(tenantId, {
      userId: user.id,
      memberId: user.member?.id,
      firstName: user.firstName,
      email: user.email,
      phone: user.phoneNumber ?? user.phone,
      preferences: this.defaultPreferences(),
    });
  }

  private async withPreferences(
    tenantId: string,
    target: ContactTarget,
  ): Promise<ContactTarget> {
    const db = this.prisma.forContext(tenantId);
    const preferences = await db.notificationPreference.findFirst({
      where: { userId: target.userId },
      select: {
        emailEnabled: true,
        smsEnabled: true,
        inAppEnabled: true,
      },
    });

    return {
      ...target,
      preferences: preferences ?? this.defaultPreferences(),
    };
  }

  private defaultPreferences(): ContactTarget['preferences'] {
    return {
      emailEnabled: true,
      smsEnabled: true,
      inAppEnabled: true,
    };
  }

  private async runSafely(
    eventType: DomainEventName,
    payload: DomainEventPayload,
    callback: () => Promise<void>,
  ): Promise<void> {
    try {
      await callback();
    } catch (error) {
      this.logger.error(
        `Failed to enqueue notifications for ${eventType} tenant=${payload.tenantId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private formatAmount(value: unknown): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    return `KES ${String(value)}`;
  }
}
