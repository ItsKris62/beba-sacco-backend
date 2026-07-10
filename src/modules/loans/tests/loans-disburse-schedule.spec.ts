import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Decimal } from 'decimal.js';
import { LoanStatus } from '@prisma/client';
import { LoansService } from '../loans.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { RedisService } from '../../../common/services/redis.service';
import { CacheService } from '../../../common/services/cache.service';
import { IdempotencyService } from '../../../common/services/idempotency.service';
import { QUEUE_NAMES } from '../../queue/queue.constants';
import { DisbursementGateService } from '../../../loans/disbursement-gate.service';
import { ProductRuleService } from '../product-rule.service';
import { LedgerService } from '../../accounting/ledger.service';
import { ApprovalChainService } from '../../fraud/approval-chain.service';
import { BehavioralRiskScorerService } from '../../fraud/risk-scorer/behavioral-risk-scorer.service';

// ─── Transaction mock ──────────────────────────────────────────────────────────
//
// disburse() runs inside a $transaction callback that uses:
//   tx.$queryRaw           (Loan FOR UPDATE)
//   this.ledger.postEntry  (principal credit + fee debit, GL + Account balance)
//   tx.loan.update         (status, disbursedAt, repaymentScheduleGenerated)
//   tx.loanRepayment.createMany  (Tier 3 schedule generation)

type TxClient = {
  $queryRaw: jest.Mock;
  transaction: { create: jest.Mock; findFirst: jest.Mock };
  account: { update: jest.Mock };
  loan: { update: jest.Mock };
  loanRepayment: { createMany: jest.Mock };
  auditLog: { create: jest.Mock };
};

function buildTxClient(overrides: Partial<TxClient> = {}): TxClient {
  return {
    $queryRaw: jest.fn(),
    transaction: { create: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
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
  transaction: { findFirst: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: TxClient) => Promise<unknown>) => cb(mockTx)),
  direct: undefined as undefined,
};

const mockAudit = { create: jest.fn().mockResolvedValue(undefined) };
const mockRedis = {};
const mockCache = { invalidateTenantDashboard: jest.fn().mockResolvedValue(undefined) };
const mockIdempotency = {};
const mockGuarantorQueue = { add: jest.fn().mockResolvedValue(undefined) };
const mockEmailQueue = { add: jest.fn().mockResolvedValue(undefined) };
const mockDisbursementGate = { assertPassed: jest.fn().mockResolvedValue(undefined) };
const mockProductRules = {};
const mockLedger = { postEntry: jest.fn() };
const mockApprovalChain = { isChainApproved: jest.fn().mockResolvedValue(true) };
const mockRiskScorer = {};

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
    dueDate: null,
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

/**
 * mockLedger.postEntry() tracks a running FOSA balance across sequential calls
 * within one disburse() invocation (principal credit, then fee debit), the same
 * way the real LedgerService.applyBalanceChange() would inside the shared tx.
 */
function mockLedgerBalanceTracking(startingBalance = '0') {
  let balance = new Decimal(startingBalance);
  let counter = 0;
  mockLedger.postEntry.mockImplementation(async (params: { amount: Decimal; direction: 'DEBIT' | 'CREDIT' }) => {
    const balanceBefore = balance;
    balance = params.direction === 'CREDIT' ? balance.plus(params.amount) : balance.minus(params.amount);
    counter += 1;
    return {
      transaction: {
        id: `txn-uuid-${counter}`,
        balanceBefore: balanceBefore.toDecimalPlaces(4).toString(),
        balanceAfter: balance.toDecimalPlaces(4).toString(),
      },
      journalEntry: { id: `je-uuid-${counter}` },
    };
  });
}

function setupDisburseMocks(loanOverrides: Record<string, unknown> = {}) {
  mockPrisma.loan.findFirst.mockResolvedValueOnce(buildApprovedLoan(loanOverrides));
  mockPrisma.member.findFirst.mockResolvedValueOnce({ kycStatus: 'APPROVED' });
  mockPrisma.account.findFirst.mockResolvedValueOnce({ id: ACCOUNT_ID });
  mockTx.$queryRaw.mockResolvedValueOnce([
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
  ]);
  mockTx.loan.update.mockResolvedValueOnce({
    id: LOAN_ID, status: LoanStatus.ACTIVE, repaymentScheduleGenerated: true,
  });
  mockLedgerBalanceTracking('0');
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
        { provide: CacheService, useValue: mockCache },
        { provide: IdempotencyService, useValue: mockIdempotency },
        { provide: getQueueToken(QUEUE_NAMES.LOAN_GUARANTOR_REMINDER), useValue: mockGuarantorQueue },
        { provide: getQueueToken(QUEUE_NAMES.EMAIL), useValue: mockEmailQueue },
        { provide: DisbursementGateService, useValue: mockDisbursementGate },
        { provide: ProductRuleService, useValue: mockProductRules },
        { provide: LedgerService, useValue: mockLedger },
        { provide: ApprovalChainService, useValue: mockApprovalChain },
        { provide: BehavioralRiskScorerService, useValue: mockRiskScorer },
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

  it('credits net disbursement after processing fee, posting principal and fee as separate LedgerService entries', async () => {
    setupDisburseMocks({ principalAmount: '100000.0000', processingFee: '5000.0000' });

    const result = await service.disburse(LOAN_ID, TENANT_ID, DISBURSED_BY);

    expect(mockLedger.postEntry).toHaveBeenCalledTimes(2);
    expect(mockLedger.postEntry).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        journalType: 'LOAN_DISBURSEMENT',
        direction: 'CREDIT',
        accountId: ACCOUNT_ID,
        loanId: LOAN_ID,
        reference: `LOAN-DISBURSEMENT-${LOAN_ID}`,
      }),
    );
    expect(mockLedger.postEntry).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        journalType: 'FEE_CHARGE',
        direction: 'DEBIT',
        accountId: ACCOUNT_ID,
        loanId: LOAN_ID,
        reference: `LOAN-DISBURSEMENT-${LOAN_ID}-FEE`,
      }),
    );
    // Net disbursement: +100000 principal, -5000 fee = 95000.
    expect(result.newBalance).toBe(95000);
  });

  it('skips the fee posting entirely when processingFee is zero', async () => {
    setupDisburseMocks({ principalAmount: '50000.0000', processingFee: '0.0000' });

    const result = await service.disburse(LOAN_ID, TENANT_ID, DISBURSED_BY);

    expect(mockLedger.postEntry).toHaveBeenCalledTimes(1);
    expect(result.newBalance).toBe(50000);
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

  // ── Idempotent replay ─────────────────────────────────────────────────────

  it('replays the existing disbursement result instead of re-disbursing when the loan is already ACTIVE', async () => {
    mockPrisma.loan.findFirst.mockResolvedValueOnce(buildApprovedLoan({ status: LoanStatus.ACTIVE }));
    mockPrisma.transaction.findFirst
      .mockResolvedValueOnce({ id: 'txn-existing-principal', balanceAfter: '50000.0000', createdAt: new Date() })
      .mockResolvedValueOnce({ id: 'txn-existing-fee', balanceAfter: '48000.0000', createdAt: new Date() });

    const result = await service.disburse(LOAN_ID, TENANT_ID, DISBURSED_BY);

    expect(result.newBalance).toBe(48000);
    expect(result.disbursement_status).toBe('COMPLETED');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockLedger.postEntry).not.toHaveBeenCalled();
  });

  it('throws ConflictException if the loan is ACTIVE but its disbursement transaction is missing (data inconsistency)', async () => {
    mockPrisma.loan.findFirst.mockResolvedValueOnce(buildApprovedLoan({ status: LoanStatus.ACTIVE }));
    mockPrisma.transaction.findFirst.mockResolvedValueOnce(null);

    await expect(service.disburse(LOAN_ID, TENANT_ID, DISBURSED_BY)).rejects.toThrow(ConflictException);
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
