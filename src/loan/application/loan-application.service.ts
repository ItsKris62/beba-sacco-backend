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
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService as AuditLogService } from '../../modules/audit/audit.service';
import { toDecimal } from '../../common/utils/decimal.util';

@Injectable()
export class LoanApplicationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async applyForLoan(memberId: string, loanProductId: string, amount: string, purpose: string) {
    const requestedAmount = toDecimal(amount);
    if (!requestedAmount || requestedAmount.lessThanOrEqualTo(0)) {
      throw new BadRequestException('Loan amount must be greater than zero');
    }

    return this.prisma.$transaction(async (tx) => {
      const member = await tx.member.findFirst({
        where: { id: memberId, isActive: true },
        select: { id: true, tenantId: true, kycStatus: true },
      });
      if (!member) throw new NotFoundException('Member not found');
      if (member.kycStatus !== 'APPROVED') {
        throw new BadRequestException('Member KYC must be approved before applying for a loan');
      }

      await this.enforceOneActiveLoan(tx, member.tenantId, member.id);

      const product = await tx.loanProduct.findFirst({
        where: { id: loanProductId, tenantId: member.tenantId, isActive: true },
      });
      if (!product) throw new NotFoundException('Loan product not found');
      if (requestedAmount.lessThan(product.minAmount) || requestedAmount.greaterThan(product.maxAmount)) {
        throw new BadRequestException('Requested amount is outside loan product limits');
      }

      const counter = await tx.tenantCounter.upsert({
        where: { tenantId: member.tenantId },
        create: { tenantId: member.tenantId, loanSeq: 1 },
        update: { loanSeq: { increment: 1 } },
      });
      const loanNumber = `LN-${new Date().getFullYear()}-${String(counter.loanSeq).padStart(6, '0')}`;
      const monthlyInstalment = this.calculateMonthlyInstalment(
        requestedAmount,
        product.interestRate,
        product.maxTenureMonths,
        product.interestType,
      ).toDecimalPlaces(4);
      const processingFee = requestedAmount.times(product.processingFeeRate).toDecimalPlaces(4);

      const loan = await tx.loan.create({
        data: {
          tenantId: member.tenantId,
          memberId: member.id,
          loanProductId: product.id,
          loanNumber,
          status: LoanStatus.PENDING_GUARANTORS,
          purpose,
          principalAmount: requestedAmount,
          interestRate: product.interestRate,
          processingFee,
          tenureMonths: product.maxTenureMonths,
          gracePeriodMonths: product.gracePeriodMonths,
          monthlyInstalment,
          outstandingBalance: requestedAmount,
        },
      });

      await this.auditLog.createAtomic(tx, {
        tenantId: member.tenantId,
        actorId: member.id,
        action: 'LOAN.APPLIED',
        entityType: 'Loan',
        entityId: loan.id,
        newValue: {
          status: LoanStatus.PENDING_GUARANTORS,
          loanProductId,
          amount: requestedAmount.toString(),
          purpose,
        },
      });

      return loan;
    });
  }

  async submitForApproval(loanId: string, memberId: string) {
    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({
        where: { id: loanId, memberId },
        include: {
          loanProduct: true,
          guarantors: { where: { status: GuarantorStatus.ACCEPTED } },
        },
      });
      if (!loan) throw new NotFoundException('Loan not found');
      if (loan.guarantors.length < loan.loanProduct.minGuarantors) {
        throw new BadRequestException('Required guarantors have not accepted');
      }

      const guaranteedTotal = loan.guarantors.reduce(
        (sum, guarantor) => sum.plus(guarantor.guaranteedAmount),
        toDecimal(0)!,
      );
      if (guaranteedTotal.lessThan(loan.principalAmount)) {
        throw new BadRequestException('Accepted guarantors do not cover the loan principal');
      }

      const updated = await tx.loan.updateMany({
        where: { id: loan.id, status: LoanStatus.PENDING_GUARANTORS },
        data: { status: LoanStatus.PENDING_APPROVAL },
      });
      if (updated.count === 0) {
        throw new ConflictException('Loan status changed concurrently');
      }

      await this.auditLog.createAtomic(tx, {
        tenantId: loan.tenantId,
        actorId: memberId,
        action: 'LOAN.SUBMITTED_FOR_APPROVAL',
        entityType: 'Loan',
        entityId: loan.id,
        oldValue: { status: loan.status },
        newValue: {
          status: LoanStatus.PENDING_APPROVAL,
          guaranteedTotal: guaranteedTotal.toString(),
        },
      });

      return tx.loan.findUniqueOrThrow({ where: { id: loan.id } });
    });
  }

  async approveLoan(loanId: string, adminUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({
        where: { id: loanId, status: LoanStatus.PENDING_APPROVAL },
        include: { loanProduct: true },
      });
      if (!loan) throw new NotFoundException('Loan pending approval not found');

      const fosaAccount = await tx.account.findFirst({
        where: {
          tenantId: loan.tenantId,
          memberId: loan.memberId,
          accountType: AccountType.FOSA,
          isActive: true,
        },
        select: { id: true, balance: true, version: true },
      });
      if (!fosaAccount) throw new NotFoundException('Member FOSA account not found');

      const principal = toDecimal(loan.principalAmount)!;
      const monthlyInstalment = this.calculateMonthlyInstalment(
        principal,
        loan.interestRate,
        loan.tenureMonths,
        loan.loanProduct.interestType,
      ).toDecimalPlaces(4);

      const credited = await tx.account.updateMany({
        where: {
          id: fosaAccount.id,
          version: fosaAccount.version,
          accountType: AccountType.FOSA,
        },
        data: { balance: { increment: principal }, version: { increment: 1 } },
      });
      if (credited.count === 0) {
        throw new ConflictException('Concurrent FOSA balance modification');
      }

      const ledger = await tx.transaction.create({
        data: {
          tenantId: loan.tenantId,
          accountId: fosaAccount.id,
          loanId: loan.id,
          type: TransactionType.LOAN_DISBURSEMENT,
          status: TransactionStatus.COMPLETED,
          amount: principal,
          balanceBefore: fosaAccount.balance,
          balanceAfter: fosaAccount.balance.plus(principal).toDecimalPlaces(4),
          reference: `LOAN-DISB-${loan.id}`,
          description: `Loan ${loan.loanNumber} disbursement`,
          processedBy: adminUserId,
        },
      });

      const updated = await tx.loan.updateMany({
        where: { id: loan.id, status: LoanStatus.PENDING_APPROVAL },
        data: {
          status: LoanStatus.ACTIVE,
          approvedAt: new Date(),
          approvedBy: adminUserId,
          disbursedAt: new Date(),
          disbursedBy: adminUserId,
          monthlyInstalment,
          outstandingBalance: principal,
        },
      });
      if (updated.count === 0) {
        throw new ConflictException('Loan status changed concurrently');
      }

      await this.auditLog.createAtomic(tx, {
        tenantId: loan.tenantId,
        actorId: adminUserId,
        action: 'LOAN.APPROVED_DISBURSED',
        entityType: 'Loan',
        entityId: loan.id,
        oldValue: { status: loan.status },
        newValue: {
          status: LoanStatus.ACTIVE,
          monthlyInstalment: monthlyInstalment.toString(),
          outstandingBalance: principal.toString(),
          transactionId: ledger.id,
        },
      });

      return tx.loan.findUniqueOrThrow({ where: { id: loan.id } });
    });
  }

  async rejectLoan(loanId: string, adminUserId: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('Rejection reason is required');

    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({
        where: { id: loanId },
        include: { guarantors: { where: { status: GuarantorStatus.ACCEPTED } } },
      });
      if (!loan) throw new NotFoundException('Loan not found');

      const updated = await tx.loan.updateMany({
        where: {
          id: loan.id,
          status: {
            in: [
              LoanStatus.PENDING_GUARANTORS,
              LoanStatus.PENDING_APPROVAL,
              LoanStatus.APPROVED,
            ],
          },
        },
        data: { status: LoanStatus.REJECTED, notes: reason },
      });
      if (updated.count === 0) {
        throw new ConflictException('Loan cannot be rejected from its current state');
      }

      for (const guarantor of loan.guarantors) {
        if (guarantor.guaranteedAmount.lessThanOrEqualTo(0)) continue;

        const account = await tx.account.findFirst({
          where: {
            tenantId: loan.tenantId,
            memberId: guarantor.memberId,
            accountType: AccountType.BOSA,
            isActive: true,
          },
          select: { id: true, version: true },
        });
        if (!account) throw new NotFoundException('Guarantor BOSA account not found');

        const unfrozen = await tx.account.updateMany({
          where: { id: account.id, version: account.version, accountType: AccountType.BOSA },
          data: {
            frozenSavings: { decrement: guarantor.guaranteedAmount },
            version: { increment: 1 },
          },
        });
        if (unfrozen.count === 0) {
          throw new ConflictException('Concurrent BOSA frozen savings modification');
        }

        await tx.loanGuarantor.update({
          where: { id: guarantor.id },
          data: { holdReleasedAt: new Date() },
        });

        await this.auditLog.createAtomic(tx, {
          tenantId: loan.tenantId,
          actorId: adminUserId,
          action: 'GUARANTOR.FUNDS_UNFROZEN_ON_REJECTION',
          entityType: 'LoanGuarantor',
          entityId: guarantor.id,
          newValue: { releasedAmount: guarantor.guaranteedAmount.toString() },
        });
      }

      await this.auditLog.createAtomic(tx, {
        tenantId: loan.tenantId,
        actorId: adminUserId,
        action: 'LOAN.REJECTED',
        entityType: 'Loan',
        entityId: loan.id,
        oldValue: { status: loan.status },
        newValue: { status: LoanStatus.REJECTED, reason },
      });

      return tx.loan.findUniqueOrThrow({ where: { id: loan.id } });
    });
  }

  private async enforceOneActiveLoan(
    tx: Prisma.TransactionClient,
    tenantId: string,
    memberId: string,
  ) {
    const existing = await tx.loan.findFirst({
      where: {
        tenantId,
        memberId,
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

  private calculateMonthlyInstalment(
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

