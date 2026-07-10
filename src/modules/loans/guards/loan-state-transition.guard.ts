import { BadRequestException, CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LoanStatus } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../../../prisma/prisma.service';
import { canTransition } from '../loan-state-machine';
import {
  LOAN_STATE_GUARD_KEY,
  LoanStateGuardMetadata,
} from '../decorators/loan-state-guard.decorator';

@Injectable()
export class LoanStateTransitionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.get<LoanStateGuardMetadata>(
      LOAN_STATE_GUARD_KEY,
      context.getHandler(),
    );
    if (!options) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { tenant?: { id?: string }; tenantId?: string }>();
    const loanId = req.params?.[options.loanIdParam];
    const rawTargetStatus = (req.body as Record<string, unknown> | undefined)?.[
      options.targetStatusBodyField
    ];
    const tenantId =
      req.tenant?.id ?? req.tenantId ?? this.getSingleHeaderValue(req.headers['x-tenant-id']);

    if (!loanId || typeof loanId !== 'string') {
      throw new BadRequestException('Loan id is required for loan state transition validation');
    }

    if (!tenantId) {
      throw new BadRequestException('Tenant context is required for loan state transition validation');
    }

    if (!rawTargetStatus || typeof rawTargetStatus !== 'string') return true;

    const targetStatus = options.targetStatusMap?.[rawTargetStatus] ?? rawTargetStatus;

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

  private getSingleHeaderValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) return value[0];
    return value;
  }
}
