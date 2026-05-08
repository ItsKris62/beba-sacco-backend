import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Request } from 'express';
import { LoanAdminController } from '../loan-admin.controller';
import { LoanApplicationService } from '../loan-application.service';
import { LoansService } from '../loans.service';
import { LoanAdminService } from '../loan-admin.service';
import { AdminLoanStatus, UpdateLoanStatusDto } from '../dto/update-loan-status.dto';

// ─── Stubs ───────────────────────────────────────────────────────────────────

const mockLoansService = {
  disburse: jest.fn(),
};

const mockLoanAppService = {
  updateStatus: jest.fn(),
  getGuarantorExposure: jest.fn(),
};

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
        { provide: LoanAdminService, useValue: { findAll: jest.fn() } },
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
    AdminLoanStatus.UNDER_REVIEW,
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
});
