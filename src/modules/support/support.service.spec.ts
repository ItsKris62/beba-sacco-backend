import { NotFoundException } from '@nestjs/common';
import { TicketPriority, TicketStatus, UserRole } from '@prisma/client';
import { SupportService } from './support.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

describe('SupportService', () => {
  const tenantId = 'tenant-1';
  const memberOneUserId = 'user-member-1';
  const memberTwoUserId = 'user-member-2';

  function actor(id: string): AuthenticatedUser {
    return { id, tenantId, role: UserRole.MEMBER } as AuthenticatedUser;
  }

  function buildService(ticketOwnerUserId: string) {
    const prisma = {
      member: {
        findFirst: jest.fn().mockResolvedValue({ id: 'member-1' }),
      },
      supportTicket: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { memberId?: string } }) =>
          where.memberId === 'member-1'
            ? Promise.resolve({
                id: 'ticket-a',
                tenantId,
                memberId: 'member-1',
                subject: 'Loan repayment query',
                description: 'Please check my repayment.',
                status: TicketStatus.OPEN,
                priority: TicketPriority.MEDIUM,
                member: { id: 'member-1', memberNumber: 'M-001', userId: ticketOwnerUserId },
                messages: [],
              })
            : Promise.resolve(null),
        ),
      },
    };

    return {
      prisma,
      service: new SupportService(prisma as unknown as PrismaService),
    };
  }

  it('prevents one member from reading another member ticket by id', async () => {
    const { prisma, service } = buildService(memberOneUserId);
    prisma.member.findFirst.mockResolvedValueOnce({ id: 'member-2' });

    await expect(
      service.getTicket('ticket-a', tenantId, actor(memberTwoUserId)),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.supportTicket.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ticket-a', tenantId, memberId: 'member-2' },
      }),
    );
  });

  it('allows the owning member to read their own ticket', async () => {
    const { service } = buildService(memberOneUserId);

    await expect(
      service.getTicket('ticket-a', tenantId, actor(memberOneUserId)),
    ).resolves.toMatchObject({ id: 'ticket-a' });
  });
});
