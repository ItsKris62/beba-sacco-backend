import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccountType,
  MpesaTriggerSource,
  MpesaTxType,
  Prisma,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService as AuditLogService } from '../modules/audit/audit.service';
import { DarajaClientService } from '../modules/mpesa/daraja-client.service';
import { toDecimal } from '../common/utils/decimal.util';

@Injectable()
export class MpesaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly daraja: DarajaClientService,
    private readonly auditLog: AuditLogService,
  ) {}

  async initiateStkPush(memberId: string, amount: string, description: string) {
    const depositAmount = toDecimal(amount);
    if (!depositAmount || depositAmount.lessThanOrEqualTo(0)) {
      throw new BadRequestException('Amount must be greater than zero');
    }

    const member = await this.prisma.member.findFirst({
      where: { id: memberId, isActive: true },
      include: {
        user: { select: { phone: true, phoneNumber: true } },
        accounts: {
          where: { accountType: AccountType.FOSA, isActive: true },
          select: { id: true, accountNumber: true },
          take: 1,
        },
      },
    });
    if (!member) throw new NotFoundException('Member profile not found');

    const phoneNumber = member.user.phone ?? member.user.phoneNumber;
    if (!phoneNumber) throw new BadRequestException('Member phone number is missing');

    const fosaAccount = member.accounts[0];
    if (!fosaAccount) throw new NotFoundException('Active FOSA account not found');

    const callbackBaseUrl = this.config.get<string>('app.mpesa.callbackUrl', '');
    const callbackUrl = `${callbackBaseUrl}/mpesa/callback`;
    const transactionDesc = description || 'FOSA deposit';

    const stkResponse = await this.daraja.initiateSTKPush({
      phoneNumber,
      amount: depositAmount.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber(),
      accountReference: fosaAccount.accountNumber,
      transactionDesc,
      callbackUrl,
    });

    const mpesaTransaction = await this.prisma.mpesaTransaction.create({
      data: {
        tenantId: member.tenantId,
        memberId: member.id,
        referenceType: AccountType.FOSA,
        referenceId: fosaAccount.id,
        type: MpesaTxType.STK_PUSH,
        triggerSource: MpesaTriggerSource.MEMBER,
        checkoutRequestId: stkResponse.CheckoutRequestID,
        merchantRequestId: stkResponse.MerchantRequestID,
        phoneNumber,
        amount: depositAmount,
        accountReference: fosaAccount.accountNumber,
        description: transactionDesc,
        reference: `STK-${stkResponse.CheckoutRequestID}`,
        status: TransactionStatus.PENDING,
      },
    });

    return {
      checkoutRequestId: stkResponse.CheckoutRequestID,
      merchantRequestId: stkResponse.MerchantRequestID,
      customerMessage: stkResponse.CustomerMessage,
      mpesaTransactionId: mpesaTransaction.id,
    };
  }

  async handleCallback(payload: any) {
    const callback = payload?.Body?.stkCallback;
    const checkoutRequestId = callback?.CheckoutRequestID;
    if (!checkoutRequestId) throw new BadRequestException('Missing CheckoutRequestID');

    const existing = await this.prisma.mpesaTransaction.findUnique({
      where: { checkoutRequestId },
      select: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException('M-Pesa transaction not found');
    if (existing.status === TransactionStatus.COMPLETED) return { success: true };

    const resultCode = Number(callback?.ResultCode);
    if (resultCode !== 0) {
      await this.prisma.mpesaTransaction.updateMany({
        where: { checkoutRequestId, status: { not: TransactionStatus.COMPLETED } },
        data: {
          status: TransactionStatus.FAILED,
          resultCode,
          resultDesc: callback?.ResultDesc ?? 'STK push failed',
          failureReason: callback?.ResultDesc ?? 'STK push failed',
          callbackPayload: payload,
        },
      });
      return { success: true };
    }

    const metadata = this.extractCallbackMetadata(callback);
    if (!metadata.mpesaReceiptNumber) throw new BadRequestException('Missing MpesaReceiptNumber');
    if (!metadata.amount) throw new BadRequestException('Missing callback amount');
    const callbackAmount = metadata.amount;
    const mpesaReceiptNumber = metadata.mpesaReceiptNumber;

    return this.prisma.$transaction(async (tx) => {
      const mpesaTransaction = await tx.mpesaTransaction.findUnique({
        where: { checkoutRequestId },
        select: {
          id: true,
          tenantId: true,
          memberId: true,
          amount: true,
          status: true,
          transactionId: true,
        },
      });
      if (!mpesaTransaction) throw new NotFoundException('M-Pesa transaction not found');
      if (mpesaTransaction.status === TransactionStatus.COMPLETED || mpesaTransaction.transactionId) {
        return { success: true };
      }
      if (mpesaTransaction.status !== TransactionStatus.PENDING) {
        throw new ConflictException('M-Pesa transaction is not pending');
      }

      const completionClaim = await tx.mpesaTransaction.updateMany({
        where: { id: mpesaTransaction.id, status: TransactionStatus.PENDING, transactionId: null },
        data: {
          status: TransactionStatus.COMPLETED,
          resultCode,
          resultDesc: callback?.ResultDesc ?? 'Success',
          mpesaReceiptNumber,
          transactionDate: metadata.transactionDate,
          callbackPayload: payload,
        },
      });
      if (completionClaim.count === 0) return { success: true };

      if (!mpesaTransaction.memberId) throw new NotFoundException('M-Pesa member link not found');
      const account = await tx.account.findFirst({
        where: {
          tenantId: mpesaTransaction.tenantId,
          memberId: mpesaTransaction.memberId,
          accountType: AccountType.FOSA,
          isActive: true,
        },
        select: { id: true, balance: true, version: true },
      });
      if (!account) throw new NotFoundException('Active FOSA account not found');

      const credited = await tx.account.updateMany({
        where: { id: account.id, version: account.version, accountType: AccountType.FOSA },
        data: { balance: { increment: callbackAmount }, version: { increment: 1 } },
      });
      if (credited.count === 0) {
        throw new ConflictException('Insufficient funds or concurrent modification');
      }

      const ledger = await tx.transaction.create({
        data: {
          tenantId: mpesaTransaction.tenantId,
          accountId: account.id,
          type: TransactionType.DEPOSIT,
          status: TransactionStatus.COMPLETED,
          amount: callbackAmount,
          balanceBefore: account.balance,
          balanceAfter: account.balance.plus(callbackAmount).toDecimalPlaces(4),
          reference: mpesaReceiptNumber,
          description: 'M-Pesa STK deposit to FOSA',
          processedBy: 'SYSTEM',
        },
      });

      await tx.mpesaTransaction.update({
        where: { id: mpesaTransaction.id },
        data: { transactionId: ledger.id },
      });

      await this.auditLog.createAtomic(tx, {
        tenantId: mpesaTransaction.tenantId,
        actorId: 'SYSTEM',
        action: 'MPESA.DEPOSIT.COMPLETED',
        entityType: 'Transaction',
        entityId: ledger.id,
        newValue: {
          accountId: account.id,
          amount: callbackAmount.toString(),
          mpesaReceiptNumber,
          checkoutRequestId,
        },
        metadata: { source: 'DARAJA_STK_CALLBACK' },
      });

      return { success: true };
    });
  }

  private extractCallbackMetadata(callback: any) {
    const items = callback?.CallbackMetadata?.Item ?? [];
    const getValue = (name: string) => items.find((item: { Name?: string }) => item.Name === name)?.Value;
    const rawTransactionDate = getValue('TransactionDate');

    return {
      amount: toDecimal(getValue('Amount')),
      mpesaReceiptNumber: getValue('MpesaReceiptNumber') as string | undefined,
      transactionDate: rawTransactionDate ? this.parseMpesaDate(String(rawTransactionDate)) : undefined,
    };
  }

  private parseMpesaDate(value: string): Date {
    const padded = value.padStart(14, '0');
    const year = Number(padded.slice(0, 4));
    const month = Number(padded.slice(4, 6)) - 1;
    const day = Number(padded.slice(6, 8));
    const hour = Number(padded.slice(8, 10));
    const minute = Number(padded.slice(10, 12));
    const second = Number(padded.slice(12, 14));
    return new Date(Date.UTC(year, month, day, hour - 3, minute, second));
  }
}


