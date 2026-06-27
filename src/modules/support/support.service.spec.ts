import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TicketCategory, TicketPriority, TicketStatus, UserRole } from '@prisma/client';
import { SupportService } from './support.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StorageService } from '../storage/storage.service';
import type { AuthActor } from './support-ticket.types';

describe('SupportService', () => {
  const tenantId = 'tenant-1';
  const memberOneUserId = 'user-member-1';
  const memberTwoUserId = 'user-member-2';
  const staffUserId = 'user-staff-1';

  function actor(id: string, role: UserRole = UserRole.MEMBER): AuthActor {
    return { userId: id, role };
  }

  function buildTicket(ticketOwnerUserId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: 'ticket-a',
      tenantId,
      memberId: 'member-1',
      subject: 'Loan repayment query',
      description: 'Please check my repayment.',
      status: TicketStatus.OPEN,
      priority: TicketPriority.MEDIUM,
      category: TicketCategory.LOAN_QUERY,
      relatedLoanId: null,
      relatedTxId: null,
      assignedTo: null,
      incidentId: null,
      resolutionDueAt: null,
      createdAt: new Date('2026-06-18T09:00:00.000Z'),
      updatedAt: new Date('2026-06-18T09:00:00.000Z'),
      member: {
        id: 'member-1',
        tenantId,
        userId: ticketOwnerUserId,
        memberNumber: 'M-001',
        user: {
          firstName: 'Amina',
          lastName: 'Otieno',
          email: 'amina@example.com',
          phoneNumber: '254700000001',
        },
      },
      messages: [],
      ...overrides,
    };
  }

  function buildService(ticketOwnerUserId = memberOneUserId, ticketOverrides: Record<string, unknown> = {}) {
    const ticket = buildTicket(ticketOwnerUserId, ticketOverrides);
    const prisma: any = {
      member: {
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'member-1' }),
      },
      loan: {
        findFirst: jest.fn(),
      },
      mpesaTransaction: {
        findFirst: jest.fn(),
      },
      supportTicket: {
        findUnique: jest.fn().mockResolvedValue(ticket),
        create: jest.fn().mockResolvedValue(ticket),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...ticket, ...data })),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 } }),
      },
      ticketMessage: {
        create: jest.fn().mockResolvedValue({ id: 'message-1', ticketId: ticket.id }),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      ticketAttachment: {
        create: jest.fn().mockResolvedValue({
          id: 'attachment-1',
          tenantId,
          ticketId: ticket.id,
          messageId: null,
          fileName: 'receipt.pdf',
          fileKey: 'tenants/tenant-1/support/tickets/ticket-a/upload-receipt.pdf',
          mimeType: 'application/pdf',
          size: 1024,
        }),
      },
    };
    prisma.$transaction = jest.fn((callback: (tx: unknown) => unknown) => callback(prisma));

    const storage = {
      getUploadUrlForKey: jest.fn(),
      fileExists: jest.fn().mockResolvedValue(true),
    };
    const room = { emit: jest.fn() };
    const gateway = {
      emitToUser: jest.fn(),
      server: { to: jest.fn().mockReturnValue(room) },
    };
    const moduleRef = { get: jest.fn().mockReturnValue(gateway) };
    const supportNotificationsQueue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    return {
      prisma,
      storage,
      gateway,
      room,
      moduleRef,
      supportNotificationsQueue,
      service: new SupportService(
        prisma as unknown as PrismaService,
        storage as unknown as StorageService,
        supportNotificationsQueue as any,
        moduleRef as any,
      ),
    };
  }

  it('prevents one member from reading another member ticket by id', async () => {
    const { prisma, service } = buildService(memberOneUserId);

    await expect(
      service.getTicket('ticket-a', tenantId, actor(memberTwoUserId)),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.supportTicket.findUnique).toHaveBeenCalledWith({
      where: { id: 'ticket-a', tenantId },
      include: {
        member: {
          include: { user: { select: { firstName: true, lastName: true, email: true, phoneNumber: true } } },
        },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
  });

  it('allows the owning member to read their own ticket', async () => {
    const { prisma, service } = buildService(memberOneUserId);

    await expect(
      service.getTicket('ticket-a', tenantId, actor(memberOneUserId)),
    ).resolves.toMatchObject({ id: 'ticket-a' });

    expect(prisma.supportTicket.findUnique).toHaveBeenCalledWith({
      where: { id: 'ticket-a', tenantId },
      include: {
        member: {
          include: { user: { select: { firstName: true, lastName: true, email: true, phoneNumber: true } } },
        },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
  });

  describe('async notifications and realtime events', () => {
    it('enqueues TICKET_CREATED and emits ticket_created after creating a ticket', async () => {
      const { gateway, service, supportNotificationsQueue } = buildService(memberOneUserId);

      await service.createTicket(
        {
          subject: 'Loan issue',
          description: 'Please check this loan repayment issue.',
          category: TicketCategory.LOAN_QUERY,
          priority: TicketPriority.HIGH,
        },
        tenantId,
        actor(memberOneUserId),
      );

      expect(supportNotificationsQueue.add).toHaveBeenCalledWith(
        'TICKET_CREATED',
        expect.objectContaining({
          ticketId: 'ticket-a',
          tenantId,
          memberId: 'member-1',
          category: TicketCategory.LOAN_QUERY,
          priority: TicketPriority.MEDIUM,
        }),
        expect.objectContaining({ attempts: 3 }),
      );
      expect(gateway.emitToUser).toHaveBeenCalledWith(
        tenantId,
        memberOneUserId,
        'ticket_created',
        expect.objectContaining({ id: 'ticket-a' }),
      );
    });

    it('enqueues TICKET_REPLIED and emits new_message after adding a message', async () => {
      const { room, service, supportNotificationsQueue } = buildService(memberOneUserId, {
        status: TicketStatus.WAITING_ON_MEMBER,
      });

      await service.addMessage(
        'ticket-a',
        { content: 'Please see my latest update.' },
        tenantId,
        actor(memberOneUserId),
      );

      expect(supportNotificationsQueue.add).toHaveBeenCalledWith(
        'TICKET_REPLIED',
        expect.objectContaining({
          ticketId: 'ticket-a',
          tenantId,
          senderId: memberOneUserId,
          senderRole: UserRole.MEMBER,
          isReopen: false,
        }),
        expect.objectContaining({ attempts: 3 }),
      );
      expect(room.emit).toHaveBeenCalledWith('new_message', expect.objectContaining({ id: 'message-1' }));
    });

    it('enqueues TICKET_RESOLVED and emits ticket_updated after resolving a ticket', async () => {
      const { room, service, supportNotificationsQueue } = buildService(memberOneUserId, {
        status: TicketStatus.IN_PROGRESS,
      });

      await service.updateTicket(
        'ticket-a',
        { status: TicketStatus.RESOLVED, resolutionNote: 'Confirmed repayment allocation.' },
        tenantId,
        actor(staffUserId, UserRole.LOAN_OFFICER),
      );

      expect(supportNotificationsQueue.add).toHaveBeenCalledWith(
        'TICKET_RESOLVED',
        expect.objectContaining({
          ticketId: 'ticket-a',
          tenantId,
          previousStatus: TicketStatus.IN_PROGRESS,
          newStatus: TicketStatus.RESOLVED,
          resolutionNote: 'Confirmed repayment allocation.',
        }),
        expect.objectContaining({ attempts: 3 }),
      );
      expect(room.emit).toHaveBeenCalledWith('ticket_updated', expect.objectContaining({ status: TicketStatus.RESOLVED }));
    });
  });
  describe('attachments', () => {
    it('confirms an uploaded attachment and persists the ticket attachment row', async () => {
      const { prisma, service, storage } = buildService(memberOneUserId);
      const fileKey = `tenants/${tenantId}/support/tickets/ticket-a/upload-receipt.pdf`;

      await expect(
        service.confirmUpload(
          'ticket-a',
          tenantId,
          actor(memberOneUserId),
          {
            fileKey,
            fileName: 'receipt.pdf',
            mimeType: 'application/pdf',
            size: 1024,
          },
        ),
      ).resolves.toMatchObject({ id: 'attachment-1', fileKey });

      expect(storage.fileExists).toHaveBeenCalledWith(fileKey);
      expect(prisma.ticketAttachment.create).toHaveBeenCalledWith({
        data: {
          tenantId,
          ticketId: 'ticket-a',
          messageId: undefined,
          fileName: 'receipt.pdf',
          fileKey,
          mimeType: 'application/pdf',
          size: 1024,
        },
      });
    });
  });

  describe('metrics', () => {
    it('returns enhanced support queue metrics', async () => {
      const { prisma, service } = buildService(memberOneUserId);
      prisma.supportTicket.count
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(1);
      prisma.supportTicket.groupBy
        .mockResolvedValueOnce([{ category: TicketCategory.LOAN_QUERY, _count: { _all: 2 } }])
        .mockResolvedValueOnce([{ priority: TicketPriority.HIGH, _count: { _all: 1 } }]);
      prisma.ticketMessage.findMany.mockResolvedValueOnce([
        {
          ticketId: 'ticket-a',
          createdAt: new Date('2026-06-18T10:00:00.000Z'),
          ticket: { createdAt: new Date('2026-06-18T09:00:00.000Z') },
        },
      ]);
      prisma.supportTicket.findMany.mockResolvedValueOnce([
        {
          createdAt: new Date('2026-06-18T09:00:00.000Z'),
          updatedAt: new Date('2026-06-18T11:00:00.000Z'),
        },
      ]);
      prisma.supportTicket.aggregate.mockResolvedValueOnce({ _count: { _all: 4 } });

      await expect(service.getMetrics(tenantId)).resolves.toEqual({
        openTickets: 3,
        slaBreaches: 1,
        ticketsByCategory: { [TicketCategory.LOAN_QUERY]: 2 },
        ticketsByPriority: { [TicketPriority.HIGH]: 1 },
        averageFirstResponseTime: 60,
        averageResolutionTime: 120,
      });

      expect(prisma.supportTicket.count).toHaveBeenCalledWith({
        where: { tenantId, status: { in: [TicketStatus.OPEN, TicketStatus.IN_PROGRESS] } },
      });
      expect(prisma.supportTicket.aggregate).toHaveBeenCalledWith({
        where: { tenantId },
        _count: { _all: true },
      });
    });
  });
  describe('ticket state machine', () => {
    it('allows a valid OPEN -> IN_PROGRESS transition', async () => {
      const { prisma, service } = buildService(memberOneUserId, { status: TicketStatus.OPEN });

      await expect(
        service.updateTicket(
          'ticket-a',
          { status: TicketStatus.IN_PROGRESS },
          tenantId,
          actor(staffUserId, UserRole.LOAN_OFFICER),
        ),
      ).resolves.toMatchObject({ id: 'ticket-a', status: TicketStatus.IN_PROGRESS });

      expect(prisma.supportTicket.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'ticket-a' },
        data: expect.objectContaining({ status: TicketStatus.IN_PROGRESS }),
      }));
    });

    it('rejects an invalid OPEN -> RESOLVED transition', async () => {
      const { service } = buildService(memberOneUserId, { status: TicketStatus.OPEN });

      await expect(
        service.updateTicket(
          'ticket-a',
          { status: TicketStatus.RESOLVED, resolutionNote: 'Done.' },
          tenantId,
          actor(staffUserId, UserRole.LOAN_OFFICER),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('requires a resolution note when resolving a ticket', async () => {
      const { service } = buildService(memberOneUserId, { status: TicketStatus.IN_PROGRESS });

      await expect(
        service.updateTicket(
          'ticket-a',
          { status: TicketStatus.RESOLVED },
          tenantId,
          actor(staffUserId, UserRole.LOAN_OFFICER),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('SACCO context validation', () => {
    it('throws NotFoundException when a related loan does not exist', async () => {
      const { prisma, service } = buildService(memberOneUserId);
      prisma.loan.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.createTicket(
          {
            subject: 'Loan issue',
            description: 'Please check this loan repayment issue.',
            category: TicketCategory.LOAN_QUERY,
            relatedLoanId: 'loan-missing',
          },
          tenantId,
          actor(memberOneUserId),
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when a related loan belongs to another tenant', async () => {
      const { prisma, service } = buildService(memberOneUserId);
      prisma.loan.findFirst.mockResolvedValueOnce({
        id: 'loan-other-tenant',
        tenantId: 'tenant-2',
        memberId: 'member-1',
      });

      await expect(
        service.createTicket(
          {
            subject: 'Loan issue',
            description: 'Please check this loan repayment issue.',
            category: TicketCategory.LOAN_QUERY,
            relatedLoanId: 'loan-other-tenant',
          },
          tenantId,
          actor(memberOneUserId),
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});







