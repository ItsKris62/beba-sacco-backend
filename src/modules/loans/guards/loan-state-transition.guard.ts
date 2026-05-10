import { BadRequestException, CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LoanStatus } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../../../prisma/prisma.service';
import { canTransition } from '../loan-state-machine';
import { LOAN_STATE_GUARD_KEY, LoanStateGuardOptions } from '../decorators/loan-state-guard.decorator';

@Injectable()
export class LoanStateTransitionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.get<Required<LoanStateGuardOptions>>(
      LOAN_STATE_GUARD_KEY,
      context.getHandler(),
    );
    if (!options) return true;

    const req = context.switchToHttp().getRequest<Request & { tenant?: { id?: string } }>();
    const loanId = req.params[options.loanIdParam];
    const targetStatus = (req.body as Record<string, unknown> | undefined)?.[options.targetStatusBodyField];
    const tenantId = req.tenant?.id ?? (req.headers['x-tenant-id'] as string | undefined);
    if (!loanId || !targetStatus || typeof targetStatus !== 'string' || !tenantId) return true;

    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, tenantId },
      select: { status: true },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    if (!canTransition(loan.status, targetStatus as LoanStatus)) {
      throw new BadRequestException(`INVALID_LOAN_STATUS_TRANSITION: ${loan.status} -> ${targetStatus}`);
    }

    return true;
  }
}
