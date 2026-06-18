import { Test, TestingModule } from '@nestjs/testing';
import { UnprocessableEntityException } from '@nestjs/common';
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

// ─── Transaction mock ─────────────────────────────────────────────────────────

type TxClient = {
  $queryRaw: jest.Mock;
  transaction: { create: jest.Mock };
  account: { update: jest.Mock };
  loan: { findFirst: jest.Mock; update: jest.Mock };
};

function buildTxClient(): TxClient {
  return {
    $queryRaw: jest.fn(),
    transaction: { create: jest.fn() },
    account: { update: jest.fn() },
    loan: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
  };
}

// ─── Stubs ────────────────────────────────────────────────────────────────────

let mockTx: TxClient;

const mockPrisma = {
  loan: { findFirst: jest.fn() },
  account: { findFirst: jest.fn() },
  member: { findFirst: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: TxClient) => Promise<unknown>) => cb(mockTx)),
  direct: undefined as undefined,
};

const mockAudit = { create: jest.fn().mockResolvedValue(undefined) };
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

function setupRepayMocks(
  balance: string,
  outstandingBalance: string,
  accruedInterest: string,
  arrearsAmount: string,
) {
  mockPrisma.loan.findFirst.mockResolvedValueOnce(activeLoanStub);
  mockPrisma.account.findFirst.mockResolvedValueOnce({ id: ACCOUNT_ID });
  mockPrisma.member.findFirst.mockResolvedValueOnce(null);

  mockTx.$queryRaw
    .mockResolvedValueOnce([{ id: ACCOUNT_ID, balance, version: 1 }])
    .mockResolvedValueOnce([{
      id: LOAN_ID, outstandingBalance, status: LoanStatus.ACTIVE,
      accruedInterest, arrearsAmount,
    }]);

  mockTx.transaction.create.mockResolvedValueOnce({ amount: '0', id: 'txn-1' });
  mockTx.account.update.mockResolvedValueOnce({});
  mockTx.loan.update.mockResolvedValueOnce({ id: LOAN_ID, status: LoanStatus.ACTIVE });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('LoansService.repay() — SASRA waterfall', () => {
  let service: LoansService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTx = buildTxClient();

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
      ],
    }).compile();

    service = module.get<LoansService>(LoansService);
  });

  // ── No arrears / no interest — pure principal ────────────────────────────

  it('applies repayment entirely to principal when no arrears or accrued interest', async () => {
    setupRepayMocks('20000.0000', '10000.0000', '0.0000', '0.0000');

    await service.repay(LOAN_ID, 3000, TENANT_ID, PROCESSED_BY);

    const loanData = mockTx.loan.update.mock.calls[0][0].data;
    expect(parseFloat(loanData.outstandingBalance)).toBeCloseTo(7000, 1);
    expect(parseFloat(loanData.accruedInterest)).toBe(0);
    expect(parseFloat(loanData.arrearsAmount)).toBe(0);
  });

  it('returns allocation with toPrincipal = full amount when no interest/arrears', async () => {
    setupRepayMocks('20000.0000', '10000.0000', '0.0000', '0.0000');

    const result = await service.repay(LOAN_ID, 3000, TENANT_ID, PROCESSED_BY);

    expect(result.allocation.toPrincipal).toBeCloseTo(3000, 2);
    expect(result.allocation.toInterest).toBe(0);
    expect(result.allocation.toPenalties).toBe(0);
  });

  // ── Interest before principal ─────────────────────────────────────────────

  it('clears accruedInterest before touching principal', async () => {
    // outstanding=10000, accrued=500 — send 2000
    setupRepayMocks('20000.0000', '10000.0000', '500.0000', '0.0000');

    const result = await service.repay(LOAN_ID, 2000, TENANT_ID, PROCESSED_BY);

    // 500 goes to interest, 1500 goes to principal
    expect(result.allocation.toInterest).toBeCloseTo(500, 2);
    expect(result.allocation.toPrincipal).toBeCloseTo(1500, 2);
    expect(result.allocation.toPenalties).toBe(0);

    const loanData = mockTx.loan.update.mock.calls[0][0].data;
    expect(parseFloat(loanData.accruedInterest)).toBe(0);
    expect(parseFloat(loanData.outstandingBalance)).toBeCloseTo(8500, 1);
  });

  it('does not reduce principal when repayment only partially covers accrued interest', async () => {
    // outstanding=10000, accrued=1000 — send 400 (less than interest)
    setupRepayMocks('20000.0000', '10000.0000', '1000.0000', '0.0000');

    const result = await service.repay(LOAN_ID, 400, TENANT_ID, PROCESSED_BY);

    expect(result.allocation.toInterest).toBeCloseTo(400, 2);
    expect(result.allocation.toPrincipal).toBe(0);

    const loanData = mockTx.loan.update.mock.calls[0][0].data;
    expect(parseFloat(loanData.accruedInterest)).toBeCloseTo(600, 1);
    expect(parseFloat(loanData.outstandingBalance)).toBe(10000);
  });

  // ── Penalties → Interest → Principal ─────────────────────────────────────

  it('applies penalties first, then interest, then principal', async () => {
    // arrears=200, accrued=300, outstanding=10000 — send 1500
    setupRepayMocks('20000.0000', '10000.0000', '300.0000', '200.0000');

    const result = await service.repay(LOAN_ID, 1500, TENANT_ID, PROCESSED_BY);

    expect(result.allocation.toPenalties).toBeCloseTo(200, 2);
    expect(result.allocation.toInterest).toBeCloseTo(300, 2);
    expect(result.allocation.toPrincipal).toBeCloseTo(1000, 2);

    const loanData = mockTx.loan.update.mock.calls[0][0].data;
    expect(parseFloat(loanData.arrearsAmount)).toBe(0);
    expect(parseFloat(loanData.accruedInterest)).toBe(0);
    expect(parseFloat(loanData.outstandingBalance)).toBeCloseTo(9000, 1);
  });

  it('partially reduces arrears when payment does not cover all penalties', async () => {
    // arrears=1000, send only 400
    setupRepayMocks('20000.0000', '10000.0000', '0.0000', '1000.0000');

    const result = await service.repay(LOAN_ID, 400, TENANT_ID, PROCESSED_BY);

    expect(result.allocation.toPenalties).toBeCloseTo(400, 2);
    expect(result.allocation.toInterest).toBe(0);
    expect(result.allocation.toPrincipal).toBe(0);

    const loanData = mockTx.loan.update.mock.calls[0][0].data;
    expect(parseFloat(loanData.arrearsAmount)).toBeCloseTo(600, 1);
    expect(parseFloat(loanData.outstandingBalance)).toBe(10000);
  });

  // ── FULLY_PAID transition ─────────────────────────────────────────────────

  it('marks loan FULLY_PAID when repayment covers arrears + interest + principal exactly', async () => {
    // arrears=200, accrued=300, outstanding=5000 — send exact total 5500
    setupRepayMocks('20000.0000', '5000.0000', '300.0000', '200.0000');
    mockTx.loan.update.mockReset();
    mockTx.loan.update.mockResolvedValueOnce({ id: LOAN_ID, status: LoanStatus.FULLY_PAID });

    await service.repay(LOAN_ID, 5500, TENANT_ID, PROCESSED_BY);

    expect(mockTx.loan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: LoanStatus.FULLY_PAID }),
      }),
    );
  });

  it('caps repayment at totalOwed (no overpayment)', async () => {
    // totalOwed = 0 + 0 + 3000 = 3000, but sending 10000
    setupRepayMocks('20000.0000', '3000.0000', '0.0000', '0.0000');

    await service.repay(LOAN_ID, 10000, TENANT_ID, PROCESSED_BY);

    // Only 3000 should be debited from FOSA
    const txnData = mockTx.transaction.create.mock.calls[0][0].data;
    expect(parseFloat(txnData.amount)).toBeCloseTo(3000, 1);
  });

  // ── 422 guard still applies ───────────────────────────────────────────────

  it('throws 422 when FOSA balance < totalRepayment including interest', async () => {
    // outstanding=10000, accrued=500 — sending 2000 but FOSA only has 1000
    setupRepayMocks('1000.0000', '10000.0000', '500.0000', '0.0000');

    await expect(service.repay(LOAN_ID, 2000, TENANT_ID, PROCESSED_BY)).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  // ── result.newOutstandingBalance ──────────────────────────────────────────

  it('reflects the correct newOutstandingBalance after waterfall', async () => {
    // outstanding=10000, accrued=500, arrears=0 — send 3500 → 500 interest, 3000 principal
    setupRepayMocks('20000.0000', '10000.0000', '500.0000', '0.0000');

    const result = await service.repay(LOAN_ID, 3500, TENANT_ID, PROCESSED_BY);

    expect(result.newOutstandingBalance).toBeCloseTo(7000, 1);
  });
});
