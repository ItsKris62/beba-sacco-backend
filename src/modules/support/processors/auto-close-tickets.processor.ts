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
export class AutoCloseTicketsProcessor extends WorkerHost {
  private readonly logger = new Logger(AutoCloseTicketsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.SUPPORT_NOTIFICATIONS)
    private readonly supportNotificationsQueue: Queue<SupportNotificationJobPayload>,
  ) {
    super();
  }

  async process(job: Job) {
    if (job.name !== 'auto-close') return;

    const threshold = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const tenants = await this.prisma.tenant.findMany({
      where: { status: TenantStatus.ACTIVE },
      select: { id: true },
    });

    let closed = 0;
    for (const tenant of tenants) {
      try {
        const tickets = await this.prisma.supportTicket.findMany({
          where: {
            tenantId: tenant.id,
            status: TicketStatus.WAITING_ON_MEMBER,
            updatedAt: { lt: threshold },
          },
          select: { id: true, tenantId: true, status: true, assignedTo: true },
        });

        if (tickets.length === 0) continue;

        const ticketIds = tickets.map((ticket) => ticket.id);
        const result = await this.prisma.supportTicket.updateMany({
          where: {
            tenantId: tenant.id,
            id: { in: ticketIds },
            status: TicketStatus.WAITING_ON_MEMBER,
            updatedAt: { lt: threshold },
          },
          data: { status: TicketStatus.CLOSED },
        });

        closed += result.count;
        for (const ticket of tickets) {
          await this.supportNotificationsQueue.add(
            'TICKET_AUTO_CLOSED',
            {
              ticketId: ticket.id,
              tenantId: ticket.tenantId,
              previousStatus: ticket.status,
              newStatus: TicketStatus.CLOSED,
              assigneeId: ticket.assignedTo ?? undefined,
            },
            SUPPORT_NOTIFICATION_JOB_OPTIONS,
          );
        }
      } catch (error) {
        this.logger.error(
          `Failed to auto-close support tickets for tenant ${tenant.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    this.logger.log(`Auto-closed ${closed} support tickets`);
  }
}
