import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountType, TransactionStatus, TransactionType } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../modules/audit/audit.service';
import { toDecimal } from '../common/utils/decimal.util';

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getAccounts(tenantId: string, userId: string) {
    const member = await this.prisma.member.findFirst({
      where: { tenantId, userId, isActive: true },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('Member profile not found');

    const accounts = await this.prisma.account.findMany({
      where: { tenantId, memberId: member.id, accountType: { in: [AccountType.FOSA, AccountType.BOSA] }, isActive: true },
      select: {
        id: true,
        accountNumber: true,
        accountType: true,
        balance: true,
        lockedBalance: true,
        frozenSavings: true,
        version: true,
      },
      orderBy: { accountType: 'asc' },
    });

    return accounts.map((account) => ({
      ...account,
      frozenSavings: account.frozenSavings,
    }));
  }

  async transferFunds(
    tenantId: string,
    actorUserId: string,
    fromAccountType: AccountType,
    toAccountType: AccountType,
    amountValue: number,
    description?: string,
  ) {
    if (fromAccountType === toAccountType) {
      throw new BadRequestException('Source and destination accounts must be different');
    }
    const amount = toDecimal(amountValue)!;
    if (amount.lessThanOrEqualTo(0)) throw new BadRequestException('Amount must be positive');

    return this.prisma.$transaction(async (tx) => {
      const member = await tx.member.findFirst({
        where: { tenantId, userId: actorUserId, isActive: true },
        select: { id: true },
      });
      if (!member) throw new NotFoundException('Member profile not found');

      const [from, to] = await Promise.all([
        tx.account.findFirst({
          where: { tenantId, memberId: member.id, accountType: fromAccountType, isActive: true },
          select: { id: true, balance: true, lockedBalance: true, frozenSavings: true, version: true },
        }),
        tx.account.findFirst({
          where: { tenantId, memberId: member.id, accountType: toAccountType, isActive: true },
          select: { id: true, balance: true, version: true },
        }),
      ]);
      if (!from || !to) throw new NotFoundException('Source or destination account not found');

      const debit = await tx.account.updateMany({
        where: {
          id: from.id,
          tenantId,
          version: from.version,
          balance: { gte: amount },
        },
        data: { balance: { decrement: amount }, version: { increment: 1 } },
      });
      if (debit.count === 0) {
        throw new ConflictException('Insufficient funds or concurrent modification');
      }

      const credit = await tx.account.updateMany({
        where: { id: to.id, tenantId, version: to.version },
        data: { balance: { increment: amount }, version: { increment: 1 } },
      });
      if (credit.count === 0) {
        throw new ConflictException('Concurrent destination account modification');
      }

      const reference = `TRF-${uuidv4()}`;
      const debitTxn = await tx.transaction.create({
        data: {
          tenantId,
          accountId: from.id,
          type: TransactionType.TRANSFER,
          status: TransactionStatus.COMPLETED,
          amount,
          balanceBefore: from.balance,
          balanceAfter: from.balance.minus(amount).toDecimalPlaces(4),
          reference: `${reference}-DR`,
          description: description ?? `Transfer to ${toAccountType}`,
          processedBy: actorUserId,
        },
      });
      const creditTxn = await tx.transaction.create({
        data: {
          tenantId,
          accountId: to.id,
          type: TransactionType.TRANSFER,
          status: TransactionStatus.COMPLETED,
          amount,
          balanceBefore: to.balance,
          balanceAfter: to.balance.plus(amount).toDecimalPlaces(4),
          reference: `${reference}-CR`,
          description: description ?? `Transfer from ${fromAccountType}`,
          processedBy: actorUserId,
        },
      });

      await this.audit.createAtomic(tx, {
        tenantId,
        actorId: actorUserId,
        action: 'ACCOUNT.INTERNAL_TRANSFER',
        entityType: 'Transaction',
        entityId: debitTxn.id,
        newValue: {
          fromAccountId: from.id,
          toAccountId: to.id,
          amount: amount.toString(),
          debitTransactionId: debitTxn.id,
          creditTransactionId: creditTxn.id,
        },
      });

      return { debitTransaction: debitTxn, creditTransaction: creditTxn };
    });
  }

  async withdraw(
    tenantId: string,
    actorUserId: string,
    accountId: string,
    amountValue: number,
    description?: string,
  ) {
    const amount = toDecimal(amountValue)!;
    if (amount.lessThanOrEqualTo(0)) throw new BadRequestException('Amount must be positive');

    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.findFirst({
        where: { id: accountId, tenantId, accountType: AccountType.FOSA, isActive: true },
        select: { id: true, balance: true, version: true },
      });
      if (!account) throw new NotFoundException('FOSA account not found');

      const updated = await tx.account.updateMany({
        where: {
          id: account.id,
          version: account.version,
          accountType: 'FOSA',
          balance: { gte: amount },
        },
        data: { balance: { decrement: amount }, version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new HttpException('Insufficient funds or concurrent modification', HttpStatus.CONFLICT);
      }

      const transaction = await tx.transaction.create({
        data: {
          tenantId,
          accountId: account.id,
          type: TransactionType.WITHDRAWAL,
          status: TransactionStatus.COMPLETED,
          amount,
          balanceBefore: account.balance,
          balanceAfter: account.balance.minus(amount).toDecimalPlaces(4),
          reference: `WDR-${uuidv4()}`,
          description: description ?? 'FOSA withdrawal',
          processedBy: actorUserId,
        },
      });

      await this.audit.createAtomic(tx, {
        tenantId,
        actorId: actorUserId,
        action: 'ACCOUNT.WITHDRAWAL',
        entityType: 'Transaction',
        entityId: transaction.id,
        newValue: { accountId: account.id, amount: amount.toString() },
      });

      return transaction;
    });
  }
}



