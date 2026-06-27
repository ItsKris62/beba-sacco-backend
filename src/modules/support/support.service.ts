import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ModuleRef } from '@nestjs/core';
import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { TicketCategory, TicketPriority, TicketStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AuthActor } from './support-ticket.types';
import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';
import { CreateTicketMessageDto } from './dto/create-ticket-message.dto';
import { UpdateSupportTicketDto } from './dto/update-support-ticket.dto';
import { ConfirmUploadDto, RequestPresignDto } from './dto/support.dto';
import {
  QUEUE_NAMES,
  SUPPORT_NOTIFICATION_JOB_OPTIONS,
  SupportNotificationJobPayload,
  SupportNotificationJobType,
} from '../queue/queue.constants';

const SUPPORT_ATTACHMENT_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const SUPPORT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const STAFF_ROLES = [
  UserRole.LOAN_OFFICER,
  UserRole.MANAGER,
  UserRole.TENANT_ADMIN,
  UserRole.SUPER_ADMIN,
];

const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  [TicketStatus.OPEN]: [TicketStatus.IN_PROGRESS, TicketStatus.CLOSED],
  [TicketStatus.IN_PROGRESS]: [TicketStatus.WAITING_ON_MEMBER, TicketStatus.RESOLVED],
  [TicketStatus.WAITING_ON_MEMBER]: [TicketStatus.IN_PROGRESS, TicketStatus.OPEN],
  [TicketStatus.RESOLVED]: [TicketStatus.CLOSED, TicketStatus.OPEN],
  [TicketStatus.CLOSED]: [TicketStatus.OPEN],
};

@Injectable()
export class SupportService {
  private readonly logger: Logger = new Logger(SupportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @InjectQueue(QUEUE_NAMES.SUPPORT_NOTIFICATIONS)
    private readonly supportNotificationsQueue: Queue<SupportNotificationJobPayload>,
    private readonly moduleRef: ModuleRef,
  ) {}

  async assertTicketAccess(ticketId: string, tenantId: string, actor: AuthActor) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId, tenantId },
      include: {
        member: {
          include: { user: { select: { firstName: true, lastName: true, email: true, phoneNumber: true } } },
        },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!ticket) throw new NotFoundException('Support ticket not found');

    if (actor.role === UserRole.MEMBER && ticket.member.userId !== actor.userId) {
      throw new ForbiddenException('You do not have access to this ticket');
    }
    return ticket;
  }

  async createTicket(dto: CreateSupportTicketDto, tenantId: string, actor: AuthActor) {
    const member = await this.requireActorMember(tenantId, actor.userId);

    const ticket = await this.prisma.$transaction(async (tx) => {
      if (dto.relatedLoanId) {
        const loan = await tx.loan.findFirst({ where: { id: dto.relatedLoanId } });
        if (!loan) throw new NotFoundException('Related loan not found');
        if (loan.tenantId !== tenantId || loan.memberId !== member.id) {
          throw new ForbiddenException('Related loan does not belong to this member and tenant');
        }
      }

      if (dto.relatedTxId) {
        const mpesaTx = await tx.mpesaTransaction.findFirst({ where: { id: dto.relatedTxId } });
        if (!mpesaTx) throw new NotFoundException('Related M-Pesa transaction not found');
        if (mpesaTx.tenantId !== tenantId) {
          throw new ForbiddenException('Related M-Pesa transaction does not belong to this tenant');
        }
      }

      return tx.supportTicket.create({
        data: {
          tenantId,
          memberId: member.id,
          subject: dto.subject,
          description: dto.description,
          priority: dto.priority || TicketPriority.MEDIUM,
          category: dto.category,
          relatedLoanId: dto.relatedLoanId,
          relatedTxId: dto.relatedTxId,
          status: TicketStatus.OPEN,
          messages: {
            create: {
              tenantId,
              senderId: actor.userId,
              senderRole: actor.role as UserRole,
              content: dto.description,
              attachments: [],
            },
          },
        },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      });
    });

    await this.enqueueSupportNotification('TICKET_CREATED', {
      ticketId: ticket.id,
      tenantId,
      memberId: member.id,
      category: ticket.category,
      priority: ticket.priority,
    });
    this.emitToUser(tenantId, actor.userId, 'ticket_created', ticket);
    this.logger.log(`Ticket created: ${ticket.id} by member ${member.id} in tenant ${tenantId}`);

    return ticket;
  }

  async listTickets(
    tenantId: string,
    actor: AuthActor,
    filters: {
      status?: string;
      priority?: TicketPriority;
      category?: TicketCategory;
      search?: string;
      assigneeId?: string;
      page?: number | string;
      limit?: number | string;
    } = {},
  ) {
    const member = actor.role === UserRole.MEMBER
      ? await this.requireActorMember(tenantId, actor.userId)
      : null;
    const statuses = filters.status
      ?.split(',')
      .map((status) => status.trim())
      .filter((status): status is TicketStatus =>
        Object.values(TicketStatus).includes(status as TicketStatus),
      );
    const page = this.normalizePositiveInt(filters.page, 1);
    const limit = Math.min(this.normalizePositiveInt(filters.limit, 20), 100);
    const skip = (page - 1) * limit;
    const where = {
      tenantId,
      ...(member ? { memberId: member.id } : {}),
      ...(statuses?.length === 1 ? { status: statuses[0] } : {}),
      ...(statuses && statuses.length > 1 ? { status: { in: statuses } } : {}),
      ...(filters.assigneeId ? { assignedTo: filters.assigneeId } : {}),
      ...(filters.priority ? { priority: filters.priority } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.search
        ? {
            OR: [
              { subject: { contains: filters.search, mode: 'insensitive' as const } },
              { description: { contains: filters.search, mode: 'insensitive' as const } },
              { member: { memberNumber: { contains: filters.search, mode: 'insensitive' as const } } },
              { member: { user: { firstName: { contains: filters.search, mode: 'insensitive' as const } } } },
              { member: { user: { lastName: { contains: filters.search, mode: 'insensitive' as const } } } },
              { member: { user: { email: { contains: filters.search, mode: 'insensitive' as const } } } },
            ],
          }
        : {}),
    };

    const [total, data] = await Promise.all([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.findMany({
        where,
        include: {
          member: {
            select: {
              id: true,
              memberNumber: true,
              user: { select: { firstName: true, lastName: true, email: true, phoneNumber: true } },
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getTicket(id: string, tenantId: string, actor: AuthActor) {
    return this.assertTicketAccess(id, tenantId, actor);
  }

  async addMessage(
    id: string,
    dto: CreateTicketMessageDto,
    tenantId: string,
    actor: AuthActor,
  ) {
    const ticket = await this.assertTicketAccess(id, tenantId, actor);

    if (ticket.status === TicketStatus.CLOSED && !dto.reopen) {
      throw new BadRequestException('Closed tickets can only receive messages when reopen is true');
    }

    const message = await this.prisma.$transaction(async (tx) => {
      const message = await tx.ticketMessage.create({
        data: {
          tenantId,
          ticketId: ticket.id,
          senderId: actor.userId,
          senderRole: actor.role as UserRole,
          content: dto.content,
          attachments: dto.attachments ?? [],
        },
      });

      const nextStatus = dto.reopen
        ? TicketStatus.OPEN
        : actor.role === UserRole.MEMBER
          ? TicketStatus.OPEN
          : ticket.status === TicketStatus.OPEN
            ? TicketStatus.IN_PROGRESS
            : TicketStatus.WAITING_ON_MEMBER;

      if (nextStatus !== ticket.status) {
        this.assertAllowedTransition(ticket.status, nextStatus);
      }

      await tx.supportTicket.update({
        where: { id: ticket.id },
        data: { status: nextStatus },
      });

      return message;
    });

    await this.enqueueSupportNotification('TICKET_REPLIED', {
      ticketId: ticket.id,
      tenantId,
      senderId: actor.userId,
      senderRole: actor.role,
      isReopen: dto.reopen === true,
    });
    this.emitToTicketRoom(tenantId, ticket.id, 'new_message', message);
    this.logger.log(`Message added to ticket ${ticket.id} by ${actor.role} ${actor.userId}`);

    return message;
  }

  async updateTicket(id: string, dto: UpdateSupportTicketDto, tenantId: string, actor: AuthActor) {
    const ticket = await this.assertTicketAccess(id, tenantId, actor);

    if (dto.status && dto.status !== ticket.status) {
      this.assertAllowedTransition(ticket.status, dto.status);
      if ((dto.status === TicketStatus.RESOLVED || dto.status === TicketStatus.CLOSED) && !dto.resolutionNote?.trim()) {
        throw new BadRequestException('resolutionNote is required when resolving or closing a support ticket');
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.supportTicket.update({
        where: { id: ticket.id },
        data: {
          status: dto.status,
          priority: dto.priority,
          assignedTo: dto.assignedTo,
        },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      });

      const note = dto.resolutionNote ?? dto.note;
      if (note) {
        await tx.ticketMessage.create({
          data: {
            tenantId,
            ticketId: ticket.id,
            senderId: actor.userId,
            senderRole: actor.role as UserRole,
            content: note,
            attachments: [],
          },
        });
      }
      return updated;
    });

    if (dto.assignedTo) {
      await this.enqueueSupportNotification('TICKET_ASSIGNED', {
        ticketId: ticket.id,
        tenantId,
        previousStatus: ticket.status,
        newStatus: updated.status,
        assigneeId: dto.assignedTo,
      });
    }

    if (dto.status && dto.status !== ticket.status) {
      const jobType = this.resolveStatusNotificationJobType(dto.status);
      if (jobType) {
        await this.enqueueSupportNotification(jobType, {
          ticketId: ticket.id,
          tenantId,
          previousStatus: ticket.status,
          newStatus: dto.status,
          assigneeId: updated.assignedTo ?? undefined,
          resolutionNote: dto.resolutionNote,
        });
      }
    }

    this.emitToTicketRoom(tenantId, ticket.id, 'ticket_updated', updated);
    if (dto.assignedTo) {
      this.emitToUser(tenantId, dto.assignedTo, 'ticket_assigned', updated);
    }
    if (dto.status && dto.status !== ticket.status) {
      this.logger.log(`Ticket ${ticket.id} transitioned from ${ticket.status} to ${updated.status} by user ${actor.userId}`);
    }

    return updated;
  }

  async requestPresignedUpload(ticketId: string, tenantId: string, actor: AuthActor, dto: RequestPresignDto) {
    await this.assertTicketAccess(ticketId, tenantId, actor);
    this.assertAllowedAttachment(dto.mimeType, dto.size);

    const safeFileName = this.sanitizeFileName(dto.fileName);
    const objectKey = `tenants/${tenantId}/support/tickets/${ticketId}/${uuidv4()}-${safeFileName}`;
    const { uploadUrl, expiresIn } = await this.storage.getUploadUrlForKey({
      objectKey,
      contentType: dto.mimeType,
    });
    return { url: uploadUrl, objectKey, fileKey: objectKey, expiresIn };
  }

  async confirmUpload(ticketId: string, tenantId: string, actor: AuthActor, dto: ConfirmUploadDto) {
    await this.assertTicketAccess(ticketId, tenantId, actor);
    this.assertAllowedAttachment(dto.mimeType, dto.size);

    const expectedPrefix = `tenants/${tenantId}/support/tickets/${ticketId}/`;
    if (!dto.fileKey.startsWith(expectedPrefix)) {
      throw new ForbiddenException('Attachment file key does not belong to this ticket and tenant');
    }

    if (dto.messageId) {
      const message = await this.prisma.ticketMessage.findFirst({
        where: { id: dto.messageId, tenantId, ticketId },
        select: { id: true },
      });
      if (!message) throw new NotFoundException('Ticket message not found');
    }

    const exists = await this.storage.fileExists(dto.fileKey);
    if (!exists) throw new NotFoundException('Uploaded file not found in storage');

    return this.prisma.ticketAttachment.create({
      data: {
        tenantId,
        ticketId,
        messageId: dto.messageId,
        fileName: dto.fileName,
        fileKey: dto.fileKey,
        mimeType: dto.mimeType,
        size: dto.size,
      },
    });
  }

  async markMessagesRead(ticketId: string, tenantId: string, actor: AuthActor) {
    await this.assertTicketAccess(ticketId, tenantId, actor);
    return { success: true };
  }

  async getMetrics(tenantId: string) {
    const now = new Date();
    const [
      openTickets,
      slaBreaches,
      ticketsByCategoryRows,
      ticketsByPriorityRows,
      firstStaffMessages,
      resolvedTickets,
      _ticketAggregate,
    ] = await Promise.all([
      this.prisma.supportTicket.count({
        where: { tenantId, status: { in: [TicketStatus.OPEN, TicketStatus.IN_PROGRESS] } },
      }),
      this.prisma.supportTicket.count({
        where: {
          tenantId,
          resolutionDueAt: { lt: now },
          status: { notIn: [TicketStatus.RESOLVED, TicketStatus.CLOSED] },
        },
      }),
      this.prisma.supportTicket.groupBy({
        by: ['category'],
        where: { tenantId },
        _count: { _all: true },
      }),
      this.prisma.supportTicket.groupBy({
        by: ['priority'],
        where: { tenantId },
        _count: { _all: true },
      }),
      this.prisma.ticketMessage.findMany({
        where: { tenantId, senderRole: { in: STAFF_ROLES } },
        select: { ticketId: true, createdAt: true, ticket: { select: { createdAt: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.supportTicket.findMany({
        where: { tenantId, status: { in: [TicketStatus.RESOLVED, TicketStatus.CLOSED] } },
        select: { createdAt: true, updatedAt: true },
      }),
      this.prisma.supportTicket.aggregate({ where: { tenantId }, _count: { _all: true } }),
    ]);

    const firstResponsesByTicket = new Map<string, number>();
    for (const message of firstStaffMessages) {
      if (firstResponsesByTicket.has(message.ticketId)) continue;
      firstResponsesByTicket.set(
        message.ticketId,
        this.diffMinutes(message.ticket.createdAt, message.createdAt),
      );
    }

    return {
      openTickets,
      slaBreaches,
      ticketsByCategory: this.countRowsToRecord(ticketsByCategoryRows, 'category'),
      ticketsByPriority: this.countRowsToRecord(ticketsByPriorityRows, 'priority'),
      averageFirstResponseTime: this.average([...firstResponsesByTicket.values()]),
      averageResolutionTime: this.average(
        resolvedTickets.map((ticket) => this.diffMinutes(ticket.createdAt, ticket.updatedAt)),
      ),
    };
  }

  private assertAllowedAttachment(mimeType: string, size: number) {
    if (!SUPPORT_ATTACHMENT_MIME_TYPES.has(mimeType)) {
      throw new BadRequestException(`Unsupported attachment type "${mimeType}"`);
    }
    if (!Number.isInteger(size) || size <= 0 || size > SUPPORT_ATTACHMENT_MAX_BYTES) {
      throw new BadRequestException('Attachment size must be between 1 byte and 10MB');
    }
  }

  private sanitizeFileName(fileName: string) {
    const baseName = fileName.split(/[\\/]/).pop()?.trim() || 'attachment';
    return baseName.replace(/[^A-Za-z0-9._-]/g, '_');
  }

  private diffMinutes(start: Date, end: Date) {
    return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  }

  private average(values: number[]) {
    if (!values.length) return 0;
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  }

  private countRowsToRecord<T extends string>(rows: Array<Record<T, string> & { _count: { _all: number } }>, key: T) {
    return rows.reduce<Record<string, number>>((acc, row) => {
      acc[row[key]] = row._count._all;
      return acc;
    }, {});
  }
  private async enqueueSupportNotification(
    jobType: SupportNotificationJobType,
    payload: SupportNotificationJobPayload,
  ) {
    await this.supportNotificationsQueue.add(jobType, payload, SUPPORT_NOTIFICATION_JOB_OPTIONS);
  }

  private resolveStatusNotificationJobType(status: TicketStatus): SupportNotificationJobType | null {
    if (status === TicketStatus.RESOLVED) return 'TICKET_RESOLVED';
    if (status === TicketStatus.CLOSED) return 'TICKET_CLOSED';
    return null;
  }

  private emitToTicketRoom(tenantId: string, ticketId: string, event: string, payload: unknown) {
    const gateway = this.getRealtimeGateway();
    gateway?.server?.to(`${tenantId}:ticket:${ticketId}`)?.emit(event, payload);
  }

  private emitToUser(tenantId: string, userId: string, event: string, payload: unknown) {
    this.getRealtimeGateway()?.emitToUser(tenantId, userId, event, payload);
  }

  private getRealtimeGateway(): any {
    try {
      // Lazy lookup avoids a hard constructor cycle: SupportRealtimeGateway already injects SupportService.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { SupportRealtimeGateway } = require('./support-realtime.gateway');
      return this.moduleRef.get(SupportRealtimeGateway, { strict: false });
    } catch {
      return null;
    }
  }
  private assertAllowedTransition(currentStatus: TicketStatus, nextStatus: TicketStatus) {
    if (!ALLOWED_TRANSITIONS[currentStatus].includes(nextStatus)) {
      throw new BadRequestException(`Invalid support ticket status transition: ${currentStatus} -> ${nextStatus}`);
    }
  }

  private normalizePositiveInt(value: number | string | undefined, fallback: number) {
    const parsed = typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private async requireActorMember(tenantId: string, userId: string) {
    try {
      return await this.prisma.member.findFirstOrThrow({
        where: { tenantId, userId, isActive: true },
        select: { id: true },
      });
    } catch {
      throw new ForbiddenException('Only active members can use member support tickets');
    }
  }
}








