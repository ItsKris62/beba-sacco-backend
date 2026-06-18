import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TicketStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';
import { CreateTicketMessageDto } from './dto/create-ticket-message.dto';
import { UpdateSupportTicketDto } from './dto/update-support-ticket.dto';

@Injectable()
export class SupportService {
  constructor(private readonly prisma: PrismaService) {}

  async createTicket(dto: CreateSupportTicketDto, tenantId: string, actor: AuthenticatedUser) {
    const member = await this.requireActorMember(tenantId, actor.id);

    return this.prisma.supportTicket.create({
      data: {
        tenantId,
        memberId: member.id,
        subject: dto.subject,
        description: dto.description,
        priority: dto.priority,
        category: dto.category,
        relatedLoanId: dto.relatedLoanId,
        relatedTxId: dto.relatedTxId,
        messages: {
          create: {
            senderId: actor.id,
            senderRole: actor.role,
            content: dto.description,
            attachments: [],
          },
        },
      },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
  }

  async listTickets(tenantId: string, actor: AuthenticatedUser, status?: TicketStatus) {
    const member = actor.role === UserRole.MEMBER
      ? await this.requireActorMember(tenantId, actor.id)
      : null;

    return this.prisma.supportTicket.findMany({
      where: {
        tenantId,
        ...(member ? { memberId: member.id } : {}),
        ...(status ? { status } : {}),
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

  async getTicket(id: string, tenantId: string, actor: AuthenticatedUser) {
    const member = actor.role === UserRole.MEMBER
      ? await this.requireActorMember(tenantId, actor.id)
      : null;

    const ticket = await this.prisma.supportTicket.findFirst({
      where: {
        id,
        tenantId,
        ...(member ? { memberId: member.id } : {}),
      },
      include: {
        member: { select: { id: true, memberNumber: true, userId: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!ticket) throw new NotFoundException('Support ticket not found');

    return ticket;
  }

  async addMessage(
    id: string,
    dto: CreateTicketMessageDto,
    tenantId: string,
    actor: AuthenticatedUser,
  ) {
    const ticket = await this.getTicket(id, tenantId, actor);

    return this.prisma.$transaction(async (tx) => {
      const message = await tx.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          senderId: actor.id,
          senderRole: actor.role,
          content: dto.content,
          attachments: dto.attachments ?? [],
        },
      });

      const nextStatus =
        actor.role === UserRole.MEMBER ? TicketStatus.OPEN : TicketStatus.WAITING_ON_MEMBER;

      await tx.supportTicket.update({
        where: { id: ticket.id },
        data: { status: nextStatus },
      });

      return message;
    });
  }

  async updateTicket(id: string, dto: UpdateSupportTicketDto, tenantId: string, actor: AuthenticatedUser) {
    const ticket = await this.getTicket(id, tenantId, actor);

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
            senderId: actor.id,
            senderRole: actor.role,
            content: dto.note,
            attachments: [],
          },
        });
      }

      return updated;
    });
  }

  private async requireActorMember(tenantId: string, userId: string) {
    const member = await this.prisma.member.findFirst({
      where: { tenantId, userId, isActive: true },
      select: { id: true },
    });
    if (!member) throw new ForbiddenException('Only active members can use member support tickets');
    return member;
  }
}
