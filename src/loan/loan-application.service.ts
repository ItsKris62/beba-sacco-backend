import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountType,
  GuarantorStatus,
  InterestType,
  LoanStatus,
  Prisma,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../modules/audit/audit.service';
import { toDecimal } from '../common/utils/decimal.util';

@Injectable()
export class LoanApplicationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createLoanApplication(
    tenantId: string,
    actorUserId: string,
    dto: {
      memberId: string;
      loanProductId: string;
      principalAmount: number;
      tenureMonths: number;
      purpose?: string;
    },
  ) {
    const product = await this.prisma.loanProduct.findFirst({
      where: { id: dto.loanProductId, tenantId, isActive: true },
    });
    if (!product) throw new NotFoundException('Loan product not found');

    const principal = toDecimal(dto.principalAmount)!;
    const processingFee = principal.times(product.processingFeeRate).toDecimalPlaces(4);
    const monthlyInstalment = this.calculateInstalment(
      principal,
      product.interestRate,
      dto.tenureMonths,
      product.interestType,
    ).toDecimalPlaces(4);

    return this.prisma.$transaction(async (tx) => {
      const member = await tx.member.findFirst({
        where: { id: dto.memberId, tenantId, isActive: true },
        select: { id: true, kycStatus: true },
      });
      if (!member) throw new NotFoundException('Member not found');
      if (member.kycStatus !== 'APPROVED') {
        throw new BadRequestException('Member KYC must be approved');
      }

      await this.enforceOneActiveLoan(tx, tenantId, dto.memberId);

      const counter = await tx.tenantCounter.upsert({
        where: { tenantId },
        create: { tenantId, loanSeq: 1 },
        update: { loanSeq: { increment: 1 } },
      });
      const loanNumber = `LN-${new Date().getFullYear()}-${String(counter.loanSeq).padStart(6, '0')}`;

      const loan = await tx.loan.create({
        data: {
          tenantId,
          memberId: dto.memberId,
          loanProductId: dto.loanProductId,
          loanNumber,
          status: LoanStatus.PENDING_GUARANTORS,
          purpose: dto.purpose,
          principalAmount: principal,
          interestRate: product.interestRate,
          processingFee,
          tenureMonths: dto.tenureMonths,
          gracePeriodMonths: product.gracePeriodMonths,
          monthlyInstalment,
          outstandingBalance: principal,
        },
      });

      await this.audit.createAtomic(tx, {
        tenantId,
        actorId: actorUserId,
        action: 'LOAN.APPLICATION_CREATED',
        entityType: 'Loan',
        entityId: loan.id,
        newValue: { status: loan.status, principalAmount: principal.toString() },
      });

      return loan;
    });
  }

  async applyForLoan(tenantId: string, actorUserId: string, loanId: string) {
    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({
        where: { id: loanId, tenantId },
        include: { member: true, loanProduct: true, guarantors: true },
      });
      if (!loan) throw new NotFoundException('Loan not found');
      if (loan.member.kycStatus !== 'APPROVED') {
        throw new BadRequestException('Member KYC must be approved');
      }

      await this.enforceOneActiveLoan(tx, tenantId, loan.memberId, loan.id);

      const accepted = loan.guarantors.filter((g) => g.status === GuarantorStatus.ACCEPTED);
      if (accepted.length < loan.loanProduct.minGuarantors) {
        throw new BadRequestException('Required guarantors have not accepted');
      }
      const frozenTotal = accepted.reduce(
        (sum, guarantor) => sum.plus(guarantor.guaranteedAmount),
        toDecimal(0)!,
      );
      if (frozenTotal.lessThan(loan.principalAmount)) {
        throw new BadRequestException('Accepted guarantor frozen savings do not cover loan amount');
      }

      const updated = await tx.loan.update({
        where: { id: loan.id },
        data: { status: LoanStatus.PENDING_APPROVAL },
      });

      await this.audit.createAtomic(tx, {
        tenantId,
        actorId: actorUserId,
        action: 'LOAN.SUBMITTED_FOR_APPROVAL',
        entityType: 'Loan',
        entityId: loan.id,
        oldValue: { status: loan.status },
        newValue: { status: LoanStatus.PENDING_APPROVAL },
      });

      return updated;
    });
  }

  async approveLoan(tenantId: string, adminUserId: string, loanId: string) {
    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({
        where: { id: loanId, tenantId, status: { in: [LoanStatus.PENDING_APPROVAL, LoanStatus.APPROVED] } },
        include: { loanProduct: true },
      });
      if (!loan) throw new NotFoundException('Loan awaiting approval not found');

      const fosa = await tx.account.findFirst({
        where: { tenantId, memberId: loan.memberId, accountType: AccountType.FOSA, isActive: true },
        select: { id: true, balance: true, version: true },
      });
      if (!fosa) throw new NotFoundException('Member FOSA account not found');

      const principal = toDecimal(loan.principalAmount.toString())!;
      const monthlyInstalment = this.calculateInstalment(
        principal,
        loan.interestRate,
        loan.tenureMonths,
        loan.loanProduct.interestType,
      ).toDecimalPlaces(4);
      const balanceAfter = toDecimal(fosa.balance.toString())!.plus(principal).toDecimalPlaces(4);

      const accountUpdate = await tx.account.updateMany({
        where: { id: fosa.id, tenantId, version: fosa.version },
        data: { balance: { increment: principal }, version: { increment: 1 } },
      });
      if (accountUpdate.count === 0) {
        throw new ConflictException('Concurrent FOSA balance modification');
      }

      const transaction = await tx.transaction.create({
        data: {
          tenantId,
          accountId: fosa.id,
          loanId: loan.id,
          type: TransactionType.LOAN_DISBURSEMENT,
          status: TransactionStatus.COMPLETED,
          amount: principal,
          balanceBefore: fosa.balance,
          balanceAfter,
          reference: `LOAN-DISB-${loan.id}`,
          description: `Loan ${loan.loanNumber} disbursement`,
          processedBy: adminUserId,
        },
      });

      const updatedLoan = await tx.loan.update({
        where: { id: loan.id },
        data: {
          status: LoanStatus.ACTIVE,
          approvedAt: loan.approvedAt ?? new Date(),
          approvedBy: loan.approvedBy ?? adminUserId,
          disbursedAt: new Date(),
          disbursedBy: adminUserId,
          monthlyInstalment,
          outstandingBalance: principal,
        },
      });

      await this.audit.createAtomic(tx, {
        tenantId,
        actorId: adminUserId,
        action: 'LOAN.APPROVED_DISBURSED',
        entityType: 'Loan',
        entityId: loan.id,
        oldValue: { status: loan.status },
        newValue: {
          status: LoanStatus.ACTIVE,
          monthlyInstalment: monthlyInstalment.toString(),
          outstandingBalance: principal.toString(),
          transactionId: transaction.id,
        },
      });

      return updatedLoan;
    });
  }

  async rejectLoan(tenantId: string, adminUserId: string, loanId: string, rejectionReason: string) {
    if (!rejectionReason?.trim()) {
      throw new BadRequestException('Rejection reason is required');
    }

    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({
        where: { id: loanId, tenantId },
        include: { guarantors: { where: { status: GuarantorStatus.ACCEPTED, holdReleasedAt: null } } },
      });
      if (!loan) throw new NotFoundException('Loan not found');

      await this.unfreezeGuarantors(tx, tenantId, loan.guarantors, adminUserId, 'LOAN.REJECTED_UNFREEZE');

      const updated = await tx.loan.update({
        where: { id: loan.id },
        data: { status: LoanStatus.REJECTED, notes: rejectionReason },
      });

      await this.audit.createAtomic(tx, {
        tenantId,
        actorId: adminUserId,
        action: 'LOAN.REJECTED',
        entityType: 'Loan',
        entityId: loan.id,
        oldValue: { status: loan.status },
        newValue: { status: LoanStatus.REJECTED, rejectionReason },
      });

      return updated;
    });
  }

  private async enforceOneActiveLoan(
    tx: Prisma.TransactionClient,
    tenantId: string,
    memberId: string,
    excludeLoanId?: string,
  ) {
    const existing = await tx.loan.findFirst({
      where: {
        tenantId,
        memberId,
        id: excludeLoanId ? { not: excludeLoanId } : undefined,
        status: {
          in: [
            LoanStatus.PENDING_GUARANTORS,
            LoanStatus.PENDING_APPROVAL,
            LoanStatus.APPROVED,
            LoanStatus.DISBURSED,
            LoanStatus.ACTIVE,
          ],
        },
      },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Member already has an active loan');
  }

  private async unfreezeGuarantors(
    tx: Prisma.TransactionClient,
    tenantId: string,
    guarantors: Array<{ id: string; memberId: string; guaranteedAmount: Prisma.Decimal }>,
    actorUserId: string,
    action: string,
  ) {
    for (const guarantor of guarantors) {
      if (toDecimal(guarantor.guaranteedAmount.toString())!.lessThanOrEqualTo(0)) continue;

      const account = await tx.account.findFirst({
        where: { tenantId, memberId: guarantor.memberId, accountType: AccountType.BOSA, isActive: true },
        select: { id: true, version: true },
      });
      if (!account) throw new NotFoundException('Guarantor BOSA account not found');

      const updated = await tx.account.updateMany({
        where: { id: account.id, tenantId, version: account.version },
        data: {
          frozenSavings: { decrement: guarantor.guaranteedAmount },
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new ConflictException('Concurrent guarantor balance modification');
      }

      await tx.loanGuarantor.update({
        where: { id: guarantor.id },
        data: { holdReleasedAt: new Date() },
      });

      await this.audit.createAtomic(tx, {
        tenantId,
        actorId: actorUserId,
        action,
        entityType: 'LoanGuarantor',
        entityId: guarantor.id,
        newValue: { releasedAmount: guarantor.guaranteedAmount.toString() },
      });
    }
  }

  private calculateInstalment(
    principal: Prisma.Decimal,
    annualRate: Prisma.Decimal,
    tenureMonths: number,
    interestType: InterestType,
  ): Prisma.Decimal {
    if (interestType === InterestType.FLAT) {
      return principal.plus(principal.times(annualRate).times(tenureMonths).div(12)).div(tenureMonths);
    }

    const monthlyRate = annualRate.div(12);
    if (monthlyRate.equals(0)) return principal.div(tenureMonths);
    const pow = monthlyRate.plus(1).pow(tenureMonths);
    return principal.times(monthlyRate).times(pow).div(pow.minus(1));
  }
}

