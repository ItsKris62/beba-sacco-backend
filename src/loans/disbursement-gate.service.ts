import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { GuarantorStatus, Prisma } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { PrismaService } from '../prisma/prisma.service';

export interface DisbursementGateResult {
  gatePassed: boolean;
  blockingReasons: string[];
  acceptedCount: number;
  requiredGuarantors: number;
  totalAcceptedCoverage: string;
  requiredCoverage: string;
}

@Injectable()
export class DisbursementGateService {
  constructor(private readonly prisma: PrismaService) {}

  async evaluate(
    tenantId: string,
    loanId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<DisbursementGateResult> {
    const loan = await client.loan.findFirst({
      where: { id: loanId, tenantId },
      select: {
        principalAmount: true,
        loanProduct: { select: { minGuarantors: true, guarantorCoverageRatio: true } },
        guarantors: { where: { tenantId }, select: { status: true, guaranteedAmount: true } },
      },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    const requiredGuarantors = loan.loanProduct.minGuarantors;
    const accepted = loan.guarantors.filter((g) => g.status === GuarantorStatus.ACCEPTED);
    const totalAccepted = accepted.reduce((sum, g) => sum.plus(new Decimal(g.guaranteedAmount.toString())), new Decimal(0));
    const requiredCoverage = new Decimal(loan.principalAmount.toString()).times(
      new Decimal(loan.loanProduct.guarantorCoverageRatio?.toString() ?? '1'),
    );
    const blockingReasons: string[] = [];

    if (requiredGuarantors > 0 && loan.guarantors.length < requiredGuarantors) {
      blockingReasons.push('DISBURSEMENT_BLOCKED_MIN_GUARANTORS');
    }
    if (requiredGuarantors > 0 && loan.guarantors.some((g) => g.status !== GuarantorStatus.ACCEPTED)) {
      blockingReasons.push('DISBURSEMENT_BLOCKED_GUARANTORS_PENDING');
    }
    if (requiredGuarantors > 0 && accepted.length < requiredGuarantors) {
      blockingReasons.push('DISBURSEMENT_BLOCKED_ACCEPTED_COUNT');
    }
    if (requiredGuarantors > 0 && totalAccepted.lessThan(requiredCoverage)) {
      blockingReasons.push('DISBURSEMENT_BLOCKED_COVERAGE');
    }

    return {
      gatePassed: blockingReasons.length === 0,
      blockingReasons,
      acceptedCount: accepted.length,
      requiredGuarantors,
      totalAcceptedCoverage: totalAccepted.toDecimalPlaces(4).toString(),
      requiredCoverage: requiredCoverage.toDecimalPlaces(4).toString(),
    };
  }

  async assertPassed(tenantId: string, loanId: string, client?: Prisma.TransactionClient | PrismaService): Promise<void> {
    const result = await this.evaluate(tenantId, loanId, client);
    if (!result.gatePassed) throw new BadRequestException(result.blockingReasons.join('; '));
  }
}