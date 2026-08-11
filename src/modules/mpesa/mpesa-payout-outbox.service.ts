import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { OutboxStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MpesaDisbursementJobPayload, QUEUE_NAMES } from '../queue/queue.constants';

const RETRY_DELAY_MS = 60_000;
const STALE_PROCESSING_MS = 5 * 60_000;

@Injectable()
export class MpesaPayoutOutboxService {
  private readonly logger = new Logger(MpesaPayoutOutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUE_NAMES.MPESA_DISBURSEMENT)
    private readonly disbursementQueue: Queue<MpesaDisbursementJobPayload>,
  ) {}

  async dispatchIntent(intentId: string): Promise<{ queued: boolean; jobId?: string }> {
    const intent = await this.prisma.mpesaPayoutIntent.findUnique({
      where: { id: intentId },
    });
    if (!intent) return { queued: false };
    if (intent.status === OutboxStatus.DELIVERED || intent.status === OutboxStatus.DEAD_LETTER) {
      return { queued: false, jobId: intent.jobId };
    }

    if (
      intent.referenceType !== 'FOSA_WITHDRAWAL' &&
      intent.referenceType !== 'LOAN_DISBURSEMENT'
    ) {
      await this.markQueueFailure(
        intent.id,
        `Unsupported payout referenceType=${intent.referenceType}`,
      );
      return { queued: false, jobId: intent.jobId };
    }

    const payload: MpesaDisbursementJobPayload = {
      payoutIntentId: intent.id,
      referenceType: intent.referenceType,
      referenceId: intent.referenceId,
      tenantId: intent.tenantId,
      phone: intent.phoneNumber,
      amount: Number(intent.amount),
      triggeredBy: intent.triggeredBy,
      sourceTransactionId: intent.sourceTransactionId,
    };

    try {
      await this.disbursementQueue.add(QUEUE_NAMES.MPESA_DISBURSEMENT, payload, {
        jobId: intent.jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: { age: 86400, count: 50 },
      });

      await this.prisma.mpesaPayoutIntent.update({
        where: { id: intent.id },
        data: {
          status: OutboxStatus.PROCESSING,
          lastError: null,
          nextRetryAt: null,
        },
      });
      return { queued: true, jobId: intent.jobId };
    } catch (error) {
      await this.markQueueFailure(
        intent.id,
        error instanceof Error ? error.message : String(error),
      );
      return { queued: false, jobId: intent.jobId };
    }
  }

  async dispatchDueIntents(limit = 50): Promise<number> {
    const now = new Date();
    const staleProcessingCutoff = new Date(Date.now() - STALE_PROCESSING_MS);
    const intents = await this.prisma.mpesaPayoutIntent.findMany({
      where: {
        OR: [
          {
            status: { in: [OutboxStatus.PENDING, OutboxStatus.FAILED] },
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
          },
          {
            status: OutboxStatus.PROCESSING,
            updatedAt: { lt: staleProcessingCutoff },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    let queued = 0;
    for (const intent of intents) {
      const result = await this.dispatchIntent(intent.id);
      if (result.queued) queued++;
    }
    if (queued > 0) {
      this.logger.log(`Dispatched ${queued}/${intents.length} durable M-Pesa payout intent(s)`);
    }
    return queued;
  }

  async markDelivered(params: {
    payoutIntentId?: string;
    sourceTransactionId?: string;
    mpesaTransactionId: string;
  }): Promise<void> {
    const where = params.payoutIntentId
      ? { id: params.payoutIntentId }
      : params.sourceTransactionId
        ? { sourceTransactionId: params.sourceTransactionId }
        : null;
    if (!where) return;

    await this.prisma.mpesaPayoutIntent.updateMany({
      where: {
        ...where,
        status: { not: OutboxStatus.DEAD_LETTER },
      },
      data: {
        status: OutboxStatus.DELIVERED,
        dispatchedAt: new Date(),
        mpesaTransactionId: params.mpesaTransactionId,
        lastError: null,
        nextRetryAt: null,
      },
    });
  }

  async markDeadLetter(params: {
    payoutIntentId?: string;
    sourceTransactionId?: string;
    tenantId: string;
    queueJobId?: string | number;
    retryCount: number;
    lastError?: string;
    payload: MpesaDisbursementJobPayload;
  }): Promise<void> {
    const where = params.payoutIntentId
      ? { id: params.payoutIntentId }
      : params.sourceTransactionId
        ? { sourceTransactionId: params.sourceTransactionId }
        : null;

    await this.prisma.$transaction(async (tx) => {
      const intent = where ? await tx.mpesaPayoutIntent.findUnique({ where }) : null;
      const auditEntityId =
        intent?.id ??
        params.payoutIntentId ??
        params.sourceTransactionId ??
        String(params.queueJobId ?? '');
      const requestId = `audit.MPESA.DISBURSEMENT.DLQ.${params.tenantId}.${auditEntityId}`;

      if (intent?.status === OutboxStatus.DEAD_LETTER) return;
      if (!intent) {
        const existingAudit = await tx.auditLog.findUnique({ where: { requestId } });
        if (existingAudit) return;
      }

      const deadLetteredAt = new Date();
      const updatedIntent = intent
        ? await tx.mpesaPayoutIntent.update({
            where: { id: intent.id },
            data: {
              status: OutboxStatus.DEAD_LETTER,
              attempts: { increment: 1 },
              lastError: params.lastError ?? 'Unknown B2C dispatch failure',
              deadLetteredAt,
              nextRetryAt: null,
            },
          })
        : null;

      await this.audit.createAtomic(tx, {
        tenantId: params.tenantId,
        actorId: 'SYSTEM',
        action: 'MPESA.DISBURSEMENT.DLQ',
        entityType: 'MpesaPayoutIntent',
        entityId: auditEntityId,
        newValue: {
          status: OutboxStatus.DEAD_LETTER,
          retryCount: params.retryCount,
          lastError: params.lastError,
        },
        metadata: {
          queueJobId: params.queueJobId == null ? null : String(params.queueJobId),
          payoutIntentId: updatedIntent?.id ?? params.payoutIntentId,
          mpesaTransactionId: updatedIntent?.mpesaTransactionId ?? null,
          sourceTransactionId: params.payload.sourceTransactionId,
          referenceId: params.payload.referenceId,
          referenceType: params.payload.referenceType,
          tenantId: params.payload.tenantId,
          amount: params.payload.amount,
          memberId: updatedIntent?.memberId ?? null,
          accountId: updatedIntent?.accountId ?? null,
          failedAt: deadLetteredAt.toISOString(),
        } satisfies Prisma.InputJsonObject,
        requestId,
      });
    });
  }

  private async markQueueFailure(intentId: string, message: string): Promise<void> {
    await this.prisma.mpesaPayoutIntent.update({
      where: { id: intentId },
      data: {
        status: OutboxStatus.FAILED,
        attempts: { increment: 1 },
        lastError: message,
        nextRetryAt: new Date(Date.now() + RETRY_DELAY_MS),
      },
    });
    this.logger.warn(`M-Pesa payout intent dispatch failed intent=${intentId}: ${message}`);
  }
}
