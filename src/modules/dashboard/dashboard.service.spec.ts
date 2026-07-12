import { BadRequestException } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService, MIN_GUARANTEES_FOR_CORRELATION } from './dashboard.service';
import { DashboardDrilldownSource } from './dto/dashboard-drilldown.dto';

describe('DashboardService analytics drill-downs', () => {
  const redis = { get: jest.fn(), set: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    return new DashboardService(prisma as never, redis as never);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ranks guarantor correlations above the named sample threshold', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          memberId: 'member-high',
          memberNumber: 'M001',
          firstName: 'High',
          lastName: 'Signal',
          totalGuarantees: BigInt(MIN_GUARANTEES_FOR_CORRELATION),
          defaultedGuarantees: BigInt(2),
          totalGuaranteedAmount: '10000',
          recoveredAmount: '1500',
          activeGuarantees: BigInt(3),
          defaultedActiveGuarantees: BigInt(1),
          closedGuarantees: BigInt(2),
        },
        {
          memberId: 'member-low',
          memberNumber: 'M002',
          firstName: 'Small',
          lastName: 'Sample',
          totalGuarantees: BigInt(MIN_GUARANTEES_FOR_CORRELATION - 1),
          defaultedGuarantees: BigInt(4),
          totalGuaranteedAmount: '8000',
          recoveredAmount: '0',
          activeGuarantees: BigInt(4),
          defaultedActiveGuarantees: BigInt(4),
          closedGuarantees: BigInt(0),
        },
      ]),
    };

    const result = await makeService(prisma).getGuarantorCorrelation('tenant-1');

    expect(result.minGuaranteesForCorrelation).toBe(MIN_GUARANTEES_FOR_CORRELATION);
    expect(result.ranked).toHaveLength(1);
    expect(result.ranked[0]).toMatchObject({
      memberId: 'member-high',
      totalGuarantees: MIN_GUARANTEES_FOR_CORRELATION,
      defaultedGuarantees: 2,
      defaultCorrelationRate: 40,
    });
    expect(result.belowThreshold).toBeUndefined();
    expect(result.excludedBelowThreshold).toBe(1);
  });

  it('caps transaction drill-down page size and scopes by tenant', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const prisma = {
      transaction: { findMany, count },
      $transaction: jest.fn((ops: Array<Promise<unknown>>) => Promise.all(ops)),
    };

    await makeService(prisma).getDrilldown('tenant-1', {
      source: DashboardDrilldownSource.TRANSACTION,
      page: 1,
      limit: 250,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1' },
        take: 100,
      }),
    );
    expect(count).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1' } });
  });

  it('filters journal drill-downs by posted revenue credit postings', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const prisma = {
      journalEntry: { findMany, count },
      $transaction: jest.fn((ops: Array<Promise<unknown>>) => Promise.all(ops)),
    };

    await makeService(prisma).getDrilldown('tenant-1', {
      source: DashboardDrilldownSource.JOURNAL,
      creditAccountType: 'REVENUE' as never,
    });

    const expectedWhere = {
      tenantId: 'tenant-1',
      status: 'POSTED',
      postings: { some: { creditAccount: { type: 'REVENUE' } } },
    };
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expectedWhere }));
    expect(count).toHaveBeenCalledWith({ where: expectedWhere });
  });
});

describe('DashboardController analytics tenant context', () => {
  it('rejects new analytics endpoints without an explicit tenant context', async () => {
    const controller = new DashboardController({ getDrilldown: jest.fn() } as never);

    await expect(
      controller.getDrilldown({} as never, { source: DashboardDrilldownSource.LOAN }),
    ).rejects.toThrow(BadRequestException);
  });
});
