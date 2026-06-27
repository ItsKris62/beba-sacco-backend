import { Logger } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { TenantStatus, TicketStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  QUEUE_NAMES,
  SUPPORT_NOTIFICATION_JOB_OPTIONS,
  SupportNotificationJobPayload,
} from '../../queue/queue.constants';

@Processor(QUEUE_NAMES.SUPPORT_WORKFLOWS)
export class SlaProcessor extends WorkerHost {
  private readonly logger = new Logger(SlaProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.SUPPORT_NOTIFICATIONS)
    private readonly supportNotificationsQueue: Queue<SupportNotificationJobPayload>,
  ) {
    super();
  }

  async process(job: Job) {
    if (job.name !== 'check-sla') return;

    const now = new Date();
    const tenants = await this.prisma.tenant.findMany({
      where: { status: TenantStatus.ACTIVE },
      select: { id: true },
    });

    let enqueued = 0;
    for (const tenant of tenants) {
      const breachedTickets = await this.prisma.supportTicket.findMany({
        where: {
          tenantId: tenant.id,
          status: { in: [TicketStatus.OPEN, TicketStatus.IN_PROGRESS] },
          resolutionDueAt: { lt: now },
        },
        select: { id: true, tenantId: true },
      });

      for (const ticket of breachedTickets) {
        await this.supportNotificationsQueue.add(
          'TICKET_SLA_BREACH',
          { ticketId: ticket.id, tenantId: ticket.tenantId },
          SUPPORT_NOTIFICATION_JOB_OPTIONS,
        );
        enqueued += 1;
      }
    }

    this.logger.log(`Enqueued ${enqueued} support SLA breach notification jobs`);
  }
}
