import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';

export interface ReconReport {
  settlementDate: string;
  tenantId: string;
  totalDaraja: number;
  totalPosted: number;
  mismatches: ReconMismatch[];
  duplicates: string[];
  autoResolved: number;
}

interface ReconMismatch {
  checkoutRequestId: string;
  darajaAmount: number;
  postedAmount: number | null;
  status: string;
  reason: string;
}

/**
 * ReconciliationService – Phase 4
 *
 * Compares the internal MpesaTransaction ledger against what Daraja
 * reported for a given settlement date.
 *
 * Strategy:
 *   1. Fetch all MpesaTransactions created on settlementDate
 *   2. Group by status: COMPLETED vs PENDING/FAILED
 *   3. Flag PENDING ones that are > 2 hours old as RECON_PENDING
 *   4. Auto-resolve exact duplicates (same CheckoutRequestID posted twice)
 *   5. Emit a daily settlement report
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  private readonly RECON_LOCK_TTL = 90_000; // 25 h in seconds
  // Transactions still PENDING after this many minutes are flagged
  private readonly PENDING_STALE_MINUTES = 120;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async runReconciliation(tenantId: string, settlementDate: string): Promise<ReconReport> {
    const lockKey = `recon:${tenantId}:${settlementDate}`;
    const locked = await this.redis.set(lockKey, '1', this.RECON_LOCK_TTL, true);
    if (!locked) {
      this.logger.warn(`Recon already ran for tenant=${tenantId} date=${settlementDate}`);
      return this.emptyReport(tenantId, settlementDate);
    }

    const dateStart = new Date(`${settlementDate}T00:00:00.000Z`);
    const dateEnd = new Date(`${settlementDate}T23:59:59.999Z`);

    const mpesaTxns = await this.prisma.mpesaTransaction.findMany({
      where: {
        tenantId,
        createdAt: { gte: dateStart, lte: dateEnd },
      },
      include: { transaction: { select: { amount: true, status: true } } },
    });

    const mismatches: ReconMismatch[] = [];
    const duplicates: string[] = [];
    let autoResolved = 0;
    let totalDaraja = new Decimal(0);
    let totalPosted = new Decimal(0);

    const now = new Date();
    const staleThreshold = this.PENDING_STALE_MINUTES * 60 * 1000;

    for (const mpesaTxn of mpesaTxns) {
      const mpesaAmount = new Decimal(mpesaTxn.amount.toString());

      if (mpesaTxn.status === TransactionStatus.COMPLETED) {
        totalDaraja = totalDaraja.plus(mpesaAmount);
        if (mpesaTxn.transaction) {
          const postedAmount = new Decimal(mpesaTxn.transaction.amount.toString());
          totalPosted = totalPosted.plus(postedAmount);

          if (!mpesaAmount.equals(postedAmount)) {
            mismatches.push({
              checkoutRequestId: mpesaTxn.checkoutRequestId,
              darajaAmount: mpesaAmount.toNumber(),
              postedAmount: postedAmount.toNumber(),
              status: 'AMOUNT_MISMATCH',
              reason: `Daraja says ${mpesaAmount.toNumber()} but posted ${postedAmount.toNumber()}`,
            });
          }
        } else {
          // Completed in Mpesa but no Transaction record – flag
          mismatches.push({
            checkoutRequestId: mpesaTxn.checkoutRequestId,
            darajaAmount: mpesaAmount.toNumber(),
            postedAmount: null,
            status: 'MISSING_TRANSACTION',
            reason: 'MpesaTransaction completed but no Transaction record linked',
          });
        }
      } else if (mpesaTxn.status === TransactionStatus.PENDING) {
        const age = now.getTime() - mpesaTxn.createdAt.getTime();
        if (age > staleThreshold) {
          // Flag stale PENDING as RECON_PENDING
          await this.prisma.mpesaTransaction.update({
            where: { id: mpesaTxn.id },
            data: { status: TransactionStatus.RECON_PENDING },
          });
          mismatches.push({
            checkoutRequestId: mpesaTxn.checkoutRequestId,
            darajaAmount: mpesaAmount.toNumber(),
            postedAmount: null,
            status: 'RECON_PENDING',
            reason: `Stale PENDING after ${Math.floor(age / 60000)} minutes`,
          });
          autoResolved++;
        }
      }

      // Detect duplicate receipts (same mpesaReceiptNumber posted twice)
      if (mpesaTxn.mpesaReceiptNumber) {
        const dupeCount = await this.prisma.mpesaTransaction.count({
          where: {
            tenantId,
            mpesaReceiptNumber: mpesaTxn.mpesaReceiptNumber,
            id: { not: mpesaTxn.id },
          },
        });
        if (dupeCount > 0) {
          duplicates.push(mpesaTxn.checkoutRequestId);
        }
      }
    }

    const report: ReconReport = {
      settlementDate,
      tenantId,
      totalDaraja: totalDaraja.toNumber(),
      totalPosted: totalPosted.toNumber(),
      mismatches,
      duplicates,
      autoResolved,
    };

    if (mismatches.length > 0 || duplicates.length > 0) {
      this.logger.warn(
        `Recon mismatches: tenant=${tenantId} date=${settlementDate} mismatches=${mismatches.length} dupes=${duplicates.length}`,
        report,
      );
    } else {
      this.logger.log(
        `Recon clean: tenant=${tenantId} date=${settlementDate} totalPosted=${totalPosted.toNumber()}`,
      );
    }

    // Cache the report for 48h so the admin dashboard can read it
    await this.redis.set(
      `recon:report:${tenantId}:${settlementDate}`,
      JSON.stringify(report),
      172_800, // 48 h
    );

    return report;
  }

  async getLatestReport(tenantId: string, settlementDate: string): Promise<ReconReport | null> {
    const raw = await this.redis.get(`recon:report:${tenantId}:${settlementDate}`);
    if (!raw) return null;
    return JSON.parse(raw) as ReconReport;
  }

  private emptyReport(tenantId: string, settlementDate: string): ReconReport {
    return { settlementDate, tenantId, totalDaraja: 0, totalPosted: 0, mismatches: [], duplicates: [], autoResolved: 0 };
  }
}
