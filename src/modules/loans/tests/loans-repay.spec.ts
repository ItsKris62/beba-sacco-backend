import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { LoanStatus } from '@prisma/client';
import { LoansService } from '../loans.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { RedisService } from '../../../common/services/redis.service';
import { IdempotencyService } from '../../../common/services/idempotency.service';
import { QUEUE_NAMES } from '../../queue/queue.constants';
import { DisbursementGateService } from '../../../loans/disbursement-gate.service';
import { ProductRuleService } from '../product-rule.service';
import { LedgerService } from '../../accounting/ledger.service';

// ─── Transaction mock builder ────────────────────────────────────────────────
//
// repay() runs a $transaction callback that uses:
//   tx.$queryRaw × 2  (Account FOR UPDATE, Loan FOR UPDATE)
//   tx.transaction.create
//   tx.account.update
//   tx.loan.update
//
// We simulate it by executing the callback synchronously with a mock tx object,
// then capture the isolationLevel option on the second argument to $transaction.

type TxClient = {
  $queryRaw: jest.Mock;
  transaction: { create: jest.Mock };
  account: { update: jest.Mock };
  loan: { findFirst: jest.Mock; update: jest.Mock };
};

function buildTxClient(overrides: Partial<TxClient> = {}): TxClient {
  return {
    $queryRaw: jest.fn(),
    transaction: { create: jest.fn() },
    account: { update: jest.fn() },
    loan: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
    ...overrides,
  };
}

// ─── Stubs ───────────────────────────────────────────────────────────────────

let capturedTxOptions: unknown;
let mockTx: TxClient;

const mockPrisma = {
  // Pre-flight reads
  loan: { findFirst: jest.fn() },
  account: { findFirst: jest.fn() },
  member: { findFirst: jest.fn() },
  // $transaction executes the callback with mockTx, captures isolation options
  $transaction: jest.fn(async (cb: (tx: TxClient) => Promise<unknown>, opts?: unknown) => {
    capturedTxOptions = opts;
    return cb(mockTx);
  }),
  // no direct client in unit tests — falls back to this.prisma
  direct: undefined as undefined,
};

const mockAudit = {
  create: jest.fn().mockResolvedValue(undefined),
  createAtomic: jest.fn().mockResolvedValue(undefined),
};
const mockRedis = {};
const mockIdempotency = {};
const mockGuarantorQueue = { add: jest.fn().mockResolvedValue(undefined) };
const mockEmailQueue = { add: jest.fn().mockResolvedValue(undefined) };
const mockDisbursementGate = { assertPassed: jest.fn().mockResolvedValue(undefined) };
const mockProductRules = {};

// ─── Common fixtures ──────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-uuid-1';
const LOAN_ID = 'loan-uuid-1';
const ACCOUNT_ID = 'account-uuid-1';
const MEMBER_ID = 'member-uuid-1';
const PROCESSED_BY = 'user-uuid-1';

const activeLoanStub = {
  id: LOAN_ID,
  loanNumber: 'LN-2026-000001',
  memberId: MEMBER_ID,
  monthlyInstalment: '5000.0000',
};

const fosaAccountStub = { id: ACCOUNT_ID };

const memberUserStub = {
  user: { email: 'member@example.com', firstName: 'Jane' },
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('LoansService.repay()', () => {
  let service: LoansService;

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedTxOptions = undefined;
    mockTx = buildTxClient();
    // Reset direct to undefined so txClient = this.prisma
    (mockPrisma as any).direct = undefined;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoansService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
        { provide: RedisService, useValue: mockRedis },
        { provide: IdempotencyService, useValue: mockIdempotency },
        { provide: getQueueToken(QUEUE_NAMES.LOAN_GUARANTOR_REMINDER), useValue: mockGuarantorQueue },
        { provide: getQueueToken(QUEUE_NAMES.EMAIL), useValue: mockEmailQueue },
        { provide: DisbursementGateService, useValue: mockDisbursementGate },
        { provide: ProductRuleService, useValue: mockProductRules },
        // repay() doesn't use LedgerService (only disburse() does) — provided as a
        // dummy purely so Nest's DI container can resolve LoansService's constructor.
        { provide: LedgerService, useValue: {} },
      ],
    }).compile();

    service = module.get<LoansService>(LoansService);
  });

  // ── Input validation ──────────────────────────────────────────────────────

  it('throws BadRequestException for zero amount', async () => {
    await expect(service.repay(LOAN_ID, 0, TENANT_ID, PROCESSED_BY)).rejects.toThrow(
      BadRequestException,
    );
    expect(mockPrisma.loan.findFirst).not.toHaveBeenCalled();
  });

  it('throws BadRequestException for negative amount', async () => {
    await expect(service.repay(LOAN_ID, -500, TENANT_ID, PROCESSED_BY)).rejects.toThrow(
      BadRequestException,
    );
  });

  // ── Pre-flight 404 guards ─────────────────────────────────────────────────

  it('throws NotFoundException when no ACTIVE loan found', async () => {
    mockPrisma.loan.findFirst.mockResolvedValueOnce(null);

    await expect(service.repay(LOAN_ID, 5000, TENANT_ID, PROCESSED_BY)).rejects.toThrow(
      NotFoundException,
    );
    expect(mockPrisma.account.findFirst).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when member has no active FOSA account', async () => {
    mockPrisma.loan.findFirst.mockResolvedValueOnce(activeLoanStub);
    mockPrisma.account.findFirst.mockResolvedValueOnce(null);

    await expect(service.repay(LOAN_ID, 5000, TENANT_ID, PROCESSED_BY)).rejects.toThrow(
      BadRequestException,
    );
  });

  // ── Serializable isolation ─────────────────────────────────────────────────

  it('passes isolationLevel Serializable to $transaction', async () => {
    mockPrisma.loan.findFirst.mockResolvedValueOnce(activeLoanStub);
    mockPrisma.account.findFirst.mockResolvedValueOnce(fosaAccountStub);
    mockPrisma.member.findFirst.mockResolvedValueOnce(memberUserStub);

    // Account and Loan FOR UPDATE locks return valid rows
    mockTx.$queryRaw
      .mockResolvedValueOnce([{ id: ACCOUNT_ID, balance: '20000.0000', version: 1 }]) // Account
      .mockResolvedValueOnce([{ id: LOAN_ID, outstandingBalance: '10000.0000', status: LoanStatus.ACTIVE, accruedInterest: '0.0000', arrearsAmount: '0.0000' }]); // Loan

    mockTx.transaction.create.mockResolvedValueOnce({ amount: '5000.0000', id: 'txn-uuid-1' });
    mockTx.account.update.mockResolvedValueOnce({});
    mockTx.loan.update.mockResolvedValueOnce({ id: LOAN_ID, status: LoanStatus.ACTIVE });

    await service.repay(LOAN_ID, 5000, TENANT_ID, PROCESSED_BY);

    expect(capturedTxOptions).toMatchObject({ isolationLevel: 'Serializable' });
  });

  it('uses this.prisma when direct is not available', async () => {
    mockPrisma.loan.findFirst.mockResolvedValueOnce(activeLoanStub);
    mockPrisma.account.findFirst.mockResolvedValueOnce(fosaAccountStub);
    mockPrisma.member.findFirst.mockResolvedValueOnce(null);

    mockTx.$queryRaw
      .mockResolvedValueOnce([{ id: ACCOUNT_ID, balance: '20000.0000', version: 1 }])
      .mockResolvedValueOnce([{ id: LOAN_ID, outstandingBalance: '10000.0000', status: LoanStatus.ACTIVE, accruedInterest: '0.0000', arrearsAmount: '0.0000' }]);

    mockTx.transaction.create.mockResolvedValueOnce({ amount: '5000.0000', id: 'txn-uuid-1' });
    mockTx.account.update.mockResolvedValueOnce({});
    mockTx.loan.update.mockResolvedValueOnce({ id: LOAN_ID, status: LoanStatus.ACTIVE });

    await service.repay(LOAN_ID, 5000, TENANT_ID, PROCESSED_BY);

    // $transaction was called on mockPrisma (the fallback), not on a separate direct client
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  // ── 422 insufficient FOSA balance ─────────────────────────────────────────

  it('throws UnprocessableEntityException (422) when FOSA balance is insufficient', async () => {
    mockPrisma.loan.findFirst.mockResolvedValueOnce(activeLoanStub);
    mockPrisma.account.findFirst.mockResolvedValueOnce(fosaAccountStub);
    mockPrisma.member.findFirst.mockResolvedValueOnce(null);

    // Account has KES 500, repayment request is KES 5000
    mockTx.$queryRaw
      .mockResolvedValueOnce([{ id: ACCOUNT_ID, balance: '500.0000', version: 1 }])
      .mockResolvedValueOnce([{ id: LOAN_ID, outstandingBalance: '10000.0000', status: LoanStatus.ACTIVE, accruedInterest: '0.0000', arrearsAmount: '0.0000' }]);

    await expect(service.repay(LOAN_ID, 5000, TENANT_ID, PROCESSED_BY)).rejects.toThrow(
      UnprocessableEntityException,
    );
    expect(mockTx.transaction.create).not.toHaveBeenCalled();
  });

  it('error message includes current balance and required amount', async () => {
    mockPrisma.loan.findFirst.mockResolvedValueOnce(activeLoanStub);
    mockPrisma.account.findFirst.mockResolvedValueOnce(fosaAccountStub);
    mockPrisma.member.findFirst.mockResolvedValueOnce(null);

    mockTx.$queryRaw
      .mockResolvedValueOnce([{ id: ACCOUNT_ID, balance: '200.0000', version: 1 }])
      .mockResolvedValueOnce([{ id: LOAN_ID, outstandingBalance: '10000.0000', status: LoanStatus.ACTIVE, accruedInterest: '0.0000', arrearsAmount: '0.0000' }]);

    const err = await service.repay(LOAN_ID, 3000, TENANT_ID, PROCESSED_BY).catch((e) => e);

    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(err.message).toContain('200.00');
    expect(err.message).toContain('3000.00');
  });

  // ── Concurrent status change guard ───────────────────────────────────────

  it('throws BadRequestException when loan status changed during concurrent processing', async () => {
    mockPrisma.loan.findFirst.mockResolvedValueOnce(activeLoanStub); // pre-flight: ACTIVE
    mockPrisma.account.findFirst.mockResolvedValueOnce(fosaAccountStub);
    mockPrisma.member.findFirst.mockResolvedValueOnce(null);

    // Loan row is now FULLY_PAID by the time FOR UPDATE lock is acquired
    mockTx.$queryRaw
      .mockResolvedValueOnce([{ id: ACCOUNT_ID, balance: '20000.0000', version: 1 }])
      .mockResolvedValueOnce([{ id: LOAN_ID, outstandingBalance: '0.0000', status: LoanStatus.FULLY_PAID, accruedInterest: '0.0000', arrearsAmount: '0.0000' }]);

    const err = await service.repay(LOAN_ID, 5000, TENANT_ID, PROCESSED_BY).catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain('FULLY_PAID');
  });

  // ── FULLY_PAID transition ─────────────────────────────────────────────────

  it('marks loan FULLY_PAID when repayment covers outstanding balance exactly', async () => {
    const outstandingBalance = '5000.0000';
    mockPrisma.loan.findFirst.mockResolvedValueOnce(activeLoanStub);
    mockPrisma.account.findFirst.mockResolvedValueOnce(fosaAccountStub);
    mockPrisma.member.findFirst.mockResolvedValueOnce(null);

    mockTx.$queryRaw
      .mockResolvedValueOnce([{ id: ACCOUNT_ID, balance: '10000.0000', version: 1 }])
      .mockResolvedValueOnce([{ id: LOAN_ID, outstandingBalance, status: LoanStatus.ACTIVE, accruedInterest: '0.0000', arrearsAmount: '0.0000' }]);

    const updatedLoan = { id: LOAN_ID, status: LoanStatus.FULLY_PAID };
    mockTx.transaction.create.mockResolvedValueOnce({ amount: '5000.0000', id: 'txn-uuid-1' });
    mockTx.account.update.mockResolvedValueOnce({});
    mockTx.loan.update.mockResolvedValueOnce(updatedLoan);

    const result = await service.repay(LOAN_ID, 5000, TENANT_ID, PROCESSED_BY);

    expect(mockTx.loan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: LoanStatus.FULLY_PAID }),
      }),
    );
    expect(result.newOutstandingBalance).toBe(0);
  });

  it('marks loan FULLY_PAID when repayment exceeds outstanding (caps at outstanding)', async () => {
    const outstandingBalance = '3000.0000';
    mockPrisma.loan.findFirst.mockResolvedValueOnce(activeLoanStub);
    mockPrisma.account.findFirst.mockResolvedValueOnce(fosaAccountStub);
    mockPrisma.member.findFirst.mockResolvedValueOnce(null);

    mockTx.$queryRaw
      .mockResolvedValueOnce([{ id: ACCOUNT_ID, balance: '20000.0000', version: 1 }])
      .mockResolvedValueOnce([{ id: LOAN_ID, outstandingBalance, status: LoanStatus.ACTIVE, accruedInterest: '0.0000', arrearsAmount: '0.0000' }]);

    mockTx.transaction.create.mockResolvedValueOnce({ amount: '3000.0000', id: 'txn-uuid-1' });
    mockTx.account.update.mockResolvedValueOnce({});
    mockTx.loan.update.mockResolvedValueOnce({ id: LOAN_ID, status: LoanStatus.FULLY_PAID });

    await service.repay(LOAN_ID, 10000, TENANT_ID, PROCESSED_BY); // sends 10k, only 3k due

    // transaction.create should have been called with the capped amount, not 10000
    // Decimal.toDecimalPlaces(4).toString() strips trailing zeros → '3000' not '3000.0000'
    const txnData = mockTx.transaction.create.mock.calls[0][0].data;
    expect(new (require('decimal.js').Decimal)(txnData.amount).toNumber()).toBe(3000);
  });

  it('loan stays ACTIVE when partial repayment leaves positive outstanding', async () => {
    mockPrisma.loan.findFirst.mockResolvedValueOnce(activeLoanStub);
    mockPrisma.account.findFirst.mockResolvedValueOnce(fosaAccountStub);
    mockPrisma.member.findFirst.mockResolvedValueOnce(null);

    mockTx.$queryRaw
      .mockResolvedValueOnce([{ id: ACCOUNT_ID, balance: '20000.0000', version: 1 }])
      .mockResolvedValueOnce([{ id: LOAN_ID, outstandingBalance: '10000.0000', status: LoanStatus.ACTIVE, accruedInterest: '0.0000', arrearsAmount: '0.0000' }]);

    mockTx.transaction.create.mockResolvedValueOnce({ amount: '5000.0000', id: 'txn-uuid-1' });
    mockTx.account.update.mockResolvedValueOnce({});
    mockTx.loan.update.mockResolvedValueOnce({ id: LOAN_ID, status: LoanStatus.ACTIVE });

    await service.repay(LOAN_ID, 5000, TENANT_ID, PROCESSED_BY);

    const loanUpdateData = mockTx.loan.update.mock.calls[0][0].data;
    expect(loanUpdateData.status).toBe(LoanStatus.ACTIVE);
    // Decimal.toDecimalPlaces(4).toString() strips trailing zeros → '5000' not '5000.0000'
    expect(new (require('decimal.js').Decimal)(loanUpdateData.outstandingBalance).toNumber()).toBe(5000);
  });

  // ── Return shape ──────────────────────────────────────────────────────────

  it('returns { loan, transaction, reference, paidAt, newOutstandingBalance }', async () => {
    mockPrisma.loan.findFirst.mockResolvedValueOnce(activeLoanStub);
    mockPrisma.account.findFirst.mockResolvedValueOnce(fosaAccountStub);
    mockPrisma.member.findFirst.mockResolvedValueOnce(null);

    mockTx.$queryRaw
      .mockResolvedValueOnce([{ id: ACCOUNT_ID, balance: '20000.0000', version: 1 }])
      .mockResolvedValueOnce([{ id: LOAN_ID, outstandingBalance: '10000.0000', status: LoanStatus.ACTIVE, accruedInterest: '0.0000', arrearsAmount: '0.0000' }]);

    const txnStub = { amount: '5000.0000', id: 'txn-uuid-1' };
    const updatedLoanStub = { id: LOAN_ID, status: LoanStatus.ACTIVE };
    mockTx.transaction.create.mockResolvedValueOnce(txnStub);
    mockTx.account.update.mockResolvedValueOnce({});
    mockTx.loan.update.mockResolvedValueOnce(updatedLoanStub);

    const result = await service.repay(LOAN_ID, 5000, TENANT_ID, PROCESSED_BY);

    expect(result).toMatchObject({
      loan: updatedLoanStub,
      transaction: txnStub,
      newOutstandingBalance: 5000,
    });
    expect(result.reference).toMatch(/^REPAY-/);
    expect(result.paidAt).toBeInstanceOf(Date);
  });
});
