import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Request } from 'express';
import { LoanAdminController } from '../loan-admin.controller';
import { LoanApplicationService } from '../loan-application.service';
import { LoansService } from '../loans.service';
import { LoanReviewService } from '../loan-review.service';
import { LoanRecoveryService } from '../loan-recovery.service';
import { AdminLoanStatus, UpdateLoanStatusDto } from '../dto/update-loan-status.dto';
import { LoanDecision, LoanDecisionDto } from '../dto/loan-decision.dto';
import { ReviewLoanAction } from '../dto/review-loan.dto';
import { PrismaService } from '../../../prisma/prisma.service';

// ─── Stubs ───────────────────────────────────────────────────────────────────

const mockLoansService = {
  disburse: jest.fn(),
  getPendingApprovalQueue: jest.fn(),
};

const mockLoanAppService = {
  updateStatus: jest.fn(),
  getGuarantorExposure: jest.fn(),
};
const mockPrisma = { loan: { findFirst: jest.fn() } };
const mockLoanReviewService = { process: jest.fn() };
const mockLoanRecoveryService = { initiateRecovery: jest.fn() };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildActor(overrides = {}) {
  return { id: 'actor-uuid-1', role: 'MANAGER', tenantId: 'tenant-uuid-1', ...overrides };
}

function buildTenant(overrides = {}) {
  return { id: 'tenant-uuid-1', ...overrides };
}

function buildRequest(ip = '127.0.0.1'): Request {
  return { ip, headers: {} } as unknown as Request;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('LoanAdminController — PATCH /admin/loans/:id/status', () => {
  let controller: LoanAdminController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [LoanAdminController],
      providers: [
        { provide: LoanApplicationService, useValue: mockLoanAppService },
        { provide: LoansService, useValue: mockLoansService },
        { provide: LoanReviewService, useValue: mockLoanReviewService },
        { provide: LoanRecoveryService, useValue: mockLoanRecoveryService },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    controller = module.get<LoanAdminController>(LoanAdminController);
  });

  // ── DISBURSED routing ─────────────────────────────────────────────────────

  it('routes DISBURSED to loans.disburse() — NOT loanApp.updateStatus()', async () => {
    const loanId = 'loan-uuid-1';
    const actor = buildActor();
    const tenant = buildTenant();
    const req = buildRequest('10.0.0.1');
    const disbursalResult = { loan: { id: loanId, status: 'ACTIVE' }, newBalance: 50000 };

    mockLoansService.disburse.mockResolvedValueOnce(disbursalResult);

    const dto: UpdateLoanStatusDto = { status: AdminLoanStatus.DISBURSED };
    const result = await controller.updateStatus(loanId, dto, tenant as any, actor as any, req);

    expect(result).toBe(disbursalResult);
    expect(mockLoansService.disburse).toHaveBeenCalledTimes(1);
    expect(mockLoansService.disburse).toHaveBeenCalledWith(
      loanId,
      tenant.id,
      actor.id,
      req.ip,
    );
    expect(mockLoanAppService.updateStatus).not.toHaveBeenCalled();
  });

  it('passes req.ip to disburse() — not a hardcoded string', async () => {
    const clientIp = '197.156.78.5';
    mockLoansService.disburse.mockResolvedValueOnce({ loan: {}, newBalance: 0 });

    const dto: UpdateLoanStatusDto = { status: AdminLoanStatus.DISBURSED };
    await controller.updateStatus(
      'loan-uuid-1',
      dto,
      buildTenant() as any,
      buildActor() as any,
      buildRequest(clientIp),
    );

    expect(mockLoansService.disburse).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      clientIp,
    );
  });

  it('bubbles up ConflictException (409) when loan is already ACTIVE', async () => {
    mockLoansService.disburse.mockRejectedValueOnce(
      new ConflictException('Loan LN-2026-000001 has already been disbursed and is ACTIVE.'),
    );

    const dto: UpdateLoanStatusDto = { status: AdminLoanStatus.DISBURSED };

    await expect(
      controller.updateStatus(
        'loan-uuid-1',
        dto,
        buildTenant() as any,
        buildActor() as any,
        buildRequest(),
      ),
    ).rejects.toThrow(ConflictException);
  });

  // ── Non-DISBURSED workflow routing ────────────────────────────────────────

  it.each([
    AdminLoanStatus.PENDING_GUARANTORS,
    AdminLoanStatus.PENDING_REVIEW,
    AdminLoanStatus.APPROVED,
    AdminLoanStatus.REJECTED,
  ])('routes %s to loanApp.updateStatus() — NOT loans.disburse()', async (status) => {
    const loanId = 'loan-uuid-2';
    const actor = buildActor();
    const tenant = buildTenant();
    const req = buildRequest();
    const workflowResult = { id: loanId, status };

    mockLoanAppService.updateStatus.mockResolvedValueOnce(workflowResult);

    const dto: UpdateLoanStatusDto = { status };
    const result = await controller.updateStatus(loanId, dto, tenant as any, actor as any, req);

    expect(result).toBe(workflowResult);
    expect(mockLoanAppService.updateStatus).toHaveBeenCalledTimes(1);
    expect(mockLoanAppService.updateStatus).toHaveBeenCalledWith(
      loanId,
      dto,
      tenant.id,
      actor,
      req,
    );
    expect(mockLoansService.disburse).not.toHaveBeenCalled();
  });

  it('bubbles up BadRequestException from loanApp.updateStatus()', async () => {
    mockLoanAppService.updateStatus.mockRejectedValueOnce(
      new BadRequestException('Invalid status transition'),
    );

    const dto: UpdateLoanStatusDto = { status: AdminLoanStatus.APPROVED };
    await expect(
      controller.updateStatus(
        'loan-uuid-1',
        dto,
        buildTenant() as any,
        buildActor() as any,
        buildRequest(),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  // ── LoanGuarantor exposure ────────────────────────────────────────────────────

  it('getGuarantorExposure delegates to loanApp.getGuarantorExposure()', async () => {
    const memberId = 'member-uuid-1';
    const tenant = buildTenant();
    const exposureResult = { memberId, canGuarantee: true, remainingCapacity: 2 };

    mockLoanAppService.getGuarantorExposure.mockResolvedValueOnce(exposureResult);

    const result = await controller.getGuarantorExposure(memberId, tenant as any);

    expect(result).toBe(exposureResult);
    expect(mockLoanAppService.getGuarantorExposure).toHaveBeenCalledWith(memberId, tenant.id);
  });

  it('bubbles up NotFoundException from getGuarantorExposure()', async () => {
    mockLoanAppService.getGuarantorExposure.mockRejectedValueOnce(
      new NotFoundException('Member not found'),
    );

    await expect(
      controller.getGuarantorExposure('ghost-uuid', buildTenant() as any),
    ).rejects.toThrow(NotFoundException);
  });

  // ── GET /admin/loans/pending ──────────────────────────────────────────────

  it('pendingApprovals delegates to loans.getPendingApprovalQueue() with tenant + pagination', async () => {
    const tenant = buildTenant();
    const queueResult = { data: [], nextCursor: null, hasMore: false, meta: {} };
    mockLoansService.getPendingApprovalQueue.mockResolvedValueOnce(queueResult);

    const result = await controller.pendingApprovals(tenant as any, 'cursor-1', 10);

    expect(result).toBe(queueResult);
    expect(mockLoansService.getPendingApprovalQueue).toHaveBeenCalledWith(tenant.id, {
      cursor: 'cursor-1',
      limit: 10,
    });
  });

  // ── PATCH /admin/loans/:id/decision ───────────────────────────────────────

  it('decideLoan maps APPROVED to ReviewLoanAction.APPROVE and delegates to loanReview.process()', async () => {
    const loanId = 'loan-uuid-3';
    const actor = buildActor();
    const tenant = buildTenant();
    const req = buildRequest();
    const reviewResult = { loan: { id: loanId, status: 'APPROVED' } };
    mockLoanReviewService.process.mockResolvedValueOnce(reviewResult);

    const dto: LoanDecisionDto = { decision: LoanDecision.APPROVED };
    const result = await controller.decideLoan(loanId, dto, tenant as any, actor as any, req);

    expect(result).toBe(reviewResult);
    expect(mockLoanReviewService.process).toHaveBeenCalledWith(
      loanId,
      { action: ReviewLoanAction.APPROVE, reason: undefined },
      tenant.id,
      actor.id,
      req.ip,
      undefined,
    );
  });

  it('decideLoan maps REJECTED to ReviewLoanAction.DECLINE and passes comments as the reason', async () => {
    const loanId = 'loan-uuid-4';
    const actor = buildActor();
    const tenant = buildTenant();
    const req = buildRequest();
    const reviewResult = { loan: { id: loanId, status: 'REJECTED' } };
    mockLoanReviewService.process.mockResolvedValueOnce(reviewResult);

    const dto: LoanDecisionDto = { decision: LoanDecision.REJECTED, comments: 'Debt-to-income too high' };
    const result = await controller.decideLoan(loanId, dto, tenant as any, actor as any, req);

    expect(result).toBe(reviewResult);
    expect(mockLoanReviewService.process).toHaveBeenCalledWith(
      loanId,
      { action: ReviewLoanAction.DECLINE, reason: 'Debt-to-income too high' },
      tenant.id,
      actor.id,
      req.ip,
      undefined,
    );
  });

  it('decideLoan never calls loans.disburse() — disbursement stays a separate explicit action', async () => {
    mockLoanReviewService.process.mockResolvedValueOnce({ loan: { status: 'APPROVED' } });

    const dto: LoanDecisionDto = { decision: LoanDecision.APPROVED };
    await controller.decideLoan('loan-uuid-5', dto, buildTenant() as any, buildActor() as any, buildRequest());

    expect(mockLoansService.disburse).not.toHaveBeenCalled();
  });

  // ── Maker-checker: DISBURSE restricted to MANAGER ─────────────────────────

  it('POST /admin/loans/:id/disburse delegates straight to loans.disburse()', async () => {
    const loanId = 'loan-uuid-6';
    const actor = buildActor({ role: 'MANAGER' });
    const tenant = buildTenant();
    const req = buildRequest('10.0.0.2');
    const disbursalResult = { loan: { id: loanId, status: 'ACTIVE' }, newBalance: 60000 };
    mockLoansService.disburse.mockResolvedValueOnce(disbursalResult);

    const result = await controller.disburseLoan(loanId, tenant as any, actor as any, req);

    expect(result).toBe(disbursalResult);
    expect(mockLoansService.disburse).toHaveBeenCalledWith(loanId, tenant.id, actor.id, req.ip);
  });

  it('updateStatus rejects a LOAN_OFFICER attempting status=DISBURSED (maker-checker)', async () => {
    const actor = buildActor({ role: 'LOAN_OFFICER' });
    const dto: UpdateLoanStatusDto = { status: AdminLoanStatus.DISBURSED };

    await expect(
      controller.updateStatus('loan-uuid-7', dto, buildTenant() as any, actor as any, buildRequest()),
    ).rejects.toThrow(ForbiddenException);
    expect(mockLoansService.disburse).not.toHaveBeenCalled();
  });

  it('updateStatus rejects a TENANT_ADMIN attempting status=DISBURSED (maker-checker)', async () => {
    const actor = buildActor({ role: 'TENANT_ADMIN' });
    const dto: UpdateLoanStatusDto = { status: AdminLoanStatus.DISBURSED };

    await expect(
      controller.updateStatus('loan-uuid-8', dto, buildTenant() as any, actor as any, buildRequest()),
    ).rejects.toThrow(ForbiddenException);
    expect(mockLoansService.disburse).not.toHaveBeenCalled();
  });

  it('updateStatus still allows MANAGER to disburse via status=DISBURSED', async () => {
    mockLoansService.disburse.mockResolvedValueOnce({ loan: {}, newBalance: 0 });
    const actor = buildActor({ role: 'MANAGER' });
    const dto: UpdateLoanStatusDto = { status: AdminLoanStatus.DISBURSED };

    await controller.updateStatus('loan-uuid-9', dto, buildTenant() as any, actor as any, buildRequest());

    expect(mockLoansService.disburse).toHaveBeenCalledTimes(1);
  });

  it('reviewLoan rejects a LOAN_OFFICER attempting action=DISBURSE (maker-checker)', async () => {
    const actor = buildActor({ role: 'LOAN_OFFICER' });
    const dto = { action: ReviewLoanAction.DISBURSE } as any;

    await expect(
      controller.reviewLoan('loan-uuid-10', dto, buildTenant() as any, actor as any, buildRequest()),
    ).rejects.toThrow(ForbiddenException);
    expect(mockLoanReviewService.process).not.toHaveBeenCalled();
  });

  it('reviewLoan still allows MANAGER to disburse via action=DISBURSE', async () => {
    mockLoanReviewService.process.mockResolvedValueOnce({ loan: { status: 'ACTIVE' } });
    const actor = buildActor({ role: 'MANAGER' });
    const dto = { action: ReviewLoanAction.DISBURSE } as any;

    await controller.reviewLoan('loan-uuid-11', dto, buildTenant() as any, actor as any, buildRequest());

    expect(mockLoanReviewService.process).toHaveBeenCalledTimes(1);
  });

  it('reviewLoan does not gate APPROVE/DECLINE behind the MANAGER-only disbursement check', async () => {
    mockLoanReviewService.process.mockResolvedValueOnce({ loan: { status: 'APPROVED' } });
    const actor = buildActor({ role: 'LOAN_OFFICER' });
    const dto = { action: ReviewLoanAction.APPROVE } as any;

    await expect(
      controller.reviewLoan('loan-uuid-12', dto, buildTenant() as any, actor as any, buildRequest()),
    ).resolves.toBeDefined();
    expect(mockLoanReviewService.process).toHaveBeenCalledTimes(1);
  });
});
