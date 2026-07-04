import { Inject, forwardRef } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { UserRole, AccountStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { InAppNotificationService } from '../../notifications/in-app-notification.service';
import {
  QUEUE_NAMES,
  SupportNotificationJobPayload,
  SupportNotificationJobType,
} from '../../queue/queue.constants';

@Processor(QUEUE_NAMES.SUPPORT_NOTIFICATIONS)
export class SupportNotificationsProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => InAppNotificationService))
    private readonly notifications: InAppNotificationService,
  ) {
    super();
  }

  async process(job: Job<SupportNotificationJobPayload, unknown, SupportNotificationJobType>) {
    switch (job.name) {
      case 'TICKET_CREATED':
        return this.handleTicketCreated(job.data);
      case 'TICKET_REPLIED':
        return this.handleTicketReplied(job.data);
      case 'TICKET_ASSIGNED':
        return this.handleTicketAssigned(job.data);
      case 'TICKET_RESOLVED':
      case 'TICKET_CLOSED':
        return this.handleTicketResolvedOrClosed(job.name, job.data);
      case 'TICKET_SLA_BREACH':
        return this.handleSlaBreach(job.data);
      case 'TICKET_AUTO_CLOSED':
        return this.handleTicketResolvedOrClosed('TICKET_CLOSED', job.data);
      default:
        return undefined;
    }
  }

  private async handleTicketCreated(payload: SupportNotificationJobPayload) {
    const staffUsers = await this.prisma.user.findMany({
      where: {
        tenantId: payload.tenantId,
        role: { in: [UserRole.LOAN_OFFICER, UserRole.MANAGER] },
        accountStatus: AccountStatus.ACTIVE,
      },
      select: { id: true },
    });

    const userIds = staffUsers.map((user) => user.id);
    if (userIds.length === 0) return { notifiedCount: 0 };

    await this.notifications.createManyAndEmit(
      payload.tenantId,
      userIds,
      'New support ticket',
      `A ${payload.priority ?? 'MEDIUM'} priority ${payload.category ?? 'GENERAL'} support ticket was created.`,
      'SUPPORT_TICKET_CREATED',
    );
    return { notifiedCount: userIds.length };
  }

  private async handleTicketReplied(payload: SupportNotificationJobPayload) {
    const ticket = await this.getTenantTicket(payload);
    if (!ticket) return { notifiedCount: 0 };

    if (payload.senderRole === UserRole.MEMBER) {
      if (!ticket.assignedTo) return { notifiedCount: 0 };
      await this.notifications.createAndEmit(
        payload.tenantId,
        ticket.assignedTo,
        'Support ticket reply',
        'A member replied to an assigned support ticket.',
        'SUPPORT_TICKET_REPLIED',
      );
      return { notifiedCount: 1 };
    }

    await this.notifications.createAndEmit(
      payload.tenantId,
      ticket.member.userId,
      payload.isReopen ? 'Support ticket reopened' : 'Support ticket reply',
      payload.isReopen ? 'Your support ticket has been reopened.' : 'A staff member replied to your support ticket.',
      'SUPPORT_TICKET_REPLIED',
    );
    return { notifiedCount: 1 };
  }

  private async handleTicketAssigned(payload: SupportNotificationJobPayload) {
    if (!payload.assigneeId) return { notifiedCount: 0 };
    await this.notifications.createAndEmit(
      payload.tenantId,
      payload.assigneeId,
      'Support ticket assigned',
      'A support ticket has been assigned to you.',
      'SUPPORT_TICKET_ASSIGNED',
    );
    return { notifiedCount: 1 };
  }

  private async handleTicketResolvedOrClosed(
    jobType: 'TICKET_RESOLVED' | 'TICKET_CLOSED',
    payload: SupportNotificationJobPayload,
  ) {
    const ticket = await this.getTenantTicket(payload);
    if (!ticket) return { notifiedCount: 0 };

    const isResolved = jobType === 'TICKET_RESOLVED';
    const note = payload.resolutionNote ? ` Note: ${payload.resolutionNote}` : '';
    await this.notifications.createAndEmit(
      payload.tenantId,
      ticket.member.userId,
      isResolved ? 'Support ticket resolved' : 'Support ticket closed',
      `${isResolved ? 'Your support ticket has been resolved.' : 'Your support ticket has been closed.'}${note}`,
      isResolved ? 'SUPPORT_TICKET_RESOLVED' : 'SUPPORT_TICKET_CLOSED',
    );
    return { notifiedCount: 1 };
  }

  private async handleSlaBreach(payload: SupportNotificationJobPayload) {
    const ticket = await this.getTenantTicket(payload);
    if (!ticket) return { notifiedCount: 0 };

    const recipients = new Set<string>();
    if (ticket.assignedTo) recipients.add(ticket.assignedTo);

    const managers = await this.prisma.user.findMany({
      where: {
        tenantId: payload.tenantId,
        role: { in: [UserRole.MANAGER, UserRole.TENANT_ADMIN] },
        accountStatus: AccountStatus.ACTIVE,
      },
      select: { id: true },
    });
    managers.forEach((user) => recipients.add(user.id));

    const userIds = [...recipients];
    if (userIds.length === 0) return { notifiedCount: 0 };

    await this.notifications.createManyAndEmit(
      payload.tenantId,
      userIds,
      'Support SLA breach',
      'A support ticket has breached its resolution SLA.',
      'SUPPORT_TICKET_SLA_BREACH',
    );
    return { notifiedCount: userIds.length };
  }

  private getTenantTicket(payload: SupportNotificationJobPayload) {
    return this.prisma.supportTicket.findUnique({
      where: { id: payload.ticketId, tenantId: payload.tenantId },
      select: {
        id: true,
        tenantId: true,
        assignedTo: true,
        member: { select: { userId: true } },
      },
    });
  }
}
