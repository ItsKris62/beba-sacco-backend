import { Decimal } from 'decimal.js';
import { TransactionType, UserRole } from '@prisma/client';
import { AdminController } from '../admin.controller';
import { AdminService } from '../admin.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { RedisService } from '../../../common/services/redis.service';

describe('Admin transaction stats', () => {
  const prisma = {
    transaction: {
      groupBy: jest.fn(),
    },
  };

  const redis = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  };

  const audit = {
    create: jest.fn(),
  };

  const emailQueue = {
    add: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('aggregates completed transaction inflows and outflows across the full filtered result set', async () => {
    prisma.transaction.groupBy.mockResolvedValueOnce([
      { type: TransactionType.DEPOSIT, _sum: { amount: new Decimal(1000) } },
      { type: TransactionType.LOAN_DISBURSEMENT, _sum: { amount: new Decimal(5000) } },
      { type: TransactionType.WITHDRAWAL, _sum: { amount: new Decimal(1200) } },
      { type: TransactionType.FEE_CHARGE, _sum: { amount: new Decimal(300) } },
    ]);

    const service = new AdminService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      redis as unknown as RedisService,
      emailQueue as never,
    );

    const stats = await service.getTransactionStats('tenant-1', {
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-30T23:59:59Z',
      search: 'ACC-FOSA',
    });

    expect(stats).toEqual({
      pageVolume: 7500,
      inflows: 6000,
      outflows: 1500,
      netFlow: 4500,
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-06-30T23:59:59.000Z',
    });
    expect(prisma.transaction.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['type'],
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          status: 'COMPLETED',
        }),
        _sum: { amount: true },
      }),
    );
  });

  it('routes SUPER_ADMIN transaction stats without tenant scoping', async () => {
    const service = new AdminService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      redis as unknown as RedisService,
      emailQueue as never,
    );
    const controller = new AdminController(service);
    const spy = jest.spyOn(service, 'getTransactionStats').mockResolvedValueOnce({
      pageVolume: 0,
      inflows: 0,
      outflows: 0,
      netFlow: 0,
      periodStart: null,
      periodEnd: null,
    });

    await controller.getTransactionStats(
      { id: 'tenant-1' } as never,
      { id: 'user-1', role: UserRole.SUPER_ADMIN } as never,
      {},
    );

    expect(spy).toHaveBeenCalledWith(undefined, {});
  });
});
