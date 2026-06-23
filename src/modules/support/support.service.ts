import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TicketCategory, TicketPriority, TicketStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AuthActor } from './support-ticket.types';
import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';
import { CreateTicketMessageDto } from './dto/create-ticket-message.dto';
import { UpdateSupportTicketDto } from './dto/update-support-ticket.dto';
import { RequestPresignDto } from './dto/support.dto';

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService 
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

    return this.prisma.supportTicket.create({
      data: {
        tenantId,
        memberId: member.id,
        subject: dto.subject,
        description: dto.description,
        priority: dto.priority || 'MEDIUM',
        category: dto.category,
        relatedLoanId: dto.relatedLoanId,
        relatedTxId: dto.relatedTxId,
        status: 'OPEN',
        messages: {
          create: {
            senderId: actor.userId,
            senderRole: actor.role,
            content: dto.description,
            attachments: [],
          },
        },
      },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
  }

  async listTickets(
    tenantId: string,
    actor: AuthActor,
    filters: {
      status?: string;
      priority?: TicketPriority;
      category?: TicketCategory;
      search?: string;
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

    return this.prisma.supportTicket.findMany({
      where: {
        tenantId,
        ...(member ? { memberId: member.id } : {}),
        ...(statuses?.length === 1 ? { status: statuses[0] } : {}),
        ...(statuses && statuses.length > 1 ? { status: { in: statuses } } : {}),
        ...(filters.priority ? { priority: filters.priority } : {}),
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.search
          ? {
              OR: [
                { subject: { contains: filters.search, mode: 'insensitive' } },
                { description: { contains: filters.search, mode: 'insensitive' } },
                { member: { memberNumber: { contains: filters.search, mode: 'insensitive' } } },
                { member: { user: { firstName: { contains: filters.search, mode: 'insensitive' } } } },
                { member: { user: { lastName: { contains: filters.search, mode: 'insensitive' } } } },
                { member: { user: { email: { contains: filters.search, mode: 'insensitive' } } } },
              ],
            }
          : {}),
      },
      include: {
        member: {
          select: {
            id: true,
            memberNumber: true,
            user: { select: { firstName: true, lastName: true, email: true, phoneNumber: true } },
          },
        },
        messages: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: { updatedAt: 'desc' },
    });
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

    return this.prisma.$transaction(async (tx) => {
      const message = await tx.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          senderId: actor.userId,
          senderRole: actor.role,
          content: dto.content,
          attachments: dto.attachments ?? [],
        },
      });

      const nextStatus = actor.role === UserRole.MEMBER ? TicketStatus.OPEN : TicketStatus.WAITING_ON_MEMBER;

      await tx.supportTicket.update({
        where: { id: ticket.id },
        data: { status: nextStatus },
      });

      return message;
    });
  }

  async updateTicket(id: string, dto: UpdateSupportTicketDto, tenantId: string, actor: AuthActor) {
    const ticket = await this.assertTicketAccess(id, tenantId, actor);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.supportTicket.update({
        where: { id: ticket.id },
        data: {
          status: dto.status,
          priority: dto.priority,
          assignedTo: dto.assignedTo,
        },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      });

      if (dto.note) {
        await tx.ticketMessage.create({
          data: {
            ticketId: ticket.id,
            senderId: actor.userId,
            senderRole: actor.role,
            content: dto.note,
            attachments: [],
          },
        });
      }
      return updated;
    });
  }

  async requestPresignedUpload(ticketId: string, tenantId: string, actor: AuthActor, dto: RequestPresignDto) {
    await this.assertTicketAccess(ticketId, tenantId, actor);
    // Uses storage.service generatePresignedUrl
    const objectKey = `tenant-${tenantId}/tickets/${ticketId}/${Date.now()}-${dto.filename}`;
    const { uploadUrl, expiresIn } = await this.storage.getUploadUrlForKey({
      objectKey,
      contentType: dto.contentType,
    });
    return { url: uploadUrl, objectKey, expiresIn };
  }

  async markMessagesRead(ticketId: string, tenantId: string, actor: AuthActor) {
    await this.assertTicketAccess(ticketId, tenantId, actor);
    return { success: true };
  }

  async getMetrics(tenantId: string) {
    const [openTickets, slaBreaches] = await Promise.all([
      this.prisma.supportTicket.count({ where: { tenantId, status: 'OPEN' } }),
      this.prisma.supportTicket.count({ where: { tenantId, priority: 'CRITICAL', status: { not: 'CLOSED' } } }),
    ]);
    return { openTickets, slaBreaches, avgResolutionTimeHours: 24 }; // Mock computation for brevity
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


