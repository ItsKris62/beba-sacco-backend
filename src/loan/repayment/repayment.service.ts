import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountType, GuarantorStatus, LoanStatus, TransactionStatus, TransactionType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService as AuditLogService } from '../../modules/audit/audit.service';
import { toDecimal } from '../../common/utils/decimal.util';

@Injectable()
export class RepaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async repayFromFosa(memberId: string, loanId: string, amount: string) {
    const paymentAmount = toDecimal(amount);
    if (!paymentAmount || paymentAmount.lessThanOrEqualTo(0)) {
      throw new BadRequestException('Repayment amount must be greater than zero');
    }

    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({
        where: {
          id: loanId,
          memberId,
          status: { in: [LoanStatus.ACTIVE, LoanStatus.DISBURSED, LoanStatus.DEFAULTED] },
        },
        include: { guarantors: { where: { status: GuarantorStatus.ACCEPTED } } },
      });
      if (!loan) throw new NotFoundException('Active loan not found');

      const fosaAccount = await tx.account.findFirst({
        where: {
          tenantId: loan.tenantId,
          memberId,
          accountType: AccountType.FOSA,
          isActive: true,
        },
        select: { id: true, balance: true, version: true },
      });
      if (!fosaAccount) throw new NotFoundException('FOSA account not found');

      const debit = await tx.account.updateMany({
        where: {
          id: fosaAccount.id,
          version: fosaAccount.version,
          accountType: AccountType.FOSA,
          balance: { gte: paymentAmount },
        },
        data: { balance: { decrement: paymentAmount }, version: { increment: 1 } },
      });
      if (debit.count === 0) {
        throw new ConflictException('Insufficient funds');
      }

      const outstandingBefore = toDecimal(loan.outstandingBalance)!;
      const newOutstandingRaw = outstandingBefore.minus(paymentAmount).toDecimalPlaces(4);
      const isFullyPaid = newOutstandingRaw.lessThanOrEqualTo(0);
      const newOutstanding = isFullyPaid ? toDecimal(0)! : newOutstandingRaw;
      const newTotalRepaid = toDecimal(loan.totalRepaid)!.plus(paymentAmount).toDecimalPlaces(4);

      const loanUpdate = await tx.loan.updateMany({
        where: { id: loan.id, status: loan.status },
        data: {
          totalRepaid: newTotalRepaid,
          outstandingBalance: newOutstanding,
          status: isFullyPaid ? LoanStatus.FULLY_PAID : loan.status,
        },
      });
      if (loanUpdate.count === 0) {
        throw new ConflictException('Loan changed concurrently');
      }

      const ledger = await tx.transaction.create({
        data: {
          tenantId: loan.tenantId,
          accountId: fosaAccount.id,
          loanId: loan.id,
          type: TransactionType.LOAN_REPAYMENT,
          status: TransactionStatus.COMPLETED,
          amount: paymentAmount,
          balanceBefore: fosaAccount.balance,
          balanceAfter: fosaAccount.balance.minus(paymentAmount).toDecimalPlaces(4),
          reference: `LOAN-REPAY-${loan.id}-${Date.now()}`,
          description: `Loan ${loan.loanNumber} repayment from FOSA`,
          processedBy: memberId,
        },
      });

      if (isFullyPaid) {
        for (const guarantor of loan.guarantors) {
          if (guarantor.guaranteedAmount.lessThanOrEqualTo(0) || guarantor.holdReleasedAt) continue;

          const bosaAccount = await tx.account.findFirst({
            where: {
              tenantId: loan.tenantId,
              memberId: guarantor.memberId,
              accountType: AccountType.BOSA,
              isActive: true,
            },
            select: { id: true, version: true },
          });
          if (!bosaAccount) throw new NotFoundException('Guarantor BOSA account not found');

          const unfreeze = await tx.account.updateMany({
            where: {
              id: bosaAccount.id,
              version: bosaAccount.version,
              accountType: AccountType.BOSA,
            },
            data: {
              frozenSavings: { decrement: guarantor.guaranteedAmount },
              version: { increment: 1 },
            },
          });
          if (unfreeze.count === 0) {
            throw new ConflictException('Concurrent BOSA frozen savings modification');
          }

          await tx.loanGuarantor.update({
            where: { id: guarantor.id },
            data: { holdReleasedAt: new Date() },
          });

          await this.auditLog.createAtomic(tx, {
            tenantId: loan.tenantId,
            actorId: memberId,
            action: 'GUARANTOR.FUNDS_UNFROZEN_ON_FULL_REPAYMENT',
            entityType: 'LoanGuarantor',
            entityId: guarantor.id,
            newValue: { releasedAmount: guarantor.guaranteedAmount.toString() },
          });
        }
      }

      await this.auditLog.createAtomic(tx, {
        tenantId: loan.tenantId,
        actorId: memberId,
        action: 'LOAN.REPAYMENT_FROM_FOSA',
        entityType: 'Loan',
        entityId: loan.id,
        oldValue: {
          status: loan.status,
          outstandingBalance: outstandingBefore.toString(),
          totalRepaid: loan.totalRepaid.toString(),
        },
        newValue: {
          status: isFullyPaid ? LoanStatus.FULLY_PAID : loan.status,
          paymentAmount: paymentAmount.toString(),
          outstandingBalance: newOutstanding.toString(),
          totalRepaid: newTotalRepaid.toString(),
          transactionId: ledger.id,
        },
      });

      return {
        transaction: ledger,
        loan: await tx.loan.findUniqueOrThrow({ where: { id: loan.id } }),
      };
    });
  }
}

