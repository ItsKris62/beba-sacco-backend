import { Decimal } from 'decimal.js';
import { AdminService } from '../admin.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { RedisService } from '../../../common/services/redis.service';

// ─── Prisma mock ────────────────────────────────────────────────────────────
//
// computeDashboardStats() passes an array of already-invoked Prisma model
// calls into $transaction([...]) — mirror that by mocking each model method
// individually and letting $transaction just Promise.all() them, the same
// way the real client resolves an array-form transaction.
//
// prisma.loan.aggregate is called 4 times, in this order:
//   [0] activeLoansAgg   (status=ACTIVE, _sum.outstandingBalance, _count)
//   [1] parLoansAgg      (status=ACTIVE + staging WATCHLIST/NPL, _sum.outstandingBalance)
//   [2] disbursedThisMonth (_sum.principalAmount, _count)
//   [3] disbursedOverall   (_sum.principalAmount, _count)
// All four metrics are computed via DB-side aggregate() — never findMany()+JS
// reduce() — so this dashboard stays fast at 100k+ rows.

function buildPrisma() {
  return {
    member: { count: jest.fn().mockResolvedValue(0) },
    user: { count: jest.fn().mockResolvedValue(0) },
    loan: {
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { outstandingBalance: null, principalAmount: null }, _count: 0 }),
    },
    account: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { balance: null }, _avg: { balance: null }, _count: 0 }),
    },
    mpesaTransaction: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null }, _count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

describe('AdminService.getDashboardStats()', () => {
  const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
  const audit = { create: jest.fn() };
  const cache = { invalidateTenantDashboard: jest.fn() };
  const emailQueue = { add: jest.fn() };
  const eventEmitter = { emit: jest.fn() };

  function buildService(prisma: ReturnType<typeof buildPrisma>): AdminService {
    return new AdminService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      redis as unknown as RedisService,
      cache as never,
      emailQueue as never,
      eventEmitter as never,
      { release: jest.fn(), exists: jest.fn(), checkAndReserve: jest.fn(), complete: jest.fn() } as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    redis.get.mockResolvedValue(null);
  });

  // ── Aggregation correctness (PAR>30, disbursements) ────────────────────────

  it('computes portfolioAtRisk30d from a DB-side aggregate over WATCHLIST/NPL-staged active loans', async () => {
    const prisma = buildPrisma();
    prisma.loan.aggregate
      .mockResolvedValueOnce({ _sum: { outstandingBalance: new Decimal('100000.0000') }, _count: 2 }) // activeLoansAgg
      .mockResolvedValueOnce({ _sum: { outstandingBalance: new Decimal('40000.0000') } }); // parLoansAgg

    const stats = await buildService(prisma).getDashboardStats('tenant-1');

    expect(stats.loans.portfolioAtRisk30d).toEqual({
      outstandingAmount: 40000,
      percentOfActivePortfolio: 40,
    });
    expect(stats.loans.totalOutstandingAmount).toBe(100000);
    expect(stats.loans.active).toBe(2);
  });

  it('returns 0% PAR when there is no active outstanding portfolio', async () => {
    const prisma = buildPrisma();
    prisma.loan.aggregate
      .mockResolvedValueOnce({ _sum: { outstandingBalance: null }, _count: 0 })
      .mockResolvedValueOnce({ _sum: { outstandingBalance: null } });

    const stats = await buildService(prisma).getDashboardStats('tenant-1');

    expect(stats.loans.portfolioAtRisk30d).toEqual({
      outstandingAmount: 0,
      percentOfActivePortfolio: 0,
    });
  });

  it('never calls loan.findMany() for the active/PAR aggregates (DB-side sum only)', async () => {
    const prisma = buildPrisma();
    await buildService(prisma).getDashboardStats('tenant-1');

    expect((prisma.loan as Record<string, unknown>).findMany).toBeUndefined();
    expect(prisma.loan.aggregate).toHaveBeenCalled();
  });

  it('reports disbursement totals for this month and overall separately', async () => {
    const prisma = buildPrisma();
    prisma.loan.aggregate
      .mockResolvedValueOnce({ _sum: { outstandingBalance: null }, _count: 0 }) // activeLoansAgg
      .mockResolvedValueOnce({ _sum: { outstandingBalance: null } }) // parLoansAgg
      .mockResolvedValueOnce({ _sum: { principalAmount: new Decimal('250000.0000') }, _count: 3 }) // disbursedThisMonth
      .mockResolvedValueOnce({ _sum: { principalAmount: new Decimal('1250000.0000') }, _count: 20 }); // disbursedOverall

    const stats = await buildService(prisma).getDashboardStats('tenant-1');

    expect(stats.loans.disbursements).toEqual({
      thisMonth: { count: 3, totalAmount: 250000 },
      overall: { count: 20, totalAmount: 1250000 },
    });
  });

  it('scopes the this-month disbursement query to the start of the current calendar month', async () => {
    const prisma = buildPrisma();
    await buildService(prisma).getDashboardStats('tenant-1');

    const thisMonthCall = prisma.loan.aggregate.mock.calls[2][0];
    const now = new Date();
    const expectedMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    expect(thisMonthCall.where.disbursedAt.gte).toEqual(expectedMonthStart);

    const overallCall = prisma.loan.aggregate.mock.calls[3][0];
    expect(overallCall.where.disbursedAt).toEqual({ not: null });
  });

  // ── New metrics: FOSA/BOSA liquidity, stuck-recon pending count ────────────

  it('reports total FOSA liquidity and BOSA savings from account aggregates', async () => {
    const prisma = buildPrisma();
    prisma.account.aggregate
      .mockResolvedValueOnce({ _sum: { balance: new Decimal('5000000.0000') }, _avg: { balance: new Decimal('2500000.0000') }, _count: 2 }) // FOSA
      .mockResolvedValueOnce({ _sum: { balance: new Decimal('2000000.0000') }, _avg: { balance: new Decimal('1000000.0000') }, _count: 2 }); // BOSA

    const stats = await buildService(prisma).getDashboardStats('tenant-1');

    expect(stats.liquidity).toEqual({
      totalFosaLiquidity: 5000000,
      totalBosaSavings: 2000000,
      fosa: { totalBalance: 5000000, accountCount: 2, avgBalance: 2500000 },
      bosa: { totalBalance: 2000000, accountCount: 2, avgBalance: 1000000 },
    });
    expect(prisma.account.aggregate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: expect.objectContaining({ accountType: 'FOSA', isActive: true }) }),
    );
    expect(prisma.account.aggregate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: expect.objectContaining({ accountType: 'BOSA', isActive: true }) }),
    );
  });

  it('reports zero liquidity when there are no accounts yet', async () => {
    const prisma = buildPrisma();
    const stats = await buildService(prisma).getDashboardStats('tenant-1');
    expect(stats.liquidity).toEqual({
      totalFosaLiquidity: 0,
      totalBosaSavings: 0,
      fosa: { totalBalance: 0, accountCount: 0, avgBalance: 0 },
      bosa: { totalBalance: 0, accountCount: 0, avgBalance: 0 },
    });
  });

  it('counts M-Pesa withdrawals stuck RECON_PENDING as a pending action', async () => {
    const prisma = buildPrisma();
    prisma.mpesaTransaction.count.mockResolvedValueOnce(4);

    const stats = await buildService(prisma).getDashboardStats('tenant-1');

    expect(stats.pendingActions.mpesaWithdrawalsStuckReconPending).toBe(4);
    expect(prisma.mpesaTransaction.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ referenceType: 'FOSA_WITHDRAWAL', status: 'RECON_PENDING' }),
      }),
    );
  });

  it('scopes every new aggregate/count query to tenantId', async () => {
    const prisma = buildPrisma();
    await buildService(prisma).getDashboardStats('tenant-42');

    for (const call of prisma.account.aggregate.mock.calls) {
      expect(call[0].where.tenantId).toBe('tenant-42');
    }
    expect(prisma.mpesaTransaction.count.mock.calls[0][0].where.tenantId).toBe('tenant-42');
  });
});
