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

function buildPrisma() {
  return {
    member: { count: jest.fn().mockResolvedValue(0) },
    user: { count: jest.fn().mockResolvedValue(0) },
    loan: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { principalAmount: null }, _count: 0 }),
    },
    mpesaTransaction: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null }, _count: 0 }),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

describe('AdminService.getDashboardStats() — PAR>30 and disbursement totals', () => {
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
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    redis.get.mockResolvedValue(null);
  });

  it('computes portfolioAtRisk30d from WATCHLIST/NPL-staged active loans as a share of total active outstanding', async () => {
    const prisma = buildPrisma();
    // First loan.findMany call = activeLoans (total active outstanding = 100000),
    // second = parLoans (the WATCHLIST/NPL-staged subset).
    prisma.loan.findMany
      .mockResolvedValueOnce([
        { outstandingBalance: new Decimal('60000.0000') },
        { outstandingBalance: new Decimal('40000.0000') },
      ])
      .mockResolvedValueOnce([{ outstandingBalance: new Decimal('40000.0000') }]);

    const stats = await buildService(prisma).getDashboardStats('tenant-1');

    expect(stats.loans.portfolioAtRisk30d).toEqual({
      outstandingAmount: 40000,
      percentOfActivePortfolio: 40,
    });
  });

  it('returns 0% PAR when there is no active outstanding portfolio', async () => {
    const prisma = buildPrisma();
    prisma.loan.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const stats = await buildService(prisma).getDashboardStats('tenant-1');

    expect(stats.loans.portfolioAtRisk30d).toEqual({
      outstandingAmount: 0,
      percentOfActivePortfolio: 0,
    });
  });

  it('reports disbursement totals for this month and overall separately', async () => {
    const prisma = buildPrisma();
    prisma.loan.aggregate
      .mockResolvedValueOnce({ _sum: { principalAmount: new Decimal('250000.0000') }, _count: 3 })
      .mockResolvedValueOnce({ _sum: { principalAmount: new Decimal('1250000.0000') }, _count: 20 });

    const stats = await buildService(prisma).getDashboardStats('tenant-1');

    expect(stats.loans.disbursements).toEqual({
      thisMonth: { count: 3, totalAmount: 250000 },
      overall: { count: 20, totalAmount: 1250000 },
    });
  });

  it('scopes the this-month disbursement query to the start of the current calendar month', async () => {
    const prisma = buildPrisma();
    await buildService(prisma).getDashboardStats('tenant-1');

    const thisMonthCall = prisma.loan.aggregate.mock.calls[0][0];
    const now = new Date();
    const expectedMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    expect(thisMonthCall.where.disbursedAt.gte).toEqual(expectedMonthStart);

    const overallCall = prisma.loan.aggregate.mock.calls[1][0];
    expect(overallCall.where.disbursedAt).toEqual({ not: null });
  });
});
