import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { MpesaTxType, TransactionStatus } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService as AuditLogService } from '../../audit/audit.service';
import { QUEUE_NAMES, RECONCILE_PENDING_STK_JOB } from '../queue.constants';

@Processor(QUEUE_NAMES.MPESA_RECONCILE_QUEUE, { concurrency: 1 })
export class MpesaReconcileProcessor extends WorkerHost {
  private readonly logger = new Logger(MpesaReconcileProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super();
  }

  async process(job: Job): Promise<{ reconciled: number }> {
    if (job.name !== RECONCILE_PENDING_STK_JOB) {
      this.logger.warn(`Ignoring unsupported job ${job.name}`);
      return { reconciled: 0 };
    }

    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    const pending = await this.prisma.mpesaTransaction.findMany({
      where: {
        type: MpesaTxType.STK_PUSH,
        status: TransactionStatus.PENDING,
        createdAt: { lt: cutoff },
      },
      select: { id: true, tenantId: true, reference: true, checkoutRequestId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });

    if (pending.length === 0) {
      return { reconciled: 0 };
    }

    const byTenant = new Map<string, typeof pending>();
    for (const tx of pending) {
      const rows = byTenant.get(tx.tenantId) ?? [];
      rows.push(tx);
      byTenant.set(tx.tenantId, rows);
    }

    let reconciled = 0;
    for (const [tenantId, rows] of byTenant.entries()) {
      const ids = rows.map((row) => row.id);
      const updated = await this.prisma.$transaction(async (tx) => {
        const result = await tx.mpesaTransaction.updateMany({
          where: { id: { in: ids }, tenantId, status: TransactionStatus.PENDING },
          data: {
            status: TransactionStatus.FAILED,
            failureReason: 'STK Push Timeout - Reconciliation',
            resultDesc: 'STK Push Timeout - Reconciliation',
          },
        });

        await this.auditLog.createAtomic(tx, {
          tenantId,
          actorId: 'SYSTEM',
          action: 'MPESA.STK.RECONCILE_TIMEOUT_BATCH',
          entityType: 'MpesaTransaction',
          metadata: {
            requestedJobId: job.id,
            cutoffIso: cutoff.toISOString(),
            attemptedCount: rows.length,
            reconciledCount: result.count,
            transactionIds: ids,
            references: rows.map((row) => row.reference),
          },
        });

        return result.count;
      });
      reconciled += updated;
    }

    this.logger.log(`Reconciled ${reconciled} stale STK transaction(s)`);
    return { reconciled };
  }
}
