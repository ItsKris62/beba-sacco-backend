import { Test, TestingModule } from '@nestjs/testing';
import { LoanStatus, LoanStaging } from '@prisma/client';
import { FinancialService } from '../financial.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../common/services/redis.service';
import { LedgerService } from '../../accounting/ledger.service';

// ─── Transaction mock ─────────────────────────────────────────────────────────
//
// accrueInterestForLoan() uses this.prisma.$transaction(async (tx) => {
//   tx.transaction.findFirst × 1–2 (idempotency pre-check per leg)
//   tx.transaction.create  × 1 (interest), optionally × 2 (penalty)
//   tx.account.update      × 1–2
//   tx.account.findUnique  × 0–1 (re-read before penalty)
//   tx.loan.update         × 1
// }), and calls this.ledger.post{Interest,Penalty}...Entry() for the GL leg.

type TxClient = {
  transaction: { create: jest.Mock; findFirst: jest.Mock };
  account: { update: jest.Mock; findUnique: jest.Mock };
  loan: { update: jest.Mock };
};

function buildTxClient(): TxClient {
  return {
    transaction: {
      create: jest.fn().mockResolvedValue({ id: 'txn-1' }),
      findFirst: jest.fn().mockResolvedValue(null), // no existing accrual — not a replay
    },
    account: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ balance: '10000.0000' }),
    },
    loan: { update: jest.fn().mockResolvedValue({}) },
  };
}

// ─── Stubs ────────────────────────────────────────────────────────────────────

let mockTx: TxClient;

const mockPrisma = {
  loan: { findMany: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: TxClient) => Promise<unknown>) => cb(mockTx)),
};

const mockRedis = {
  set: jest.fn().mockResolvedValue(true), // lock acquired
};

const mockLedger = {
  postInterestAccrualEntry: jest.fn().mockResolvedValue({ journalEntry: { id: 'je-interest-1' }, replayed: false }),
  postPenaltyDeductionEntry: jest.fn().mockResolvedValue({ journalEntry: { id: 'je-penalty-1' }, replayed: false }),
};

// ─── Common fixtures ──────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-uuid-1';
const LOAN_ID = 'loan-uuid-1';
const ACCOUNT_ID = 'account-uuid-1';
const ACCRUAL_DATE = '2026-05-08';

function buildActiveLoan(overrides: Record<string, unknown> = {}) {
  return {
    id: LOAN_ID,
    tenantId: TENANT_ID,
    outstandingBalance: { toString: () => '10000.0000' },
    principalAmount: { toString: () => '50000.0000' },
    interestRate: { toString: () => '0.1200' },    // 12% annual
    dueDate: new Date('2027-01-01'),               // not yet due
    arrearsDays: 0,
    loanProduct: { interestType: 'REDUCING_BALANCE' },
    member: {
      accounts: [{ id: ACCOUNT_ID, balance: { toString: () => '10000.0000' } }],
    },
    ...overrides,
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('FinancialService.accrueInterestForLoan() — Tier 3 accruedInterest increment', () => {
  let service: FinancialService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTx = buildTxClient();
    mockRedis.set.mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FinancialService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: LedgerService, useValue: mockLedger },
      ],
    }).compile();

    service = module.get<FinancialService>(FinancialService);
  });

  // ── accruedInterest increment ─────────────────────────────────────────────

  it('increments loan.accruedInterest by dailyInterest in tx.loan.update()', async () => {
    mockPrisma.loan.findMany.mockResolvedValueOnce([buildActiveLoan()]);

    await service.runDailyAccrual(TENANT_ID, ACCRUAL_DATE);

    const loanUpdateCall = mockTx.loan.update.mock.calls[0][0];
    expect(loanUpdateCall.data.accruedInterest).toEqual(
      expect.objectContaining({ increment: expect.any(Number) }),
    );
  });

  it('computes increment as outstanding × annualRate / 365 (4 decimal places)', async () => {
    // outstanding=10000, rate=12% → daily = 10000 × 0.12 / 365 ≈ 3.2877
    mockPrisma.loan.findMany.mockResolvedValueOnce([buildActiveLoan()]);

    await service.runDailyAccrual(TENANT_ID, ACCRUAL_DATE);

    const loanUpdateCall = mockTx.loan.update.mock.calls[0][0];
    const increment = loanUpdateCall.data.accruedInterest.increment as number;

    expect(increment).toBeCloseTo(10000 * 0.12 / 365, 4);
    // Verify 4 decimal precision (no more than 4 dp)
    const decimalPlaces = increment.toString().split('.')[1]?.length ?? 0;
    expect(decimalPlaces).toBeLessThanOrEqual(4);
  });

  it('posts INTEREST_ACCRUAL transaction to FOSA in same tx', async () => {
    mockPrisma.loan.findMany.mockResolvedValueOnce([buildActiveLoan()]);

    await service.runDailyAccrual(TENANT_ID, ACCRUAL_DATE);

    const txnCreateCall = mockTx.transaction.create.mock.calls[0][0];
    expect(txnCreateCall.data.type).toBe('INTEREST_ACCRUAL');
    expect(txnCreateCall.data.accountId).toBe(ACCOUNT_ID);
  });

  it('skips accrual (no tx.loan.update) when outstanding balance is 0', async () => {
    const zeroed = buildActiveLoan({
      outstandingBalance: { toString: () => '0.0000' },
    });
    mockPrisma.loan.findMany.mockResolvedValueOnce([zeroed]);

    await service.runDailyAccrual(TENANT_ID, ACCRUAL_DATE);

    // accrueInterestForLoan returns early when outstanding ≤ 0
    expect(mockTx.loan.update).not.toHaveBeenCalled();
  });

  it('includes accruedInterest.increment even on overdue loans (also posts penalty)', async () => {
    const overdueLoan = buildActiveLoan({
      dueDate: new Date('2024-01-01'), // well past due
    });
    mockPrisma.loan.findMany.mockResolvedValueOnce([overdueLoan]);

    await service.runDailyAccrual(TENANT_ID, ACCRUAL_DATE);

    const loanUpdateCall = mockTx.loan.update.mock.calls[0][0];
    expect(loanUpdateCall.data.accruedInterest).toEqual(
      expect.objectContaining({ increment: expect.any(Number) }),
    );
    // Penalty transaction should also have been posted
    const allTxnTypes = mockTx.transaction.create.mock.calls.map((c) => c[0].data.type);
    expect(allTxnTypes).toContain('PENALTY');
  });

  it('sets lastAccrualDate in the same loan update', async () => {
    mockPrisma.loan.findMany.mockResolvedValueOnce([buildActiveLoan()]);

    await service.runDailyAccrual(TENANT_ID, ACCRUAL_DATE);

    const loanUpdateCall = mockTx.loan.update.mock.calls[0][0];
    expect(loanUpdateCall.data.lastAccrualDate).toBeInstanceOf(Date);
  });

  // ── Redis lock idempotency ────────────────────────────────────────────────

  it('returns {processed:0, skipped:0} when Redis lock is already held', async () => {
    mockRedis.set.mockResolvedValueOnce(false); // lock NOT acquired

    const result = await service.runDailyAccrual(TENANT_ID, ACCRUAL_DATE);

    expect(result).toEqual({ processed: 0, skipped: 0 });
    expect(mockPrisma.loan.findMany).not.toHaveBeenCalled();
  });

  it('returns {processed: N} for N loans accrued', async () => {
    mockPrisma.loan.findMany.mockResolvedValueOnce([
      buildActiveLoan({ id: 'loan-1' }),
      buildActiveLoan({ id: 'loan-2' }),
    ]);
    // Each loan needs its own tx mock since $transaction is called per loan
    const tx2 = buildTxClient();
    mockPrisma.$transaction
      .mockImplementationOnce(async (cb: (tx: TxClient) => Promise<unknown>) => cb(mockTx))
      .mockImplementationOnce(async (cb: (tx: TxClient) => Promise<unknown>) => cb(tx2));

    const result = await service.runDailyAccrual(TENANT_ID, ACCRUAL_DATE);

    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(0);
  });
});
