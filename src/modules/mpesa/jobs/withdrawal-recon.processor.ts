import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { MpesaTxType, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { QUEUE_NAMES } from '../../queue/queue.constants';
import { maskPhone } from '../utils/mpesa.utils';

/**
 * Reconciliation sweep for non-terminal B2C rows.
 *
 * Timeout, missing callback, process crash, or a missing delayed BullMQ timeout
 * job are ambiguous provider outcomes. They do not prove the member was not
 * paid, so this worker never reverses a FOSA withdrawal by itself. Authoritative
 * provider failures still reverse through the callback/provider status paths via
 * LedgerService.reverseTransaction().
 */
@Processor(QUEUE_NAMES.MPESA_WITHDRAWAL_RECON, { concurrency: 1 })
export class WithdrawalReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(WithdrawalReconciliationProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<Record<string, never>>): Promise<void> {
    const graceMinutes = this.config.get<number>('app.mpesa.withdrawalReconGraceMinutes', 30);
    const cutoff = new Date(Date.now() - graceMinutes * 60 * 1000);

    await this.markOverduePendingB2cForReconciliation(job.id, graceMinutes);

    const stuck = await this.prisma.direct.mpesaTransaction.findMany({
      where: {
        referenceType: 'FOSA_WITHDRAWAL',
        status: TransactionStatus.RECON_PENDING,
        OR: [{ lastRecoveryAt: null }, { lastRecoveryAt: { lt: cutoff } }],
      },
      select: {
        id: true,
        tenantId: true,
        transactionId: true,
        amount: true,
        phoneNumber: true,
        conversationId: true,
        referenceId: true,
        failureReason: true,
      },
    });

    if (stuck.length === 0) return;

    let manualReview = 0;

    for (const row of stuck) {
      try {
        const requestId = `audit.MPESA.WITHDRAWAL.RECON_MANUAL_REVIEW_REQUIRED.${row.tenantId}.${row.id}`;
        const claimed = await this.prisma.direct.$transaction(async (tx) => {
          const existingAudit = await tx.auditLog.findUnique({ where: { requestId } });
          if (existingAudit) return false;

          const claim = await tx.mpesaTransaction.updateMany({
            where: { id: row.id, status: TransactionStatus.RECON_PENDING },
            data: { lastRecoveryAt: new Date() },
          });
          if (claim.count === 0) return false;

          await this.audit.createAtomic(tx, {
            tenantId: row.tenantId,
            actorId: 'SYSTEM',
            action: 'MPESA.WITHDRAWAL.RECON_MANUAL_REVIEW_REQUIRED',
            entityType: 'MpesaTransaction',
            entityId: row.id,
            newValue: {
              status: TransactionStatus.RECON_PENDING,
              reason: 'AMBIGUOUS_PROVIDER_OUTCOME',
            },
            metadata: {
              conversationId: row.conversationId,
              referenceId: row.referenceId,
              transactionId: row.transactionId,
              failureReason: row.failureReason,
              amount: row.amount.toString(),
              phone: maskPhone(row.phoneNumber),
              graceMinutes,
              automaticReversalUnsafe: true,
            },
            requestId,
          });
          return true;
        });

        if (claimed) {
          manualReview++;
          this.logger.error(
            `FOSA withdrawal requires provider reconciliation before reversal | ` +
              `mpesaTransactionId=${row.id} tenant=${row.tenantId} amount=${row.amount.toString()} ` +
              `phone=${maskPhone(row.phoneNumber)}`,
          );
        }
      } catch (error) {
        this.logger.error(
          `CRITICAL: withdrawal reconciliation audit failed - requires manual attention | ` +
            `mpesaTransactionId=${row.id} tenant=${row.tenantId}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    this.logger.log(
      `Withdrawal reconciliation sweep | job=${job.id} candidates=${stuck.length} manualReview=${manualReview}`,
    );
  }

  private async markOverduePendingB2cForReconciliation(
    jobId: string | number | undefined,
    historicalCutoffMinutes: number,
  ): Promise<void> {
    const now = new Date();
    const historicalCutoff = new Date(Date.now() - historicalCutoffMinutes * 60 * 1000);
    const dueRows = await this.prisma.direct.mpesaTransaction.findMany({
      where: {
        type: MpesaTxType.B2C,
        status: TransactionStatus.PENDING,
        OR: [
          { reconciliationDueAt: { lte: now } },
          { reconciliationDueAt: null, createdAt: { lt: historicalCutoff } },
        ],
      },
      select: {
        id: true,
        tenantId: true,
        conversationId: true,
        referenceId: true,
        referenceType: true,
        amount: true,
        phoneNumber: true,
        createdAt: true,
        reconciliationDueAt: true,
      },
      take: 100,
      orderBy: { reconciliationDueAt: 'asc' },
    });

    for (const row of dueRows) {
      await this.prisma.direct.$transaction(async (tx) => {
        const reason = row.reconciliationDueAt
          ? 'B2C_RECONCILIATION_DEADLINE_EXPIRED'
          : 'B2C_HISTORICAL_PENDING_WITHOUT_RECON_DEADLINE';
        const claim = await tx.mpesaTransaction.updateMany({
          where: { id: row.id, status: TransactionStatus.PENDING },
          data: {
            status: TransactionStatus.RECON_PENDING,
            failureReason: reason,
            resultDesc: row.reconciliationDueAt
              ? 'B2C reconciliation deadline expired before terminal provider callback'
              : 'Historical B2C pending row has no reconciliation deadline and requires provider reconciliation',
            lastRecoveryAt: new Date(),
          },
        });
        if (claim.count === 0) return;

        await this.audit.createAtomic(tx, {
          tenantId: row.tenantId,
          actorId: 'SYSTEM',
          action: 'MPESA.B2C.RECONCILIATION_DEADLINE_EXPIRED',
          entityType: 'MpesaTransaction',
          entityId: row.id,
          oldValue: { status: TransactionStatus.PENDING },
          newValue: {
            status: TransactionStatus.RECON_PENDING,
            failureReason: reason,
          },
          metadata: {
            conversationId: row.conversationId,
            referenceId: row.referenceId,
            referenceType: row.referenceType,
            amount: row.amount.toString(),
            phone: maskPhone(row.phoneNumber),
            createdAt: row.createdAt.toISOString(),
            reconciliationDueAt: row.reconciliationDueAt?.toISOString() ?? null,
            historicalNullDeadline: row.reconciliationDueAt == null,
            jobId: jobId == null ? null : String(jobId),
          },
          requestId: `audit.MPESA.B2C.RECONCILIATION_DEADLINE_EXPIRED.${row.tenantId}.${row.id}`,
        });
      });
    }
  }
}
