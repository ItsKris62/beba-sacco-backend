import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { TransactionStatus } from '@prisma/client';
import type { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { AuditLogJobPayload, QUEUE_NAMES } from '../queue/queue.constants';

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
    @Optional()
    @InjectQueue(QUEUE_NAMES.AUDIT_LOG)
    private readonly auditQueue?: Queue<AuditLogJobPayload>,
  ) {}

  async runReconciliation(tenantId: string, settlementDate: string): Promise<ReconReport> {
    const correlationId = uuidv4();
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
    let matchedCount = 0;
    let pendingCount = 0;
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
              checkoutRequestId: mpesaTxn.checkoutRequestId ?? mpesaTxn.id,
              darajaAmount: mpesaAmount.toNumber(),
              postedAmount: postedAmount.toNumber(),
              status: 'AMOUNT_MISMATCH',
              reason: `Daraja says ${mpesaAmount.toNumber()} but posted ${postedAmount.toNumber()}`,
            });
          } else {
            matchedCount++;
          }
        } else {
          // Completed in Mpesa but no Transaction record – flag
          mismatches.push({
            checkoutRequestId: mpesaTxn.checkoutRequestId ?? mpesaTxn.id,
            darajaAmount: mpesaAmount.toNumber(),
            postedAmount: null,
            status: 'MISSING_TRANSACTION',
            reason: 'MpesaTransaction completed but no Transaction record linked',
          });
        }
      } else if (mpesaTxn.status === TransactionStatus.PENDING) {
        const age = now.getTime() - mpesaTxn.createdAt.getTime();
        if (age > staleThreshold) {
          const flagReason = `Stale PENDING after ${Math.floor(age / 60000)} minutes`;
          // Flag stale PENDING as RECON_PENDING
          await this.prisma.mpesaTransaction.update({
            where: { id: mpesaTxn.id },
            data: {
              status: TransactionStatus.RECON_PENDING,
              resultDesc: flagReason,
            },
          });
          mismatches.push({
            checkoutRequestId: mpesaTxn.checkoutRequestId ?? mpesaTxn.id,
            darajaAmount: mpesaAmount.toNumber(),
            postedAmount: null,
            status: 'RECON_PENDING',
            reason: flagReason,
          });
          this.emitAuditLogNonBlocking(
            {
              tenantId,
              actorId: 'SYSTEM',
              userId: 'SYSTEM',
              action: 'RECON.FLAG_PENDING',
              entityType: 'TRANSACTION',
              resource: 'TRANSACTION',
              entityId: mpesaTxn.transactionId ?? mpesaTxn.id,
              resourceId: mpesaTxn.transactionId ?? mpesaTxn.id,
              oldValue: { status: TransactionStatus.PENDING },
              newValue: { status: TransactionStatus.RECON_PENDING },
              metadata: {
                correlationId,
                settlementDate,
                mismatch: {
                  checkoutRequestId: mpesaTxn.checkoutRequestId ?? mpesaTxn.id,
                  darajaAmount: mpesaAmount.toNumber(),
                  postedAmount: null,
                  reason: flagReason,
                },
                mpesaTransactionId: mpesaTxn.id,
              },
              requestId: `audit.RECON.FLAG_PENDING.${tenantId}.${mpesaTxn.id}.${settlementDate}`,
            },
            `audit.RECON.FLAG_PENDING.${tenantId}.${mpesaTxn.id}.${settlementDate}`,
            correlationId,
          );
          autoResolved++;
        } else {
          pendingCount++;
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
          duplicates.push(mpesaTxn.checkoutRequestId ?? mpesaTxn.id);
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

    this.emitAuditLogNonBlocking(
      {
        tenantId,
        actorId: 'SYSTEM',
        userId: 'SYSTEM',
        action: 'RECON.COMPLETE',
        entityType: 'RECONCILIATION',
        resource: 'RECONCILIATION',
        entityId: settlementDate,
        resourceId: settlementDate,
        metadata: {
          correlationId,
          settlementDate,
          matchedCount,
          pendingCount,
          flaggedTotal: autoResolved,
          mismatchCount: mismatches.length,
          duplicateCount: duplicates.length,
          totalDaraja: totalDaraja.toNumber(),
          totalPosted: totalPosted.toNumber(),
        },
        requestId: `audit.RECON.COMPLETE.${tenantId}.${settlementDate}`,
      },
      `audit.RECON.COMPLETE.${tenantId}.${settlementDate}`,
      correlationId,
    );

    return report;
  }

  async getLatestReport(tenantId: string, settlementDate: string): Promise<ReconReport | null> {
    const raw = await this.redis.get(`recon:report:${tenantId}:${settlementDate}`);
    if (!raw) return null;
    return JSON.parse(raw) as ReconReport;
  }

  private emptyReport(tenantId: string, settlementDate: string): ReconReport {
    return {
      settlementDate,
      tenantId,
      totalDaraja: 0,
      totalPosted: 0,
      mismatches: [],
      duplicates: [],
      autoResolved: 0,
    };
  }

  private emitAuditLogNonBlocking(
    payload: AuditLogJobPayload,
    jobId: string,
    correlationId: string,
  ): void {
    setImmediate(() => {
      this.auditQueue
        ?.add('domain-event', payload, {
          jobId,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: { age: 86400, count: 50 },
        })
        .catch((err: unknown) => {
          this.logger.error(
            JSON.stringify({
              event: 'audit.emit_failed',
              action: payload.action,
              entityId: payload.entityId ?? payload.resourceId,
              tenantId: payload.tenantId,
              correlationId,
              spanId: jobId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        });
    });
  }
}
