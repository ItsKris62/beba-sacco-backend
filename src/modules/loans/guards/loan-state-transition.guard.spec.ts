import { BadRequestException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LoanStatus } from '@prisma/client';
import { LoanStateGuardMetadata } from '../decorators/loan-state-guard.decorator';
import { LoanStateTransitionGuard } from './loan-state-transition.guard';

function buildContext(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: jest.fn(),
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('LoanStateTransitionGuard', () => {
  const metadata: LoanStateGuardMetadata = {
    loanIdParam: 'id',
    targetStatusBodyField: 'status',
  };

  let reflector: jest.Mocked<Pick<Reflector, 'get'>>;
  let prisma: { loan: { findFirst: jest.Mock } };
  let guard: LoanStateTransitionGuard;

  beforeEach(() => {
    reflector = { get: jest.fn().mockReturnValue(metadata) };
    prisma = { loan: { findFirst: jest.fn() } };
    guard = new LoanStateTransitionGuard(reflector as unknown as Reflector, prisma as any);
  });

  it('throws BadRequestException when the guarded route has no loan id context', async () => {
    const context = buildContext({
      params: {},
      body: { status: LoanStatus.PENDING_REVIEW },
      tenant: { id: 'tenant-id' },
      headers: {},
    });

    await expect(guard.canActivate(context)).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when the guarded route has no tenant context', async () => {
    const context = buildContext({
      params: { id: 'loan-id' },
      body: { status: LoanStatus.PENDING_REVIEW },
      headers: {},
    });

    await expect(guard.canActivate(context)).rejects.toThrow(BadRequestException);
  });

  it('allows the request when target status cannot be resolved', async () => {
    const context = buildContext({
      params: { id: 'loan-id' },
      body: {},
      tenant: { id: 'tenant-id' },
      headers: {},
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.loan.findFirst).not.toHaveBeenCalled();
  });

  it('maps review actions to loan statuses before enforcing transitions', async () => {
    reflector.get.mockReturnValueOnce({
      loanIdParam: 'id',
      targetStatusBodyField: 'action',
      targetStatusMap: { APPROVE: LoanStatus.APPROVED },
    });
    prisma.loan.findFirst.mockResolvedValueOnce({ status: LoanStatus.PENDING_REVIEW });
    const context = buildContext({
      params: { id: 'loan-id' },
      body: { action: 'APPROVE' },
      tenant: { id: 'tenant-id' },
      headers: {},
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.loan.findFirst).toHaveBeenCalledWith({
      where: { id: 'loan-id', tenantId: 'tenant-id' },
      select: { status: true },
    });
  });
});
