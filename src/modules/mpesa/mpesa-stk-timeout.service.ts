/**
 * M-Pesa STK Push Timeout Cleanup Service
 *
 * Daraja STK Push prompts expire after ~2 minutes if the user does not
 * respond on their phone. Safaricom does NOT always send a timeout callback
 * (ResultCode != 0). This service runs every 2 minutes to mark stale
 * PENDING STK transactions as FAILED so they don't sit in limbo forever.
 *
 * SASRA compliance: stale PENDING transactions must be reconciled and
 * never left unresolved.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { TransactionStatus, MpesaTxType } from '@prisma/client';

@Injectable()
export class MpesaStkTimeoutService {
  private readonly logger = new Logger(MpesaStkTimeoutService.name);

  /** STK Push expiry threshold in milliseconds (2 minutes) */
  private readonly STK_TIMEOUT_MS = 2 * 60 * 1000;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs every 2 minutes to clean up expired STK Push transactions.
   */
  @Cron('*/2 * * * *')
  async cleanupStaleStkTransactions(): Promise<void> {
    const cutoff = new Date(Date.now() - this.STK_TIMEOUT_MS);

    const result = await this.prisma.mpesaTransaction.updateMany({
      where: {
        type: MpesaTxType.STK_PUSH,
        status: TransactionStatus.PENDING,
        createdAt: { lt: cutoff },
      },
      data: {
        status: TransactionStatus.FAILED,
        resultCode: 17, // Safaricom timeout code
        resultDesc: 'STK Push expired – user did not complete payment within 2 minutes',
      },
    });

    if (result.count > 0) {
      this.logger.log(
        `Marked ${result.count} expired STK Push transaction(s) as FAILED (older than ${this.STK_TIMEOUT_MS / 1000}s)`,
      );
    }
  }
}
