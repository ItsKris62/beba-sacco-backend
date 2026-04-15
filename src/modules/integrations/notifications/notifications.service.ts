import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { QUEUE_NAMES, MultiChannelNotifyJobPayload } from '../../queue/queue.constants';

/**
 * Multi-Channel Notification Service – Phase 5
 *
 * Routes notifications to SMS, WhatsApp, or Email based on member preference
 * and cost tier. Uses Africa's Talking (stub) for SMS/WhatsApp and existing
 * Plunk service for email.
 *
 * Template engine resolves notification content based on templateId.
 * Delivery status is tracked in NotificationLog.
 *
 * Production: Replace stubs with actual Africa's Talking / Twilio SDK calls.
 */

// ── Notification templates ──────────────────────────────────────────────────
const TEMPLATES: Record<string, { subject: string; body: string }> = {
  LOAN_APPROVED: {
    subject: 'Loan Approved',
    body: 'Dear {{firstName}}, your loan {{loanNumber}} for KES {{amount}} has been approved.',
  },
  LOAN_DISBURSED: {
    subject: 'Loan Disbursed',
    body: 'Dear {{firstName}}, KES {{amount}} has been disbursed to your account {{accountNumber}}.',
  },
  REPAYMENT_REMINDER: {
    subject: 'Repayment Reminder',
    body: 'Dear {{firstName}}, your loan {{loanNumber}} instalment of KES {{amount}} is due on {{dueDate}}.',
  },
  REPAYMENT_RECEIVED: {
    subject: 'Payment Received',
    body: 'Dear {{firstName}}, we received KES {{amount}} for loan {{loanNumber}}. Balance: KES {{balance}}.',
  },
  ARREARS_NOTICE: {
    subject: 'Arrears Notice',
    body: 'Dear {{firstName}}, your loan {{loanNumber}} is {{arrearsDays}} days in arrears. Please make payment.',
  },
  WELCOME: {
    subject: 'Welcome to {{saccoName}}',
    body: 'Dear {{firstName}}, welcome to {{saccoName}}! Your member number is {{memberNumber}}.',
  },
  GUARANTOR_INVITE: {
    subject: 'Guarantor Request',
    body: 'Dear {{firstName}}, {{borrowerName}} has requested you to guarantee loan {{loanNumber}} for KES {{amount}}.',
  },
};

// ── Cost tiers (KES) ────────────────────────────────────────────────────────
const CHANNEL_COSTS: Record<string, number> = {
  EMAIL: 0,
  SMS: 1.5,
  WHATSAPP: 0.8,
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.NOTIFY_MULTI)
    private readonly notifyQueue: Queue<MultiChannelNotifyJobPayload>,
  ) {}

  /**
   * Send a notification via the preferred channel.
   * Creates a NotificationLog entry and queues for async delivery.
   */
  async send(params: {
    tenantId: string;
    memberId?: string;
    channel: 'EMAIL' | 'SMS' | 'WHATSAPP';
    recipient: string;
    templateId: string;
    payload: Record<string, unknown>;
  }) {
    const { tenantId, memberId, channel, recipient, templateId, payload } = params;

    // Create notification log entry
    const notification = await this.prisma.notificationLog.create({
      data: {
        tenantId,
        memberId,
        channel,
        recipient,
        templateId,
        payload: payload as Prisma.InputJsonValue,
        status: 'PENDING',
        cost: CHANNEL_COSTS[channel] ?? 0,
      },
    });

    // Queue for async delivery
    await this.notifyQueue.add(
      'deliver',
      {
        tenantId,
        notificationId: notification.id,
        channel,
        recipient,
        templateId,
        payload,
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
      },
    );

    return {
      notificationId: notification.id,
      channel,
      recipient,
      status: 'QUEUED',
    };
  }

  /**
   * Process notification delivery (called by queue processor).
   */
  async deliver(notificationId: string): Promise<void> {
    const notification = await this.prisma.notificationLog.findUnique({
      where: { id: notificationId },
    });

    if (!notification) {
      this.logger.warn(`Notification ${notificationId} not found`);
      return;
    }

    const template = TEMPLATES[notification.templateId];
    if (!template) {
      await this.markFailed(notificationId, `Unknown template: ${notification.templateId}`);
      return;
    }

    // Resolve template
    const payload = notification.payload as Record<string, unknown>;
    const body = this.resolveTemplate(template.body, payload);
    const subject = this.resolveTemplate(template.subject, payload);

    try {
      switch (notification.channel) {
        case 'SMS':
          await this.sendSms(notification.recipient, body);
          break;
        case 'WHATSAPP':
          await this.sendWhatsApp(notification.recipient, body);
          break;
        case 'EMAIL':
          await this.sendEmail(notification.recipient, subject, body);
          break;
      }

      await this.prisma.notificationLog.update({
        where: { id: notificationId },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          providerRef: `MOCK-${Date.now()}`,
        },
      });

      this.logger.log(`Notification ${notificationId} sent via ${notification.channel}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.markFailed(notificationId, reason);
      throw err;
    }
  }

  /**
   * Get notification delivery status.
   */
  async getNotifications(tenantId: string, memberId?: string, limit = 50) {
    return this.prisma.notificationLog.findMany({
      where: {
        tenantId,
        ...(memberId && { memberId }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  // ── Channel adapters (stubs – replace with real SDK in production) ─────────

  /**
   * MOCK: Send SMS via Africa's Talking.
   * Production: Use africastalking SDK.
   */
  private async sendSms(phoneNumber: string, message: string): Promise<void> {
    this.logger.log(`[MOCK SMS] To: ${phoneNumber} | Message: ${message.slice(0, 50)}...`);
    // Production:
    // const AT = require('africastalking')({ apiKey: process.env.AT_API_KEY, username: process.env.AT_USERNAME });
    // await AT.SMS.send({ to: [phoneNumber], message, from: process.env.AT_SENDER_ID });
  }

  /**
   * MOCK: Send WhatsApp via Africa's Talking or Twilio.
   */
  private async sendWhatsApp(phoneNumber: string, message: string): Promise<void> {
    this.logger.log(`[MOCK WhatsApp] To: ${phoneNumber} | Message: ${message.slice(0, 50)}...`);
    // Production:
    // const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
    // await twilio.messages.create({ body: message, from: 'whatsapp:+14155238886', to: `whatsapp:${phoneNumber}` });
  }

  /**
   * MOCK: Send email via Plunk or SMTP.
   */
  private async sendEmail(to: string, subject: string, body: string): Promise<void> {
    this.logger.log(`[MOCK Email] To: ${to} | Subject: ${subject}`);
    // Production: Use PlunkService or nodemailer
  }

  private resolveTemplate(template: string, vars: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ''));
  }

  private async markFailed(notificationId: string, reason: string): Promise<void> {
    await this.prisma.notificationLog.update({
      where: { id: notificationId },
      data: { status: 'FAILED', failReason: reason },
    });
  }
}
