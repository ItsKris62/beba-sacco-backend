import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { GuarantorStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { GetAdminLoansQueryDto } from './dto/get-admin-loans-query.dto';

/**
 * LoanAdminService
 *
 * Admin-scoped loan queries. All methods enforce tenantId isolation.
 * accruedInterest is stubbed at 0 until the Tier 3 schema migration adds
 * the Loan.accruedInterest column.
 */
@Injectable()
export class LoanAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string, query: GetAdminLoansQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where = {
      tenantId,
      ...(query.status !== undefined && { status: query.status }),
      ...(query.loanProductId !== undefined && { loanProductId: query.loanProductId }),
      ...(query.memberId !== undefined && { memberId: query.memberId }),
    };

    const [loans, total] = await this.prisma.$transaction([
      this.prisma.loan.findMany({
        where,
        skip,
        take: limit,
        orderBy: { appliedAt: 'desc' },
        select: {
          id: true,
          loanNumber: true,
          status: true,
          principalAmount: true,
          outstandingBalance: true,
          disbursedAt: true,
          loanProductId: true,
          member: {
            select: {
              user: { select: { firstName: true, lastName: true } },
            },
          },
          guarantors: {
            where: { status: GuarantorStatus.ACCEPTED },
            select: { guaranteedAmount: true },
          },
        },
      }),
      this.prisma.loan.count({ where }),
    ]);

    const data = loans.map((l) => {
      const principal = new Decimal(l.principalAmount.toString());
      const totalGuaranteed = l.guarantors.reduce(
        (sum, g) => sum.plus(new Decimal(g.guaranteedAmount.toString())),
        new Decimal(0),
      );
      const guarantorCoverage = principal.isZero()
        ? 0
        : totalGuaranteed.dividedBy(principal).times(100).toDecimalPlaces(2).toNumber();

      return {
        id: l.id,
        loanNumber: l.loanNumber,
        memberName: `${l.member.user.firstName} ${l.member.user.lastName}`,
        productId: l.loanProductId,
        status: l.status,
        principalAmount: principal.toNumber(),
        outstandingBalance: new Decimal(l.outstandingBalance.toString()).toNumber(),
        // Tier 3 migration adds Loan.accruedInterest — returns 0 until then
        accruedInterest: 0,
        disbursedAt: l.disbursedAt,
        guarantorCoverage,
      };
    });

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
