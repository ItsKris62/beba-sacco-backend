import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Request } from 'express';
import { MemberPortalController } from '../member-portal.controller';
import { MembersService } from '../members.service';
import { MemberPortalService } from '../member-portal.service';
import { LoansService } from '../../loans/loans.service';
import { LoanApplicationService } from '../../loans/loan-application.service';
import { MpesaService } from '../../mpesa/mpesa.service';
import { StatementService } from '../../statements/statement.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { MemberApplyLoanDto } from '../../loans/dto/member-apply-loan.dto';
import { DashboardService } from '../../dashboard/dashboard.service';
import { DocumentsService } from '../../documents/documents.service';

// ─── Minimal stubs for module providers ──────────────────────────────────────

const mockPrisma = {
  member: { findFirst: jest.fn() },
  account: { findMany: jest.fn() },
  loan: { findMany: jest.fn(), findFirst: jest.fn() },
  mpesaTransaction: { findMany: jest.fn() },
};

const mockLoansService = {
  apply: jest.fn(),    // should NOT be called from member portal apply
  repay: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
};

const mockLoanAppService = {
  memberApply: jest.fn(),
  inviteGuarantors: jest.fn(),
  getGuarantorStatus: jest.fn(),
  guarantorResponse: jest.fn(),
};

const mockMpesaService = { initiateDeposit: jest.fn() };
const mockStatementService = { getFosaStatement: jest.fn() };
const mockMembersService = {};
const mockPortalService = { getLoanDetail: jest.fn() };
const mockDashboardService = { getMemberDashboard: jest.fn() };
const mockDocumentsService = {
  listMemberDocuments: jest.fn(),
  requestMemberUploadUrl: jest.fn(),
  confirmMemberUpload: jest.fn(),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildUser(overrides = {}) {
  return { id: 'user-uuid-1', role: 'MEMBER', tenantId: 'tenant-uuid-1', ...overrides };
}

function buildTenant(overrides = {}) {
  return { id: 'tenant-uuid-1', ...overrides };
}

function buildRequest(overrides: Partial<Request> = {}): Request {
  return {
    ip: '127.0.0.1',
    headers: {},
    ...overrides,
  } as unknown as Request;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('MemberPortalController — POST /members/loans/apply', () => {
  let controller: MemberPortalController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MemberPortalController],
      providers: [
        { provide: MembersService, useValue: mockMembersService },
        { provide: MemberPortalService, useValue: mockPortalService },
        { provide: LoansService, useValue: mockLoansService },
        { provide: LoanApplicationService, useValue: mockLoanAppService },
        { provide: MpesaService, useValue: mockMpesaService },
        { provide: StatementService, useValue: mockStatementService },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: DashboardService, useValue: mockDashboardService },
        { provide: DocumentsService, useValue: mockDocumentsService },
      ],
    }).compile();

    controller = module.get<MemberPortalController>(MemberPortalController);
  });

  // ── Routing correctness ────────────────────────────────────────────────────

  it('should call loanApp.memberApply() — NOT loans.apply()', async () => {
    const memberId = 'member-uuid-1';
    mockPrisma.member.findFirst.mockResolvedValueOnce({ id: memberId });
    mockLoanAppService.memberApply.mockResolvedValueOnce({ id: 'loan-uuid-1', loanNumber: 'LN-2026-000001' });

    const dto: MemberApplyLoanDto = {
      loanProductId: 'product-uuid-1',
      principalAmount: 50000,
      tenureMonths: 12,
      purpose: 'School fees',
    };

    await controller.applyLoan(dto, buildUser() as any, buildTenant() as any, buildRequest());

    expect(mockLoanAppService.memberApply).toHaveBeenCalledTimes(1);
    expect(mockLoansService.apply).not.toHaveBeenCalled();
  });

  it('should resolve memberId from JWT — not from request body', async () => {
    const resolvedMemberId = 'member-uuid-from-jwt';
    mockPrisma.member.findFirst.mockResolvedValueOnce({ id: resolvedMemberId });
    mockLoanAppService.memberApply.mockResolvedValueOnce({ id: 'loan-uuid-1' });

    const dto: MemberApplyLoanDto = {
      loanProductId: 'product-uuid-1',
      principalAmount: 50000,
      tenureMonths: 12,
      purpose: 'Business',
    };

    await controller.applyLoan(dto, buildUser({ id: 'user-uuid-1' }) as any, buildTenant() as any, buildRequest());

    // memberApply should receive the DB-resolved memberId, not anything from the DTO
    expect(mockLoanAppService.memberApply).toHaveBeenCalledWith(
      dto,                 // original DTO without memberId injection
      'tenant-uuid-1',
      resolvedMemberId,    // resolved from DB, not DTO
      'user-uuid-1',       // userId from JWT
      expect.any(Object),  // req
      undefined,           // no idempotency key in this test
    );
  });

  it('should forward Idempotency-Key header to memberApply()', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce({ id: 'member-uuid-1' });
    mockLoanAppService.memberApply.mockResolvedValueOnce({ id: 'loan-uuid-1' });

    const dto: MemberApplyLoanDto = {
      loanProductId: 'product-uuid-1',
      principalAmount: 30000,
      tenureMonths: 6,
      purpose: 'Emergency',
    };
    const idempotencyKey = '550e8400-e29b-41d4-a716-446655440000';

    await controller.applyLoan(
      dto,
      buildUser() as any,
      buildTenant() as any,
      buildRequest({ headers: { 'idempotency-key': idempotencyKey } }),
    );

    expect(mockLoanAppService.memberApply).toHaveBeenCalledWith(
      dto,
      'tenant-uuid-1',
      'member-uuid-1',
      'user-uuid-1',
      expect.any(Object),
      idempotencyKey,      // ← idempotency key must be forwarded
    );
  });

  it('should NOT inject memberId into the DTO (prevents member spoofing)', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce({ id: 'member-uuid-1' });
    mockLoanAppService.memberApply.mockResolvedValueOnce({ id: 'loan-uuid-1' });

    const dto: MemberApplyLoanDto = {
      loanProductId: 'product-uuid-1',
      principalAmount: 50000,
      tenureMonths: 12,
      purpose: 'Farming',
    };

    await controller.applyLoan(dto, buildUser() as any, buildTenant() as any, buildRequest());

    // The DTO passed to memberApply must NOT have a memberId property added
    const passedDto = (mockLoanAppService.memberApply as jest.Mock).mock.calls[0][0];
    expect(passedDto).not.toHaveProperty('memberId');
  });

  // ── Error propagation ──────────────────────────────────────────────────────

  it('should bubble up errors from memberApply()', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce({ id: 'member-uuid-1' });
    mockLoanAppService.memberApply.mockRejectedValueOnce(
      new NotFoundException('Loan product not found or inactive'),
    );

    const dto: MemberApplyLoanDto = {
      loanProductId: 'non-existent-product',
      principalAmount: 50000,
      tenureMonths: 12,
      purpose: 'Test',
    };

    await expect(
      controller.applyLoan(dto, buildUser() as any, buildTenant() as any, buildRequest()),
    ).rejects.toThrow(NotFoundException);
  });

  it('should let a member request guarantors for their own pending loan', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce({ id: 'member-uuid-1' });
    mockPrisma.loan.findFirst.mockResolvedValueOnce({
      id: 'loan-uuid-1',
      status: 'DRAFT',
      principalAmount: '90000',
      loanProduct: { minGuarantors: 3, guarantorCoverageRatio: '1.0' },
      guarantors: [],
    });
    mockLoanAppService.inviteGuarantors.mockResolvedValueOnce({ loanId: 'loan-uuid-1', invitedCount: 3 });

    await controller.requestGuarantors(
      'loan-uuid-1',
      { guarantorIds: ['guarantor-uuid-1', 'guarantor-uuid-2', 'guarantor-uuid-3'] },
      buildUser() as any,
      buildTenant() as any,
      buildRequest(),
    );

    expect(mockLoanAppService.inviteGuarantors).toHaveBeenCalledWith(
      'loan-uuid-1',
      [
        { memberId: 'guarantor-uuid-1', guaranteedAmount: 30000 },
        { memberId: 'guarantor-uuid-2', guaranteedAmount: 30000 },
        { memberId: 'guarantor-uuid-3', guaranteedAmount: 30000 },
      ],
      'tenant-uuid-1',
      'user-uuid-1',
      expect.any(Object),
    );
  });
});
