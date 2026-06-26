import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountType, GuarantorStatus, LoanStatus, Prisma, TransactionStatus, TransactionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../modules/audit/audit.service';
import { toDecimal } from '../common/utils/decimal.util';

@Injectable()
export class RepaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async repayFromFosa(tenantId: string, actorUserId: string, loanId: string, amountValue: number) {
    const amount = toDecimal(amountValue)!;
    if (amount.lessThanOrEqualTo(0)) {
      throw new ConflictException('Repayment amount must be positive');
    }

    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({
        where: { id: loanId, tenantId, status: { in: [LoanStatus.ACTIVE, LoanStatus.DISBURSED, LoanStatus.DEFAULTED] } },
        include: { guarantors: { where: { status: GuarantorStatus.ACCEPTED, holdReleasedAt: null } } },
      });
      if (!loan) throw new NotFoundException('Active loan not found');

      const fosa = await tx.account.findFirst({
        where: { tenantId, memberId: loan.memberId, accountType: AccountType.FOSA, isActive: true },
        select: { id: true, balance: true, version: true },
      });
      if (!fosa) throw new NotFoundException('FOSA account not found');

      const balanceAfter = toDecimal(fosa.balance.toString())!.minus(amount).toDecimalPlaces(4);
      const debited = await tx.account.updateMany({
        where: {
          id: fosa.id,
          tenantId,
          version: fosa.version,
          accountType: AccountType.FOSA,
          balance: { gte: amount },
        },
        data: { balance: { decrement: amount }, version: { increment: 1 } },
      });
      if (debited.count === 0) {
        throw new ConflictException('Insufficient funds or concurrent modification');
      }

      const penaltiesPaid = Prisma.Decimal.min(amount, loan.arrearsAmount).toDecimalPlaces(4);
      let remaining = amount.minus(penaltiesPaid);
      const interestPaid = Prisma.Decimal.min(remaining, loan.accruedInterest).toDecimalPlaces(4);
      remaining = remaining.minus(interestPaid);
      const principalPaid = Prisma.Decimal.min(remaining, loan.outstandingBalance).toDecimalPlaces(4);

      const newArrears = loan.arrearsAmount.minus(penaltiesPaid).toDecimalPlaces(4);
      const newAccruedInterest = loan.accruedInterest.minus(interestPaid).toDecimalPlaces(4);
      const newOutstanding = loan.outstandingBalance.minus(principalPaid).toDecimalPlaces(4);
      const newTotalRepaid = loan.totalRepaid.plus(amount).toDecimalPlaces(4);
      const fullyPaid = newOutstanding.lessThanOrEqualTo(0);

      const transaction = await tx.transaction.create({
        data: {
          tenantId,
          accountId: fosa.id,
          loanId: loan.id,
          type: TransactionType.LOAN_REPAYMENT,
          status: TransactionStatus.COMPLETED,
          amount,
          balanceBefore: fosa.balance,
          balanceAfter,
          reference: `LOAN-REPAY-${loan.id}-${Date.now()}`,
          description: 'Loan repayment from FOSA',
          processedBy: actorUserId,
        },
      });

      const updatedLoan = await tx.loan.update({
        where: { id: loan.id },
        data: {
          arrearsAmount: newArrears,
          accruedInterest: newAccruedInterest,
          totalRepaid: newTotalRepaid,
          outstandingBalance: fullyPaid ? toDecimal(0)! : newOutstanding,
          status: fullyPaid ? LoanStatus.FULLY_PAID : loan.status,
        },
      });

      if (fullyPaid) {
        await this.unfreezeGuarantors(tx, tenantId, loan.guarantors, actorUserId);
      }

      await this.audit.createAtomic(tx, {
        tenantId,
        actorId: actorUserId,
        action: 'LOAN.REPAYMENT_FROM_FOSA',
        entityType: 'Loan',
        entityId: loan.id,
        newValue: {
          amount: amount.toString(),
          penaltiesPaid: penaltiesPaid.toString(),
          interestPaid: interestPaid.toString(),
          principalPaid: principalPaid.toString(),
          outstandingBalance: updatedLoan.outstandingBalance.toString(),
          transactionId: transaction.id,
        },
      });

      return {
        loan: updatedLoan,
        transaction,
        allocation: { penaltiesPaid, interestPaid, principalPaid },
      };
    });
  }

  private async unfreezeGuarantors(
    tx: Prisma.TransactionClient,
    tenantId: string,
    guarantors: Array<{ id: string; memberId: string; guaranteedAmount: Prisma.Decimal }>,
    actorUserId: string,
  ) {
    for (const guarantor of guarantors) {
      if (guarantor.guaranteedAmount.lessThanOrEqualTo(0)) continue;

      const account = await tx.account.findFirst({
        where: { tenantId, memberId: guarantor.memberId, accountType: AccountType.BOSA, isActive: true },
        select: { id: true, version: true },
      });
      if (!account) throw new NotFoundException('Guarantor BOSA account not found');

      const updated = await tx.account.updateMany({
        where: { id: account.id, tenantId, version: account.version },
        data: { frozenSavings: { decrement: guarantor.guaranteedAmount }, version: { increment: 1 } },
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
        action: 'GUARANTOR.FUNDS_UNFROZEN',
        entityType: 'LoanGuarantor',
        entityId: guarantor.id,
        newValue: { releasedAmount: guarantor.guaranteedAmount.toString() },
      });
    }
  }
}

