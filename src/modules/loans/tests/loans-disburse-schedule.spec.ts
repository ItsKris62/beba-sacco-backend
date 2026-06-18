import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
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

// ─── Transaction mock ──────────────────────────────────────────────────────────
//
// disburse() runs inside a $transaction callback that uses:
//   tx.$queryRaw           (Account FOR UPDATE)
//   tx.transaction.create  (disbursement GL entry)
//   tx.account.update      (balance + version)
//   tx.loan.update         (status, disbursedAt, repaymentScheduleGenerated)
//   tx.loanRepayment.createMany  (NEW — Tier 3 schedule generation)

type TxClient = {
  $queryRaw: jest.Mock;
  transaction: { create: jest.Mock; findUnique: jest.Mock };
  account: { update: jest.Mock };
  loan: { update: jest.Mock };
  loanRepayment: { createMany: jest.Mock };
  auditLog: { create: jest.Mock };
};

function buildTxClient(overrides: Partial<TxClient> = {}): TxClient {
  return {
    $queryRaw: jest.fn(),
    transaction: { create: jest.fn(), findUnique: jest.fn().mockResolvedValue(null) },
    account: { update: jest.fn() },
    loan: { update: jest.fn() },
    loanRepayment: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    ...overrides,
  };
}

// ─── Stubs ────────────────────────────────────────────────────────────────────

let mockTx: TxClient;

const mockPrisma = {
  loan: { findFirst: jest.fn() },
  member: { findFirst: jest.fn() },
  account: { findFirst: jest.fn() },
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
const DISBURSED_BY = 'user-uuid-1';

function buildApprovedLoan(overrides = {}) {
  return {
    id: LOAN_ID,
    status: LoanStatus.APPROVED,
    loanNumber: 'LN-2026-000001',
    principalAmount: '50000.0000',
    processingFee: '0.0000',
    memberId: MEMBER_ID,
    tenureMonths: 12,
    gracePeriodMonths: 0,
    monthlyInstalment: '4438.9149',
    repaymentScheduleGenerated: false,
    member: { user: { email: 'jane@example.com', firstName: 'Jane' } },
    ...overrides,
  };
}

function setupDisburseMocks(loanOverrides = {}) {
  mockPrisma.loan.findFirst.mockResolvedValueOnce(buildApprovedLoan(loanOverrides));
  mockPrisma.member.findFirst.mockResolvedValueOnce({ kycStatus: 'APPROVED' });
  mockPrisma.account.findFirst.mockResolvedValueOnce({ id: ACCOUNT_ID, balance: '0.0000', version: 1 });
  mockTx.$queryRaw
    .mockResolvedValueOnce([
      {
        id: LOAN_ID,
        status: LoanStatus.APPROVED,
        principalAmount: '50000.0000',
        processingFee: '0.0000',
        tenureMonths: 12,
        gracePeriodMonths: 0,
        monthlyInstalment: '4438.9149',
        repaymentScheduleGenerated: false,
        ...loanOverrides,
      },
    ])
    .mockResolvedValueOnce([{ id: ACCOUNT_ID, balance: '0.0000', version: 1 }]);
  mockTx.transaction.create.mockResolvedValue({ id: 'txn-uuid-1', amount: '50000.0000' });
  mockTx.account.update.mockResolvedValueOnce({});
  mockTx.loan.update.mockResolvedValueOnce({
    id: LOAN_ID, status: LoanStatus.ACTIVE, repaymentScheduleGenerated: true,
  });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('LoansService.disburse() — schedule generation', () => {
  let service: LoansService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTx = buildTxClient();
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
      ],
    }).compile();

    service = module.get<LoansService>(LoansService);
  });

  // ── Schedule generation ───────────────────────────────────────────────────

  it('calls loanRepayment.createMany() with tenureMonths entries', async () => {
    setupDisburseMocks({ tenureMonths: 6 });

    await service.disburse(LOAN_ID, TENANT_ID, DISBURSED_BY);

    expect(mockTx.loanRepayment.createMany).toHaveBeenCalledTimes(1);
    const { data } = mockTx.loanRepayment.createMany.mock.calls[0][0];
    expect(data).toHaveLength(6);
  });

  it('assigns dayNumber 1 through tenureMonths', async () => {
    setupDisburseMocks({ tenureMonths: 3 });

    await service.disburse(LOAN_ID, TENANT_ID, DISBURSED_BY);

    const { data } = mockTx.loanRepayment.createMany.mock.calls[0][0];
    expect(data.map((r: any) => r.dayNumber)).toEqual([1, 2, 3]);
  });

  it('sets amountPaid to monthlyInstalment for each entry', async () => {
    setupDisburseMocks({ tenureMonths: 2, monthlyInstalment: '4438.9149' });

    await service.disburse(LOAN_ID, TENANT_ID, DISBURSED_BY);

    const { data } = mockTx.loanRepayment.createMany.mock.calls[0][0];
    data.forEach((r: any) => {
      expect(parseFloat(r.amountPaid)).toBeCloseTo(4438.91, 1);
    });
  });

  it('sets status PENDING and method SCHEDULED on schedule entries', async () => {
    setupDisburseMocks({ tenureMonths: 1 });

    await service.disburse(LOAN_ID, TENANT_ID, DISBURSED_BY);

    const { data } = mockTx.loanRepayment.createMany.mock.calls[0][0];
    expect(data[0].status).toBe('PENDING');
    expect(data[0].method).toBe('SCHEDULED');
  });

  it('includes tenantId and loanId in every schedule entry', async () => {
    setupDisburseMocks({ tenureMonths: 2 });

    await service.disburse(LOAN_ID, TENANT_ID, DISBURSED_BY);

    const { data } = mockTx.loanRepayment.createMany.mock.calls[0][0];
    data.forEach((r: any) => {
      expect(r.tenantId).toBe(TENANT_ID);
      expect(r.loanId).toBe(LOAN_ID);
    });
  });

  it('uses skipDuplicates: true for idempotency', async () => {
    setupDisburseMocks({ tenureMonths: 2 });

    await service.disburse(LOAN_ID, TENANT_ID, DISBURSED_BY);

    expect(mockTx.loanRepayment.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  it('credits net disbursement after processing fee while recording gross loan and fee transactions', async () => {
    setupDisburseMocks({ principalAmount: '100000.0000', processingFee: '5000.0000' });

    await service.disburse(LOAN_ID, TENANT_ID, DISBURSED_BY);

    expect(mockTx.account.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ balance: '95000' }),
      }),
    );
    expect(mockTx.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'LOAN_DISBURSEMENT',
          amount: '100000',
          balanceAfter: '100000',
        }),
      }),
    );
    expect(mockTx.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'FEE_CHARGE',
          amount: '-5000',
          balanceAfter: '95000',
        }),
      }),
    );
  });

  it('sets repaymentScheduleGenerated: true in the loan update', async () => {
    setupDisburseMocks({ tenureMonths: 3 });

    await service.disburse(LOAN_ID, TENANT_ID, DISBURSED_BY);

    expect(mockTx.loan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ repaymentScheduleGenerated: true }),
      }),
    );
  });

  it('skips createMany when repaymentScheduleGenerated is already true', async () => {
    setupDisburseMocks({ repaymentScheduleGenerated: true });

    await service.disburse(LOAN_ID, TENANT_ID, DISBURSED_BY);

    expect(mockTx.loanRepayment.createMany).not.toHaveBeenCalled();
  });

  it('accounts for gracePeriodMonths when computing paymentDate', async () => {
    setupDisburseMocks({ tenureMonths: 2, gracePeriodMonths: 3 });

    await service.disburse(LOAN_ID, TENANT_ID, DISBURSED_BY);

    const { data } = mockTx.loanRepayment.createMany.mock.calls[0][0];
    // paymentDate for month 1 = disbursedAt + grace(3) + 1 = +4 months
    const disbursedAt = new Date();
    const expectedMonth1 = new Date(disbursedAt);
    expectedMonth1.setMonth(expectedMonth1.getMonth() + 3 + 1);

    const actualMonth1: Date = data[0].paymentDate;
    // Compare year+month only (seconds may differ slightly within the test run)
    expect(actualMonth1.getFullYear()).toBe(expectedMonth1.getFullYear());
    expect(actualMonth1.getMonth()).toBe(expectedMonth1.getMonth());
  });

  // ── Guard: pre-flight errors still propagate ──────────────────────────────

  it('throws NotFoundException when loan not found', async () => {
    mockPrisma.loan.findFirst.mockResolvedValueOnce(null);
    await expect(service.disburse(LOAN_ID, TENANT_ID, DISBURSED_BY)).rejects.toThrow(NotFoundException);
    expect(mockTx.loanRepayment.createMany).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when KYC not approved', async () => {
    mockPrisma.loan.findFirst.mockResolvedValueOnce(buildApprovedLoan());
    mockPrisma.member.findFirst.mockResolvedValueOnce({ kycStatus: 'PENDING' });
    await expect(service.disburse(LOAN_ID, TENANT_ID, DISBURSED_BY)).rejects.toThrow(BadRequestException);
    expect(mockTx.loanRepayment.createMany).not.toHaveBeenCalled();
  });
});
