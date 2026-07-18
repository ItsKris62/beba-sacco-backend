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
//   tx.$queryRaw           × 1–2 (SELECT ... FOR UPDATE)
//   tx.account.updateMany  × 1–2 (CAS version check)
//   tx.loan.update         × 1
// }), and calls this.ledger.post{Interest,Penalty}...Entry() for the GL leg.

type TxClient = {
  $queryRaw: jest.Mock;
  transaction: { create: jest.Mock; findFirst: jest.Mock };
  account: { updateMany: jest.Mock; findFirst: jest.Mock };
  loan: { update: jest.Mock };
  loanRepayment: { findMany: jest.Mock; updateMany: jest.Mock };
};

function buildTxClient(): TxClient {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ balance: '10000.0000', version: 0 }]),
    transaction: {
      create: jest.fn().mockResolvedValue({ id: 'txn-1' }),
      findFirst: jest.fn().mockResolvedValue(null), // no existing accrual — not a replay
    },
    account: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({ balance: '10000.0000' }),
    },
    loan: { update: jest.fn().mockResolvedValue({}) },
    // Defaults to no overdue installments — applyOverdueInstallmentsAndArrears()
    // calls this twice per loan (penalty-eligible fetch, then the post-penalty
    // arrears rollup fetch); tests that care about installment-driven arrears
    // override both calls explicitly via mockResolvedValueOnce chaining.
    loanRepayment: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

// ─── Stubs ────────────────────────────────────────────────────────────────────

let mockTx: TxClient;

const mockPrisma = {
  loan: { findMany: jest.fn() },
  // computeScheduleBasedDailyInterest() reads via this.prisma (not tx) — it
  // runs before the per-loan $transaction opens, same as the old
  // outstanding-based dailyInterest calc it replaces. Defaults to a single
  // not-yet-due installment 61 days out (disbursedAt='2026-04-08' in
  // buildActiveLoan() -> dueDate='2026-06-08'), so every pre-existing test
  // below that doesn't care about the exact interest figure still gets a
  // sensible non-zero dailyInterest without per-test setup.
  loanRepayment: {
    findMany: jest.fn().mockResolvedValue([
      { dayNumber: 1, dueDate: new Date('2026-06-08T00:00:00.000Z'), interestDue: '100.0000', status: 'PENDING' },
    ]),
    findFirst: jest.fn().mockResolvedValue(null),
  },
  $transaction: jest.fn(async (cb: (tx: TxClient) => Promise<unknown>) => cb(mockTx)),
};

const mockRedis = {
  set: jest.fn().mockResolvedValue(true), // lock acquired
};

const mockLedger = {
  postInterestAccrualEntry: jest.fn().mockResolvedValue({ journalEntry: { id: 'je-interest-1' }, replayed: false }),
  postPenaltyDeductionEntry: jest.fn().mockResolvedValue({ journalEntry: { id: 'je-penalty-1' }, replayed: false }),
  postPenaltyReceivableEntry: jest.fn().mockResolvedValue({ journalEntry: { id: 'je-penalty-receivable-1' }, replayed: false }),
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
    dueDate: new Date('2027-01-01'),               // loan's final maturity — not yet due
    disbursedAt: new Date('2026-04-08T00:00:00.000Z'),
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

  it('computes increment as currentInstallment.interestDue / daysInPeriod, NOT outstanding × annualRate / 365 (Phase 4 fix)', async () => {
    mockPrisma.loan.findMany.mockResolvedValueOnce([buildActiveLoan()]);
    // disbursedAt (2026-04-08) -> dueDate (2026-06-08) = 61 days; interestDue=100.
    mockPrisma.loanRepayment.findMany.mockResolvedValueOnce([
      { dayNumber: 1, dueDate: new Date('2026-06-08T00:00:00.000Z'), interestDue: '100.0000', status: 'PENDING' },
    ]);

    await service.runDailyAccrual(TENANT_ID, ACCRUAL_DATE);

    const loanUpdateCall = mockTx.loan.update.mock.calls[0][0];
    const increment = loanUpdateCall.data.accruedInterest.increment as number;

    expect(increment).toBeCloseTo(100 / 61, 4);
    // The old outstanding-based formula (10000 × 0.12 / 365 ≈ 3.2877) must NOT
    // be what's driving this figure any more.
    expect(increment).not.toBeCloseTo((10000 * 0.12) / 365, 4);
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

  // ── Consolidated installment-based arrears (Phase 2 audit fix) ────────────
  //
  // Replaces the old Loan.dueDate-based arrears calc, which never reflected a
  // missed installment mid-tenure (only the loan's final maturity date), and
  // used to race against the separately-scheduled LoanPenaltyProcessor for
  // ownership of Loan.arrearsAmount. Both concerns now live in
  // applyOverdueInstallmentsAndArrears(), called once per loan inside this
  // same accrual transaction.

  describe('installment-based arrears rollup', () => {
    function buildMissedInstallment(overrides: Record<string, unknown> = {}) {
      return {
        id: 'repay-month-2',
        status: 'PENDING',
        principalDue: '1000.0000',
        interestDue: '200.0000',
        penaltyDue: '0.0000',
        principalPaid: '0.0000',
        interestPaid: '0.0000',
        penaltyPaid: '0.0000',
        lastPenaltyAccrualDate: null,
        ...overrides,
      };
    }

    it('flags arrears from a missed Month-2 installment even though Loan.dueDate (final maturity) is months away', async () => {
      // buildActiveLoan()'s dueDate is 2027-01-01 — the legacy final-maturity
      // penalty must NOT fire, yet arrears must still be detected.
      mockPrisma.loan.findMany.mockResolvedValueOnce([buildActiveLoan()]);

      const accrualDateObj = new Date(ACCRUAL_DATE);
      const missedDueDate = new Date(accrualDateObj.getTime() - 45 * 24 * 60 * 60 * 1000);
      const installment = buildMissedInstallment({ dueDate: missedDueDate });
      // penalty = (principalDue + interestDue) * 1% = (1000 + 200) * 0.01 = 12
      const installmentAfterPenalty = { ...installment, penaltyDue: '12.0000' };

      mockTx.loanRepayment.findMany
        .mockResolvedValueOnce([installment]) // penalty-eligible fetch
        .mockResolvedValueOnce([installmentAfterPenalty]); // post-penalty arrears rollup fetch

      await service.runDailyAccrual(TENANT_ID, ACCRUAL_DATE);

      expect(mockTx.loanRepayment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'repay-month-2' }),
          data: expect.objectContaining({
            penaltyDue: { increment: '12' },
            status: 'OVERDUE',
          }),
        }),
      );

      const loanUpdateCall = mockTx.loan.update.mock.calls[0][0];
      expect(loanUpdateCall.data.arrearsDays).toBe(45);
      expect(loanUpdateCall.data.arrearsAmount).toBe('1212'); // 1000 + 200 + 12 - 0
      expect(loanUpdateCall.data.staging).toBe(LoanStaging.WATCHLIST); // 30 <= 45 < 90
      expect(loanUpdateCall.data.status).toBeUndefined(); // not yet NPL — must not force DEFAULTED
    });

    it('transitions to DEFAULTED once the earliest missed installment is 90+ days overdue, independent of Loan.dueDate', async () => {
      mockPrisma.loan.findMany.mockResolvedValueOnce([buildActiveLoan()]); // dueDate still in 2027

      const accrualDateObj = new Date(ACCRUAL_DATE);
      const missedDueDate = new Date(accrualDateObj.getTime() - 90 * 24 * 60 * 60 * 1000);
      const installment = buildMissedInstallment({ dueDate: missedDueDate, lastPenaltyAccrualDate: accrualDateObj });

      // Already accrued penalty today — not penalty-eligible again, but still
      // counts toward the arrears rollup.
      mockTx.loanRepayment.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([installment]);

      await service.runDailyAccrual(TENANT_ID, ACCRUAL_DATE);

      const loanUpdateCall = mockTx.loan.update.mock.calls[0][0];
      expect(loanUpdateCall.data.arrearsDays).toBe(90);
      expect(loanUpdateCall.data.staging).toBe(LoanStaging.NPL);
      expect(loanUpdateCall.data.status).toBe(LoanStatus.DEFAULTED);
    });

    it('writes arrears/staging together with the accruedInterest increment in a single tx.loan.update() call — no competing second write', async () => {
      mockPrisma.loan.findMany.mockResolvedValueOnce([buildActiveLoan()]);

      await service.runDailyAccrual(TENANT_ID, ACCRUAL_DATE);

      expect(mockTx.loan.update).toHaveBeenCalledTimes(1);
      const data = mockTx.loan.update.mock.calls[0][0].data;
      expect(data).toEqual(
        expect.objectContaining({
          arrearsDays: 0,
          arrearsAmount: '0',
          staging: LoanStaging.PERFORMING,
          lastAccrualDate: expect.any(Date),
          accruedInterest: expect.objectContaining({ increment: expect.any(Number) }),
        }),
      );
    });

    it('does not re-accrue a penalty for an installment already charged today (idempotent per-day guard)', async () => {
      mockPrisma.loan.findMany.mockResolvedValueOnce([buildActiveLoan()]);

      const accrualDateObj = new Date(ACCRUAL_DATE);
      const missedDueDate = new Date(accrualDateObj.getTime() - 45 * 24 * 60 * 60 * 1000);
      // lastPenaltyAccrualDate === today's accrual date — the WHERE clause on the
      // real DB would already exclude this row; here we prove the code applies
      // the same guard by simply never returning it from the penalty-eligible fetch.
      mockTx.loanRepayment.findMany
        .mockResolvedValueOnce([]) // penalty-eligible fetch: none (already accrued today)
        .mockResolvedValueOnce([buildMissedInstallment({ dueDate: missedDueDate, lastPenaltyAccrualDate: accrualDateObj })]);

      await service.runDailyAccrual(TENANT_ID, ACCRUAL_DATE);

      expect(mockTx.loanRepayment.updateMany).not.toHaveBeenCalled();
    });
  });

  // ── Schedule-based daily interest (Phase 4 audit fix) ─────────────────────
  //
  // Replaces outstanding * annualRate / 365, which is only correct for
  // REDUCING_BALANCE and silently under/over-accrues FLAT-rate loans (whose
  // interestDue is fixed per the schedule, not a function of the shrinking
  // outstanding balance). computeScheduleBasedDailyInterest() reads via
  // this.prisma.loanRepayment (not tx), so these tests set up
  // mockPrisma.loanRepayment.findMany, not mockTx.loanRepayment.findMany.

  describe('schedule-based daily interest', () => {
    it('FLAT-style: dailyInterest is derived purely from the scheduled interestDue, ignoring how much principal has since been repaid', async () => {
      // Simulate a loan where a large principal payment already landed —
      // outstandingBalance is now tiny, but the schedule's interestDue for the
      // current installment is unaffected (that's the whole point of FLAT).
      const loan = buildActiveLoan({ outstandingBalance: { toString: () => '50.0000' } });
      mockPrisma.loan.findMany.mockResolvedValueOnce([loan]);
      mockPrisma.loanRepayment.findMany.mockResolvedValueOnce([
        { dayNumber: 1, dueDate: new Date('2026-05-18T00:00:00.000Z'), interestDue: '300.0000', status: 'PENDING' },
      ]);

      await service.runDailyAccrual(TENANT_ID, ACCRUAL_DATE);

      const loanUpdateCall = mockTx.loan.update.mock.calls[0][0];
      const increment = loanUpdateCall.data.accruedInterest.increment as number;
      // disbursedAt (2026-04-08) -> dueDate (2026-05-18) = 40 days.
      expect(increment).toBeCloseTo(300 / 40, 4);
      // Proves it's NOT balance-based: outstanding(50) × 0.12 / 365 would be ~0.0164.
      expect(increment).not.toBeCloseTo((50 * 0.12) / 365, 4);
    });

    it('REDUCING_BALANCE: daily accruals summed over the whole installment period equal exactly the scheduled interestDue', async () => {
      const disbursedAt = new Date('2026-05-01T00:00:00.000Z');
      const dueDate = new Date('2026-05-11T00:00:00.000Z'); // clean 10-day period
      const interestDue = '100.0000'; // -> 10/day exactly

      let totalAccrued = 0;
      for (let day = 2; day <= 11; day++) {
        const accrualDateStr = `2026-05-${String(day).padStart(2, '0')}`;
        mockPrisma.loan.findMany.mockResolvedValueOnce([buildActiveLoan({ disbursedAt })]);
        mockPrisma.loanRepayment.findMany.mockResolvedValueOnce([
          { dayNumber: 1, dueDate, interestDue, status: 'PENDING' },
        ]);

        await service.runDailyAccrual(TENANT_ID, accrualDateStr);
        const calls = mockTx.loan.update.mock.calls;
        totalAccrued += calls[calls.length - 1][0].data.accruedInterest.increment as number;
      }

      expect(totalAccrued).toBeCloseTo(100, 4);
    });

    it('accrues 0 interest once a loan has no unpaid installments left (fully paid schedule)', async () => {
      mockPrisma.loan.findMany.mockResolvedValueOnce([buildActiveLoan()]);
      mockPrisma.loanRepayment.findMany.mockResolvedValueOnce([]); // nothing left unpaid

      await service.runDailyAccrual(TENANT_ID, ACCRUAL_DATE);

      const loanUpdateCall = mockTx.loan.update.mock.calls[0][0];
      expect(loanUpdateCall.data.accruedInterest).toEqual({ increment: 0 });
      // No INTEREST_ACCRUAL transaction should post for zero interest.
      const txnTypes = mockTx.transaction.create.mock.calls.map((c: any) => c[0].data.type);
      expect(txnTypes).not.toContain('INTEREST_ACCRUAL');
    });

    it('stops normal daily accrual once the current installment is in arrears (defers to the penalty engine)', async () => {
      mockPrisma.loan.findMany.mockResolvedValueOnce([buildActiveLoan()]);
      const accrualDateObj = new Date(ACCRUAL_DATE);
      const pastDueDate = new Date(accrualDateObj.getTime() - 5 * 24 * 60 * 60 * 1000); // 5 days overdue
      mockPrisma.loanRepayment.findMany.mockResolvedValueOnce([
        { dayNumber: 1, dueDate: pastDueDate, interestDue: '100.0000', status: 'OVERDUE' },
      ]);

      await service.runDailyAccrual(TENANT_ID, ACCRUAL_DATE);

      const loanUpdateCall = mockTx.loan.update.mock.calls[0][0];
      expect(loanUpdateCall.data.accruedInterest).toEqual({ increment: 0 });
    });
  });
});
