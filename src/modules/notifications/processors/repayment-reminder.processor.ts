import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationChannel, NotificationStatus, Prisma } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { Decimal } from 'decimal.js';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  EmailJobPayload,
  QUEUE_NAMES,
  REPAYMENT_REMINDER_SCAN_JOB,
  RepaymentReminderScanJobPayload,
  SmsJobPayload,
} from '../../queue/queue.constants';

const EAT_TIME_ZONE = 'Africa/Nairobi';
const DUE_OFFSETS = [7, 3, 1, 0, -1, -3, -7] as const;

@Processor(QUEUE_NAMES.REPAYMENT_REMINDER, { concurrency: 1 })
export class RepaymentReminderProcessor extends WorkerHost {
  private readonly logger = new Logger(RepaymentReminderProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.REPAYMENT_REMINDER)
    private readonly reminderQueue: Queue<RepaymentReminderScanJobPayload>,
    @InjectQueue(QUEUE_NAMES.SMS)
    private readonly smsQueue: Queue<SmsJobPayload>,
    @InjectQueue(QUEUE_NAMES.EMAIL)
    private readonly emailQueue: Queue<EmailJobPayload>,
  ) {
    super();
  }

  @Cron('0 8 * * *', { timeZone: EAT_TIME_ZONE })
  async enqueueDailyScan(): Promise<void> {
    const runDateIso = this.dayKey(new Date());
    await this.reminderQueue.add(
      REPAYMENT_REMINDER_SCAN_JOB,
      { runDateIso },
      {
        jobId: `${REPAYMENT_REMINDER_SCAN_JOB}:${runDateIso}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
    await this.auditQueueAction('SYSTEM', 'REPAYMENT_REMINDER.QUEUED', undefined, {
      runDateIso,
    });
  }

  async process(job: Job<RepaymentReminderScanJobPayload>): Promise<void> {
    const runDate = new Date(`${job.data.runDateIso}T00:00:00.000+03:00`);
    for (const offset of DUE_OFFSETS) {
      await this.enqueueForOffset(runDate, offset, job.data.tenantId);
    }
  }

  private async enqueueForOffset(runDate: Date, offsetDays: number, tenantId?: string): Promise<void> {
    const target = this.addDays(runDate, offsetDays);
    const start = new Date(target);
    const end = new Date(target);
    end.setHours(23, 59, 59, 999);

    const rows = await this.prisma.loanRepayment.findMany({
      where: {
        tenantId,
        status: { in: ['PENDING', 'PARTIAL'] },
        paymentDate: { gte: start, lte: end },
        loan: { status: { in: ['ACTIVE', 'DISBURSED', 'DEFAULTED'] } },
      },
      include: {
        loan: {
          include: {
            member: { include: { user: true } },
          },
        },
      },
    });

    for (const row of rows) {
      const member = row.loan.member;
      const firstName = member.user.firstName;
      const amount = new Decimal(row.amountPaid.toString()).toFixed(2);
      const dueDate = row.paymentDate.toISOString().split('T')[0];
      const timing = offsetDays > 0
        ? `due in ${offsetDays} day${offsetDays === 1 ? '' : 's'}`
        : offsetDays === 0
          ? 'due today'
          : `${new Decimal(offsetDays).abs().toFixed(0)} day${offsetDays === -1 ? '' : 's'} overdue`;
      const message = `Reminder: Loan ${row.loan.loanNumber} installment of KES ${amount} is ${timing}. Due date: ${dueDate}.`;

      if (member.user.phone ?? member.user.phoneNumber) {
        await this.enqueueSmsOnce(row.tenantId, member.id, member.user.phone ?? member.user.phoneNumber ?? '', message);
      }
      if (member.user.email) {
        await this.enqueueEmailOnce(row.tenantId, member.id, member.user.email, firstName, message);
      }
    }
  }

  private async enqueueSmsOnce(
    tenantId: string,
    memberId: string,
    phone: string,
    message: string,
  ): Promise<void> {
    if (await this.sentToday(tenantId, memberId, NotificationChannel.SMS, 'REPAYMENT_REMINDER')) {
      return;
    }
    await this.prisma.notificationLog.create({
      data: {
        tenantId,
        memberId,
        channel: NotificationChannel.SMS,
        recipient: phone,
        templateId: 'REPAYMENT_REMINDER',
        payload: { message },
        status: NotificationStatus.PENDING,
      },
    });
    await this.smsQueue.add('send', { type: 'REPAYMENT_REMINDER', phone, message }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }

  private async enqueueEmailOnce(
    tenantId: string,
    memberId: string,
    to: string,
    firstName: string,
    message: string,
  ): Promise<void> {
    if (await this.sentToday(tenantId, memberId, NotificationChannel.EMAIL, 'REPAYMENT_REMINDER')) {
      return;
    }
    await this.prisma.notificationLog.create({
      data: {
        tenantId,
        memberId,
        channel: NotificationChannel.EMAIL,
        recipient: to,
        templateId: 'REPAYMENT_REMINDER',
        payload: { message },
        status: NotificationStatus.PENDING,
      },
    });
    await this.emailQueue.add('send', {
      type: 'SYSTEM_NOTICE',
      to,
      firstName,
      subject: 'Loan repayment reminder',
      body: message,
    }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }

  private async sentToday(
    tenantId: string,
    memberId: string,
    channel: NotificationChannel,
    templateId: string,
  ): Promise<boolean> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const existing = await this.prisma.notificationLog.findFirst({
      where: { tenantId, memberId, channel, templateId, createdAt: { gte: start } },
      select: { id: true },
    });
    return Boolean(existing);
  }

  private addDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  private dayKey(date: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: EAT_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  private async auditQueueAction(
    tenantId: string,
    action: string,
    entityId: string | undefined,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: { tenantId, actorId: 'SYSTEM', action, entityType: 'Queue', entityId, metadata: metadata as Prisma.InputJsonValue },
    }).catch((error: unknown) => this.logger.warn(`Audit queue action failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}
