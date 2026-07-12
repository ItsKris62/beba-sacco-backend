import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { LoanStatus } from '@prisma/client';
import { MemberPortalService } from '../member-portal.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { MpesaService } from '../../mpesa/mpesa.service';
import { LoansService } from '../../loans/loans.service';
import { StorageService } from '../../storage/storage.service';
import { AccountsService } from '../../accounts/accounts.service';
import { LedgerService } from '../../accounting/ledger.service';
import { IdempotencyService } from '../../../common/services/idempotency.service';
import { QUEUE_NAMES } from '../../queue/queue.constants';

// ─── Stubs ────────────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-uuid-1';
const USER_ID = 'user-uuid-1';
const MEMBER_ID = 'member-uuid-1';
const LOAN_ID = 'loan-uuid-1';

const mockPrisma = {
  member: { findFirst: jest.fn() },
  loan: { findFirst: jest.fn() },
  transaction: { findMany: jest.fn() },
  account: { findFirst: jest.fn(), findMany: jest.fn() },
  mpesaTransaction: { findFirst: jest.fn() },
  guarantor: { findMany: jest.fn() },
  loanRepayment: { findMany: jest.fn() },
  $transaction: jest.fn(),
};

const mockAudit = { create: jest.fn().mockResolvedValue(undefined) };
const mockMpesa = { initiateDeposit: jest.fn() };
const mockLoans = { respondAsGuarantor: jest.fn(), apply: jest.fn() };
const mockStorage = { getUploadUrl: jest.fn() };
const mockAccounts = {};
const mockLedger = { postEntry: jest.fn() };
const mockIdempotency = {};
const mockDisbursementQueue = { add: jest.fn() };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildMemberStub() {
  return {
    id: MEMBER_ID,
    memberNumber: 'M-000001',
    user: { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' },
  };
}

function buildLoanStub(overrides: Record<string, unknown> = {}) {
  return {
    id: LOAN_ID,
    loanNumber: 'LN-2026-000001',
    status: LoanStatus.ACTIVE,
    principalAmount: '50000.0000',
    interestRate: '0.1200',
    processingFee: '500.0000',
    tenureMonths: 12,
    gracePeriodMonths: 0,
    monthlyInstalment: '4438.9149',
    outstandingBalance: '42000.0000',
    accruedInterest: '0.0000',
    totalRepaid: '8000.0000',
    disbursedAt: new Date('2026-01-01T00:00:00Z'),
    dueDate: new Date('2027-01-01T00:00:00Z'),
    appliedAt: new Date('2025-12-15T00:00:00Z'),
    notes: null,
    loanProduct: { name: 'Development Loan', interestType: 'REDUCING_BALANCE', interestRate: '0.1200' },
    guarantors: [],
    ...overrides,
  };
}

function buildScheduleRows(count: number, dueDateFn: (i: number) => Date, status = 'PENDING') {
  return Array.from({ length: count }, (_, i) => ({
    dayNumber: i + 1,
    amountPaid: '4438.9149',
    dueDate: dueDateFn(i),
    status,
  }));
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('MemberPortalService.getLoanDetail()', () => {
  let service: MemberPortalService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemberPortalService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
        { provide: MpesaService, useValue: mockMpesa },
        { provide: LoansService, useValue: mockLoans },
        { provide: StorageService, useValue: mockStorage },
        { provide: AccountsService, useValue: mockAccounts },
        { provide: LedgerService, useValue: mockLedger },
        { provide: IdempotencyService, useValue: mockIdempotency },
        { provide: getQueueToken(QUEUE_NAMES.MPESA_DISBURSEMENT), useValue: mockDisbursementQueue },
      ],
    }).compile();

    service = module.get<MemberPortalService>(MemberPortalService);
  });

  it('throws NotFoundException when member profile not found', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce(null);

    await expect(service.getLoanDetail(LOAN_ID, USER_ID, TENANT_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(mockPrisma.loan.findFirst).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when loan not found or not owned by member', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce(buildMemberStub());
    mockPrisma.loan.findFirst.mockResolvedValueOnce(null);

    await expect(service.getLoanDetail(LOAN_ID, USER_ID, TENANT_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns loan detail with correct numeric conversions', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce(buildMemberStub());
    mockPrisma.loan.findFirst.mockResolvedValueOnce(buildLoanStub());
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);
    mockPrisma.loanRepayment.findMany.mockResolvedValueOnce([]);

    const result = await service.getLoanDetail(LOAN_ID, USER_ID, TENANT_ID);

    expect(result.id).toBe(LOAN_ID);
    expect(result.loanNumber).toBe('LN-2026-000001');
    expect(typeof result.principalAmount).toBe('number');
    expect(result.principalAmount).toBe(50000);
    expect(result.outstandingBalance).toBe(42000);
    expect(result.totalRepaid).toBe(8000);
  });

  it('reads accruedInterest from the Loan record (Tier 3)', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce(buildMemberStub());
    mockPrisma.loan.findFirst.mockResolvedValueOnce(buildLoanStub({ accruedInterest: '1200.0000' }));
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);
    mockPrisma.loanRepayment.findMany.mockResolvedValueOnce([]);

    const result = await service.getLoanDetail(LOAN_ID, USER_ID, TENANT_ID);
    expect(result.accruedInterest).toBe(1200);
  });

  it('computes totalAmountDue = outstandingBalance + accruedInterest', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce(buildMemberStub());
    mockPrisma.loan.findFirst.mockResolvedValueOnce(buildLoanStub({ accruedInterest: '500.0000' }));
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);
    mockPrisma.loanRepayment.findMany.mockResolvedValueOnce([]);

    const result = await service.getLoanDetail(LOAN_ID, USER_ID, TENANT_ID);
    expect(result.totalAmountDue).toBe(result.outstandingBalance + result.accruedInterest);
    expect(result.totalAmountDue).toBe(42500);
  });

  it('attaches last 5 transactions with numeric amounts', async () => {
    const txns = Array.from({ length: 3 }, (_, i) => ({
      id: `txn-uuid-${i}`,
      type: 'LOAN_REPAYMENT',
      status: 'COMPLETED',
      amount: '4000.0000',
      balanceBefore: '46000.0000',
      balanceAfter: '42000.0000',
      reference: `REPAY-${i}`,
      description: 'Loan repayment',
      createdAt: new Date(),
    }));

    mockPrisma.member.findFirst.mockResolvedValueOnce(buildMemberStub());
    mockPrisma.loan.findFirst.mockResolvedValueOnce(buildLoanStub());
    mockPrisma.transaction.findMany.mockResolvedValueOnce(txns);
    mockPrisma.loanRepayment.findMany.mockResolvedValueOnce([]);

    const result = await service.getLoanDetail(LOAN_ID, USER_ID, TENANT_ID);

    expect(result.recentTransactions).toHaveLength(3);
    expect(typeof result.recentTransactions[0].amount).toBe('number');
    expect(result.recentTransactions[0].amount).toBe(4000);
  });

  it('returns repaymentSchedule from LoanRepayment rows (Tier 3)', async () => {
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);
    const scheduleRows = buildScheduleRows(12, () => futureDate);

    mockPrisma.member.findFirst.mockResolvedValueOnce(buildMemberStub());
    mockPrisma.loan.findFirst.mockResolvedValueOnce(buildLoanStub({ tenureMonths: 12 }));
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);
    mockPrisma.loanRepayment.findMany.mockResolvedValueOnce(scheduleRows);

    const result = await service.getLoanDetail(LOAN_ID, USER_ID, TENANT_ID);

    expect(result.repaymentSchedule).toHaveLength(12);
    expect(result.repaymentSchedule[0]).toMatchObject({
      month: 1,
      expectedAmount: expect.any(Number),
      status: expect.stringMatching(/^(PAID|OVERDUE|UPCOMING)$/),
    });
  });

  it('returns empty repaymentSchedule when no LoanRepayment rows exist', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce(buildMemberStub());
    mockPrisma.loan.findFirst.mockResolvedValueOnce(
      buildLoanStub({ disbursedAt: null, status: LoanStatus.APPROVED }),
    );
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);
    mockPrisma.loanRepayment.findMany.mockResolvedValueOnce([]);

    const result = await service.getLoanDetail(LOAN_ID, USER_ID, TENANT_ID);
    expect(result.repaymentSchedule).toHaveLength(0);
  });

  it('marks schedule entries as OVERDUE when paymentDate is in the past', async () => {
    const pastDate = new Date('2024-01-01');
    const scheduleRows = buildScheduleRows(12, () => pastDate, 'PENDING');

    mockPrisma.member.findFirst.mockResolvedValueOnce(buildMemberStub());
    mockPrisma.loan.findFirst.mockResolvedValueOnce(buildLoanStub());
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);
    mockPrisma.loanRepayment.findMany.mockResolvedValueOnce(scheduleRows);

    const result = await service.getLoanDetail(LOAN_ID, USER_ID, TENANT_ID);
    expect(result.repaymentSchedule.every((e) => e.status === 'OVERDUE')).toBe(true);
  });

  it('marks schedule entries as UPCOMING when paymentDate is in the future', async () => {
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 2);
    const scheduleRows = buildScheduleRows(3, () => futureDate, 'PENDING');

    mockPrisma.member.findFirst.mockResolvedValueOnce(buildMemberStub());
    mockPrisma.loan.findFirst.mockResolvedValueOnce(buildLoanStub());
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);
    mockPrisma.loanRepayment.findMany.mockResolvedValueOnce(scheduleRows);

    const result = await service.getLoanDetail(LOAN_ID, USER_ID, TENANT_ID);
    expect(result.repaymentSchedule.every((e) => e.status === 'UPCOMING')).toBe(true);
  });

  it('marks schedule entries as PAID when status is PAID', async () => {
    const anyDate = new Date('2024-01-01'); // past, but status=PAID overrides the date-based OVERDUE check
    const scheduleRows = buildScheduleRows(2, () => anyDate, 'PAID');

    mockPrisma.member.findFirst.mockResolvedValueOnce(buildMemberStub());
    mockPrisma.loan.findFirst.mockResolvedValueOnce(buildLoanStub());
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);
    mockPrisma.loanRepayment.findMany.mockResolvedValueOnce(scheduleRows);

    const result = await service.getLoanDetail(LOAN_ID, USER_ID, TENANT_ID);
    expect(result.repaymentSchedule.every((e) => e.status === 'PAID')).toBe(true);
  });

  it('maps guarantors with memberName and numeric guaranteedAmount', async () => {
    const loanWithGuarantors = buildLoanStub({
      guarantors: [
        {
          status: 'ACCEPTED',
          guaranteedAmount: '25000.0000',
          member: {
            memberNumber: 'M-000002',
            user: { firstName: 'John', lastName: 'Smith' },
          },
        },
      ],
    });

    mockPrisma.member.findFirst.mockResolvedValueOnce(buildMemberStub());
    mockPrisma.loan.findFirst.mockResolvedValueOnce(loanWithGuarantors);
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);
    mockPrisma.loanRepayment.findMany.mockResolvedValueOnce([]);

    const result = await service.getLoanDetail(LOAN_ID, USER_ID, TENANT_ID);

    expect(result.guarantors[0].memberName).toBe('John Smith');
    expect(result.guarantors[0].guaranteedAmount).toBe(25000);
  });

  it('queries loan with tenantId + memberId ownership check', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce(buildMemberStub());
    mockPrisma.loan.findFirst.mockResolvedValueOnce(buildLoanStub());
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);
    mockPrisma.loanRepayment.findMany.mockResolvedValueOnce([]);

    await service.getLoanDetail(LOAN_ID, USER_ID, TENANT_ID);

    expect(mockPrisma.loan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: LOAN_ID,
          tenantId: TENANT_ID,
          memberId: MEMBER_ID,
        }),
      }),
    );
  });

  it('queries loanRepayment with loanId + tenantId, ordered by dayNumber', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce(buildMemberStub());
    mockPrisma.loan.findFirst.mockResolvedValueOnce(buildLoanStub());
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]);
    mockPrisma.loanRepayment.findMany.mockResolvedValueOnce([]);

    await service.getLoanDetail(LOAN_ID, USER_ID, TENANT_ID);

    expect(mockPrisma.loanRepayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ loanId: LOAN_ID, tenantId: TENANT_ID }),
        orderBy: { dayNumber: 'asc' },
      }),
    );
  });
});
