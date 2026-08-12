import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ComplianceAlertSeverity,
  MpesaTxType,
  OutboxStatus,
  Prisma,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { Decimal } from 'decimal.js';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../accounting/ledger.service';
import { MetricsService } from '../metrics/metrics.service';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { MpesaPayoutOutboxService } from './mpesa-payout-outbox.service';
import { MpesaService } from './mpesa.service';
import {
  ControlledResendDto,
  ManualCompletionDto,
  ManualReconciliationEvidenceDto,
  ManualReversalDto,
  ManualStatusRefreshDto,
} from './dto/reconciliation-recover.dto';
import { maskPhone } from './utils/mpesa.utils';

const PROVIDER_CONTACT_STATES = [
  'PROVIDER_SEND_ATTEMPTED',
  'PROVIDER_ACCEPTED',
  'PROVIDER_OUTCOME_UNKNOWN',
  'COMPLETED',
  'FAILED',
];

type ReconTrigger = 'AUTOMATED' | 'MANUAL_REFRESH' | 'MANUAL_COMPLETE' | 'MANUAL_REVERSE';

export interface WithdrawalReconCase {
  mpesaTransactionId?: string;
  payoutIntentId?: string;
  ledgerTransactionId?: string;
  caseType:
    | 'STALE_WITHDRAWAL'
    | 'RECON_PENDING'
    | 'STALE_PAYOUT_INTENT'
    | 'DEBIT_WITHOUT_PAYOUT'
    | 'DEAD_LETTER'
    | 'PROVIDER_MISMATCH'
    | 'MANUAL_REVIEW_REQUIRED';
  status?: TransactionStatus | OutboxStatus;
  ageSeconds: number;
  amount?: number;
  phoneNumber?: string;
  memberId?: string | null;
  accountId?: string | null;
  provider?: string | null;
  providerReference?: string | null;
  attemptCount?: number;
  lastProviderCheck?: Date | null;
  nextRetryAt?: Date | null;
  manualReviewRequired?: boolean;
  reason?: string | null;
}

@Injectable()
export class WithdrawalReconciliationService {
  private readonly logger = new Logger(WithdrawalReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly mpesaService: MpesaService,
    private readonly payoutOutbox: MpesaPayoutOutboxService,
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async runAutomatedSweep(jobId?: string | number): Promise<{
    reconciled: number;
    anomalies: number;
    staleOutbox: number;
  }> {
    const staleOutbox = await this.detectStalePayoutIntents(jobId);
    const debitAnomalies = await this.detectDebitWithoutPayout(jobId);
    const eligible = await this.selectEligibleProviderTransactions();

    let reconciled = 0;
    for (const row of eligible) {
      const result = await this.reconcileTransaction(row.id, {
        trigger: 'AUTOMATED',
        actorId: 'SYSTEM',
        reason: 'Scheduled withdrawal reconciliation sweep',
        jobId,
      });
      if (result.action !== 'SKIPPED') reconciled++;
    }

    await this.refreshOperationalGauges();
    return { reconciled, anomalies: debitAnomalies, staleOutbox };
  }

  async listOperationalCases(
    tenantId: string,
    opts: { limit?: number; offset?: number; fromDate?: Date; toDate?: Date } = {},
  ): Promise<{ data: WithdrawalReconCase[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(100, Math.max(1, Number(opts.limit ?? 20)));
    const offset = Math.max(0, Number(opts.offset ?? 0));
    const now = Date.now();
    const dateFilter =
      opts.fromDate || opts.toDate
        ? { ...(opts.fromDate && { gte: opts.fromDate }), ...(opts.toDate && { lte: opts.toDate }) }
        : undefined;

    const mpesaRows = await this.prisma.mpesaTransaction.findMany({
      where: {
        tenantId,
        referenceType: 'FOSA_WITHDRAWAL',
        OR: [
          { status: { in: [TransactionStatus.PENDING, TransactionStatus.RECON_PENDING] } },
          { manualReviewRequired: true },
        ],
        ...(dateFilter && { updatedAt: dateFilter }),
      },
      select: {
        id: true,
        amount: true,
        phoneNumber: true,
        memberId: true,
        referenceId: true,
        status: true,
        conversationId: true,
        providerSubmissionState: true,
        providerLastCheckedAt: true,
        reconciliationAttemptCount: true,
        reconciliationNextRetryAt: true,
        manualReviewRequired: true,
        manualReviewReason: true,
        failureReason: true,
        updatedAt: true,
        createdAt: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: 500,
    });

    const intents = await this.prisma.mpesaPayoutIntent.findMany({
      where: {
        tenantId,
        referenceType: 'FOSA_WITHDRAWAL',
        status: {
          in: [
            OutboxStatus.PENDING,
            OutboxStatus.PROCESSING,
            OutboxStatus.FAILED,
            OutboxStatus.DEAD_LETTER,
          ],
        },
        ...(dateFilter && { updatedAt: dateFilter }),
      },
      select: {
        id: true,
        status: true,
        amount: true,
        phoneNumber: true,
        memberId: true,
        accountId: true,
        provider: true,
        sourceTransactionId: true,
        mpesaTransactionId: true,
        attempts: true,
        nextRetryAt: true,
        lastError: true,
        updatedAt: true,
        createdAt: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: 500,
    });

    const cases: WithdrawalReconCase[] = [
      ...mpesaRows.map(
        (row): WithdrawalReconCase => ({
          mpesaTransactionId: row.id,
          caseType: row.manualReviewRequired
            ? 'MANUAL_REVIEW_REQUIRED'
            : row.status === TransactionStatus.RECON_PENDING
              ? 'RECON_PENDING'
              : 'STALE_WITHDRAWAL',
          status: row.status,
          ageSeconds: Math.floor((now - row.createdAt.getTime()) / 1000),
          amount: new Decimal(row.amount.toString()).toNumber(),
          phoneNumber: maskPhone(row.phoneNumber),
          memberId: row.memberId,
          accountId: row.referenceId,
          provider: 'MWALONI',
          providerReference: row.conversationId,
          attemptCount: row.reconciliationAttemptCount,
          lastProviderCheck: row.providerLastCheckedAt,
          nextRetryAt: row.reconciliationNextRetryAt,
          manualReviewRequired: row.manualReviewRequired,
          reason: row.manualReviewReason ?? row.failureReason ?? row.providerSubmissionState,
        }),
      ),
      ...intents.map(
        (intent): WithdrawalReconCase => ({
          payoutIntentId: intent.id,
          mpesaTransactionId: intent.mpesaTransactionId ?? undefined,
          ledgerTransactionId: intent.sourceTransactionId,
          caseType:
            intent.status === OutboxStatus.DEAD_LETTER ? 'DEAD_LETTER' : 'STALE_PAYOUT_INTENT',
          status: intent.status,
          ageSeconds: Math.floor((now - intent.createdAt.getTime()) / 1000),
          amount: new Decimal(intent.amount.toString()).toNumber(),
          phoneNumber: maskPhone(intent.phoneNumber),
          memberId: intent.memberId,
          accountId: intent.accountId,
          provider: intent.provider,
          attemptCount: intent.attempts,
          nextRetryAt: intent.nextRetryAt,
          manualReviewRequired: intent.status === OutboxStatus.DEAD_LETTER,
          reason: intent.lastError,
        }),
      ),
    ].sort((a, b) => b.ageSeconds - a.ageSeconds);

    return { data: cases.slice(offset, offset + limit), total: cases.length, limit, offset };
  }

  async refreshProviderStatus(
    mpesaTransactionId: string,
    tenantId: string,
    actorId: string,
    dto: ManualStatusRefreshDto = {},
    ipAddress?: string,
  ) {
    const row = await this.requireWithdrawal(mpesaTransactionId, tenantId);
    return this.reconcileTransaction(row.id, {
      trigger: 'MANUAL_REFRESH',
      actorId,
      reason: dto.reason ?? 'Manual provider-status refresh',
      ipAddress,
    });
  }

  async markCompletedWithEvidence(
    mpesaTransactionId: string,
    tenantId: string,
    actorId: string,
    dto: ManualCompletionDto,
    ipAddress?: string,
  ) {
    const row = await this.requireWithdrawal(mpesaTransactionId, tenantId);
    this.requireEvidence(dto);

    return this.prisma.directClient.$transaction(
      async (tx) => {
        const attempt = await this.createAttempt(tx, row, 'MANUAL_COMPLETE', actorId);
        const claim = await tx.mpesaTransaction.updateMany({
          where: {
            id: row.id,
            tenantId,
            status: { in: [TransactionStatus.PENDING, TransactionStatus.RECON_PENDING] },
          },
          data: {
            status: TransactionStatus.COMPLETED,
            manualReviewRequired: false,
            manualReviewReason: null,
            reconciliationNextRetryAt: null,
            reconciliationLockedAt: null,
            reconciliationLockedBy: null,
            reconciliationLastReason: 'MANUAL_COMPLETED_WITH_EVIDENCE',
            providerLastCheckedAt: new Date(),
            resultDesc: `Manually completed with provider evidence ${dto.evidenceReference}`,
          },
        });
        if (claim.count === 0)
          throw new ConflictException('Withdrawal is already terminal or being reconciled');

        await tx.mpesaWithdrawalReconciliationAttempt.update({
          where: { id: attempt.id },
          data: {
            completedAt: new Date(),
            providerRequestReference: row.conversationId,
            oldStatus: row.status,
            newStatus: TransactionStatus.COMPLETED,
            reasonCode: 'MANUAL_COMPLETED_WITH_EVIDENCE',
            providerResult: this.evidenceJson(dto),
            correlationResult: { acceptedBy: 'AUTHORIZED_ADMIN_EVIDENCE' },
          },
        });

        await this.auditManualAction(tx, {
          tenantId,
          actorId,
          action: 'MPESA.WITHDRAWAL.MANUAL_COMPLETE',
          entityId: row.id,
          oldStatus: row.status,
          newStatus: TransactionStatus.COMPLETED,
          dto,
          ipAddress,
        });

        this.metrics?.recordWithdrawalCompleted(tenantId, 'manual_reconciliation');
        this.metrics?.recordB2cReconciliationSuccess(tenantId, 'manual_completed');
        return {
          mpesaTransactionId: row.id,
          action: 'MANUAL_COMPLETE',
          status: TransactionStatus.COMPLETED,
        };
      },
      { isolationLevel: 'Serializable' },
    );
  }

  async reverseConfirmedFailure(
    mpesaTransactionId: string,
    tenantId: string,
    actorId: string,
    dto: ManualReversalDto,
    ipAddress?: string,
  ) {
    const row = await this.requireWithdrawal(mpesaTransactionId, tenantId);
    this.requireEvidence(dto);
    if (!row.transactionId) {
      throw new BadRequestException(
        'No linked ledger debit exists; cannot reverse through LedgerService',
      );
    }
    const originalTransactionId = row.transactionId;

    return this.prisma.directClient.$transaction(
      async (tx) => {
        const attempt = await this.createAttempt(tx, row, 'MANUAL_REVERSE', actorId);
        const claim = await tx.mpesaTransaction.updateMany({
          where: {
            id: row.id,
            tenantId,
            status: { in: [TransactionStatus.PENDING, TransactionStatus.RECON_PENDING] },
          },
          data: {
            status: TransactionStatus.FAILED,
            failureReason: 'MANUAL_CONFIRMED_PROVIDER_FAILURE',
            resultDesc: `Manual reversal with evidence ${dto.evidenceReference}`,
            manualReviewRequired: false,
            manualReviewReason: null,
            reconciliationNextRetryAt: null,
            reconciliationLockedAt: null,
            reconciliationLockedBy: null,
            reconciliationLastReason: 'MANUAL_CONFIRMED_PROVIDER_FAILURE',
            providerLastCheckedAt: new Date(),
          },
        });
        if (claim.count === 0)
          throw new ConflictException('Withdrawal is already terminal or being reconciled');

        const reversal = await this.ledger.reverseTransaction({
          tenantId,
          originalTransactionId,
          reason: `Manual confirmed B2C failure: ${dto.reason} (${dto.evidenceReference})`,
          reversedByUserId: actorId,
          tx,
        });

        await tx.mpesaWithdrawalReconciliationAttempt.update({
          where: { id: attempt.id },
          data: {
            completedAt: new Date(),
            providerRequestReference: row.conversationId,
            oldStatus: row.status,
            newStatus: TransactionStatus.FAILED,
            reasonCode: 'MANUAL_CONFIRMED_PROVIDER_FAILURE',
            providerResult: this.evidenceJson(dto),
            correlationResult: { reversalTransactionId: reversal.transaction.id },
          },
        });

        await this.auditManualAction(tx, {
          tenantId,
          actorId,
          action: 'MPESA.WITHDRAWAL.MANUAL_REVERSE',
          entityId: row.id,
          oldStatus: row.status,
          newStatus: TransactionStatus.FAILED,
          dto,
          ipAddress,
          metadata: { reversalTransactionId: reversal.transaction.id },
        });

        this.metrics?.recordWithdrawalFailed(
          tenantId,
          'manual_reconciliation',
          'confirmed_provider_failure',
        );
        this.metrics?.recordWithdrawalReversed(tenantId, 'manual_reconciliation');
        this.metrics?.recordB2cReconciliationSuccess(tenantId, 'manual_reversed');
        return {
          mpesaTransactionId: row.id,
          action: 'MANUAL_REVERSE',
          status: TransactionStatus.FAILED,
          reversalTransactionId: reversal.transaction.id,
        };
      },
      { isolationLevel: 'Serializable' },
    );
  }

  async controlledResend(
    mpesaTransactionId: string,
    tenantId: string,
    actorId: string,
    dto: ControlledResendDto,
    ipAddress?: string,
  ) {
    const row = await this.requireWithdrawal(mpesaTransactionId, tenantId);
    this.requireEvidence(dto);
    await this.audit.create({
      tenantId,
      actorId,
      action: 'MPESA.WITHDRAWAL.MANUAL_RESEND_BLOCKED',
      entityType: 'MpesaTransaction',
      entityId: row.id,
      oldValue: { status: row.status },
      newValue: { action: 'CONTROLLED_RESEND_BLOCKED' },
      metadata: {
        reason: dto.reason,
        evidenceReference: dto.evidenceReference,
        evidenceNote: dto.evidenceNote ?? null,
        providerSubmissionState: row.providerSubmissionState,
        providerSendAttemptedAt: row.providerSendAttemptedAt?.toISOString() ?? null,
        automaticDuplicatePayoutProtection: true,
      },
      ipAddress,
    });
    throw new BadRequestException(
      'CONTROLLED_RESEND is blocked until non-submission can be proven by a formal provider reconciliation workflow',
    );
  }

  private async reconcileTransaction(
    mpesaTransactionId: string,
    params: {
      trigger: ReconTrigger;
      actorId: string;
      reason: string;
      ipAddress?: string;
      jobId?: string | number;
    },
  ) {
    const claimed = await this.claim(mpesaTransactionId, params.trigger, params.actorId);
    if (!claimed)
      return { mpesaTransactionId, action: 'SKIPPED', reason: 'not_eligible_or_locked' };

    const attempt = await this.createAttempt(this.prisma, claimed, params.trigger, params.actorId);
    this.metrics?.recordB2cReconciliationAttempt(claimed.tenantId, params.trigger, 'MWALONI');
    await this.audit.create({
      tenantId: claimed.tenantId,
      actorId: params.actorId,
      action: 'MPESA.WITHDRAWAL.RECON_STARTED',
      entityType: 'MpesaTransaction',
      entityId: claimed.id,
      oldValue: { status: claimed.status },
      metadata: {
        trigger: params.trigger,
        reason: params.reason,
        attemptNumber: attempt.attemptNumber,
        orderNumber: claimed.conversationId,
        providerSubmissionState: claimed.providerSubmissionState,
        jobId: params.jobId == null ? null : String(params.jobId),
      },
      ipAddress: params.ipAddress,
    });

    try {
      if (!this.wasProviderContacted(claimed)) {
        await this.completeAttemptAndSchedule(attempt.id, claimed, {
          reasonCode: 'PROVIDER_NOT_CONTACTED_OR_UNKNOWN_LOCAL_STATE',
          errorCategory: 'LOCAL_ANOMALY',
          nextRetryAt: this.nextRetry(claimed.reconciliationAttemptCount + 1),
          manualReviewRequired: true,
          manualReviewReason:
            'Provider submission was not durably attempted; inspect payout intent/outbox before action',
        });
        await this.raiseOperationalAlertOnce({
          tenantId: claimed.tenantId,
          entityType: 'MpesaTransaction',
          entityId: claimed.id,
          action: 'MPESA.WITHDRAWAL.ANOMALY_DETECTED',
          severity: ComplianceAlertSeverity.CRITICAL,
          message: 'B2C withdrawal has no durable provider-contact evidence',
          details: { providerSubmissionState: claimed.providerSubmissionState },
        });
        return {
          mpesaTransactionId,
          action: 'MANUAL_REVIEW',
          status: TransactionStatus.RECON_PENDING,
        };
      }

      await this.audit.create({
        tenantId: claimed.tenantId,
        actorId: params.actorId,
        action: 'MPESA.WITHDRAWAL.PROVIDER_STATUS_QUERIED',
        entityType: 'MpesaTransaction',
        entityId: claimed.id,
        metadata: {
          provider: 'MWALONI',
          orderNumber: claimed.conversationId,
          attemptNumber: attempt.attemptNumber,
        },
        ipAddress: params.ipAddress,
      });

      const providerStatus = await this.mpesaService.refreshMwaloniB2cStatus(claimed.id);
      const after = await this.prisma.mpesaTransaction.findUniqueOrThrow({
        where: { id: claimed.id },
      });
      const outcome = this.classifyOutcome(
        after,
        providerStatus,
        claimed.reconciliationAttemptCount + 1,
      );
      await this.completeAttemptAndSchedule(attempt.id, claimed, outcome);

      await this.audit.create({
        tenantId: claimed.tenantId,
        actorId: params.actorId,
        action: this.auditActionForOutcome(outcome.reasonCode),
        entityType: 'MpesaTransaction',
        entityId: claimed.id,
        oldValue: { status: claimed.status },
        newValue: {
          status: after.status,
          manualReviewRequired: outcome.manualReviewRequired,
          nextRetryAt: outcome.nextRetryAt?.toISOString() ?? null,
        },
        metadata: {
          provider: 'MWALONI',
          orderNumber: claimed.conversationId,
          attemptNumber: attempt.attemptNumber,
          providerStatus,
          reasonCode: outcome.reasonCode,
        } satisfies Prisma.InputJsonObject,
        ipAddress: params.ipAddress,
      });

      if (after.status === TransactionStatus.COMPLETED) {
        this.metrics?.recordWithdrawalCompleted(claimed.tenantId, 'reconciliation');
        this.metrics?.recordB2cReconciliationSuccess(claimed.tenantId, 'provider_success');
      } else if (after.status === TransactionStatus.FAILED) {
        this.metrics?.recordWithdrawalFailed(
          claimed.tenantId,
          'reconciliation',
          'provider_failure',
        );
        this.metrics?.recordWithdrawalReversed(claimed.tenantId, 'reconciliation');
        this.metrics?.recordB2cReconciliationSuccess(claimed.tenantId, 'provider_failure_reversed');
      } else {
        this.metrics?.recordB2cReconciliationFailure(claimed.tenantId, outcome.reasonCode);
      }

      return {
        mpesaTransactionId,
        action: 'REFRESH_PROVIDER_STATUS',
        status: after.status,
        terminal:
          after.status === TransactionStatus.COMPLETED || after.status === TransactionStatus.FAILED,
        manualReviewRequired: outcome.manualReviewRequired,
        nextRetryAt: outcome.nextRetryAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.completeAttemptAndSchedule(attempt.id, claimed, {
        reasonCode: 'PROVIDER_STATUS_UNAVAILABLE',
        errorCategory: 'PROVIDER_UNAVAILABLE',
        providerResult: { error: message.slice(0, 240) },
        nextRetryAt: this.nextRetry(claimed.reconciliationAttemptCount + 1),
        manualReviewRequired: this.shouldManualReview(
          claimed,
          claimed.reconciliationAttemptCount + 1,
        ),
        manualReviewReason: 'Provider status unavailable beyond automated retry policy',
      });
      this.metrics?.recordB2cReconciliationFailure(claimed.tenantId, 'provider_unavailable');
      return { mpesaTransactionId, action: 'RETRY_SCHEDULED', status: claimed.status };
    }
  }

  private async selectEligibleProviderTransactions() {
    const now = new Date();
    const cutoff = new Date(Date.now() - this.pendingThresholdMs());
    const staleLockCutoff = new Date(Date.now() - this.lockTtlMs());
    return this.prisma.mpesaTransaction.findMany({
      where: {
        type: MpesaTxType.B2C,
        referenceType: 'FOSA_WITHDRAWAL',
        status: { in: [TransactionStatus.PENDING, TransactionStatus.RECON_PENDING] },
        manualReviewRequired: false,
        OR: [
          { reconciliationNextRetryAt: { lte: now } },
          { reconciliationNextRetryAt: null, reconciliationDueAt: { lte: now } },
          {
            reconciliationNextRetryAt: null,
            reconciliationDueAt: null,
            createdAt: { lte: cutoff },
          },
        ],
        AND: [
          {
            OR: [
              { reconciliationLockedAt: null },
              { reconciliationLockedAt: { lt: staleLockCutoff } },
            ],
          },
        ],
      },
      orderBy: [{ reconciliationNextRetryAt: 'asc' }, { createdAt: 'asc' }],
      take: 50,
    });
  }

  private async detectStalePayoutIntents(jobId?: string | number): Promise<number> {
    const cutoff = new Date(Date.now() - this.staleOutboxMs());
    const intents = await this.prisma.mpesaPayoutIntent.findMany({
      where: {
        referenceType: 'FOSA_WITHDRAWAL',
        status: {
          in: [
            OutboxStatus.PENDING,
            OutboxStatus.PROCESSING,
            OutboxStatus.FAILED,
            OutboxStatus.DEAD_LETTER,
          ],
        },
        updatedAt: { lte: cutoff },
      },
      take: 100,
      orderBy: { updatedAt: 'asc' },
    });

    for (const intent of intents) {
      const providerTx = await this.prisma.mpesaTransaction.findFirst({
        where: { transactionId: intent.sourceTransactionId, referenceType: 'FOSA_WITHDRAWAL' },
        select: { id: true, providerSubmissionState: true, providerSendAttemptedAt: true },
      });

      if (intent.status === OutboxStatus.DEAD_LETTER) {
        await this.raiseOperationalAlertOnce({
          tenantId: intent.tenantId,
          entityType: 'MpesaPayoutIntent',
          entityId: intent.id,
          action: 'MPESA.WITHDRAWAL.RECON_DLQ',
          severity: ComplianceAlertSeverity.CRITICAL,
          message: 'B2C payout intent is in dead letter and requires manual review',
          details: {
            jobId: intent.jobId,
            sourceTransactionId: intent.sourceTransactionId,
            jobIdFromSweep: jobId,
          },
        });
        continue;
      }

      if (!providerTx) {
        const dispatch = await this.payoutOutbox.dispatchIntent(intent.id);
        await this.raiseOperationalAlertOnce({
          tenantId: intent.tenantId,
          entityType: 'MpesaPayoutIntent',
          entityId: intent.id,
          action: 'MPESA.WITHDRAWAL.STALE_PAYOUT_INTENT_DETECTED',
          severity: ComplianceAlertSeverity.WARNING,
          message:
            'Stale B2C payout intent detected and safely re-dispatched before provider contact',
          details: {
            status: intent.status,
            sourceTransactionId: intent.sourceTransactionId,
            queued: dispatch.queued,
            jobId: dispatch.jobId,
          },
        });
      } else if (
        providerTx.providerSendAttemptedAt ||
        PROVIDER_CONTACT_STATES.includes(providerTx.providerSubmissionState ?? '')
      ) {
        await this.raiseOperationalAlertOnce({
          tenantId: intent.tenantId,
          entityType: 'MpesaPayoutIntent',
          entityId: intent.id,
          action: 'MPESA.WITHDRAWAL.STALE_PAYOUT_INTENT_WITH_PROVIDER_TX',
          severity: ComplianceAlertSeverity.WARNING,
          message: 'Stale payout intent has provider transaction evidence; no redispatch attempted',
          details: {
            mpesaTransactionId: providerTx.id,
            providerSubmissionState: providerTx.providerSubmissionState,
          },
        });
      }
    }
    return intents.length;
  }

  private async detectDebitWithoutPayout(jobId?: string | number): Promise<number> {
    const cutoff = new Date(Date.now() - this.staleOutboxMs());
    const rows = await this.prisma.transaction.findMany({
      where: {
        type: TransactionType.WITHDRAWAL,
        status: TransactionStatus.COMPLETED,
        reference: { startsWith: 'MPESA_WD-' },
        createdAt: { lte: cutoff },
      },
      select: {
        id: true,
        tenantId: true,
        reference: true,
        amount: true,
        accountId: true,
        createdAt: true,
      },
      take: 100,
      orderBy: { createdAt: 'asc' },
    });

    let anomalies = 0;
    for (const row of rows) {
      const [intent, mpesaTx] = await Promise.all([
        this.prisma.mpesaPayoutIntent.findUnique({
          where: { sourceTransactionId: row.id },
          select: { id: true },
        }),
        this.prisma.mpesaTransaction.findUnique({
          where: { transactionId: row.id },
          select: { id: true },
        }),
      ]);
      if (intent || mpesaTx) continue;
      anomalies++;
      await this.raiseOperationalAlertOnce({
        tenantId: row.tenantId,
        entityType: 'Transaction',
        entityId: row.id,
        action: 'MPESA.WITHDRAWAL.DEBIT_WITHOUT_PAYOUT_ANOMALY',
        severity: ComplianceAlertSeverity.CRITICAL,
        message: 'Ledger withdrawal debit exists without payout intent or M-Pesa transaction',
        details: {
          reference: row.reference,
          accountId: row.accountId,
          amount: row.amount.toString(),
          createdAt: row.createdAt.toISOString(),
          jobId: jobId == null ? null : String(jobId),
          automaticReversalUnsafe: true,
        },
      });
    }
    return anomalies;
  }

  private async claim(mpesaTransactionId: string, trigger: ReconTrigger, actorId: string) {
    const staleLockCutoff = new Date(Date.now() - this.lockTtlMs());
    const claim = await this.prisma.mpesaTransaction.updateMany({
      where: {
        id: mpesaTransactionId,
        status: { in: [TransactionStatus.PENDING, TransactionStatus.RECON_PENDING] },
        OR: [{ reconciliationLockedAt: null }, { reconciliationLockedAt: { lt: staleLockCutoff } }],
      },
      data: {
        reconciliationLockedAt: new Date(),
        reconciliationLockedBy: `${trigger}:${actorId}`,
      },
    });
    if (claim.count === 0) return null;
    return this.prisma.mpesaTransaction.findUniqueOrThrow({ where: { id: mpesaTransactionId } });
  }

  private async createAttempt(
    client: Prisma.TransactionClient | PrismaService,
    row: {
      id: string;
      tenantId: string;
      status: TransactionStatus;
      conversationId: string | null;
      transactionId: string | null;
      reconciliationAttemptCount: number;
    },
    trigger: ReconTrigger,
    actorId: string,
  ) {
    const payoutIntent = row.transactionId
      ? await client.mpesaPayoutIntent.findUnique({
          where: { sourceTransactionId: row.transactionId },
          select: { id: true },
        })
      : null;
    return client.mpesaWithdrawalReconciliationAttempt.create({
      data: {
        tenantId: row.tenantId,
        mpesaTransactionId: row.id,
        payoutIntentId: payoutIntent?.id ?? null,
        provider: 'MWALONI',
        attemptNumber: row.reconciliationAttemptCount + 1,
        triggerType: trigger,
        actorId: actorId === 'SYSTEM' ? null : actorId,
        providerRequestReference: row.conversationId,
        oldStatus: row.status,
      },
    });
  }

  private async completeAttemptAndSchedule(
    attemptId: string,
    before: {
      id: string;
      tenantId: string;
      status: TransactionStatus;
      reconciliationAttemptCount: number;
      createdAt: Date;
    },
    outcome: {
      reasonCode: string;
      errorCategory?: string;
      providerResult?: Prisma.InputJsonObject;
      correlationResult?: Prisma.InputJsonObject;
      nextRetryAt?: Date | null;
      manualReviewRequired?: boolean;
      manualReviewReason?: string;
    },
  ) {
    const after = await this.prisma.mpesaTransaction.findUniqueOrThrow({
      where: { id: before.id },
    });
    const attemptCount = before.reconciliationAttemptCount + 1;
    const manualReviewRequired =
      outcome.manualReviewRequired ?? this.shouldManualReview(before, attemptCount);
    const nextRetryAt =
      after.status === TransactionStatus.PENDING || after.status === TransactionStatus.RECON_PENDING
        ? manualReviewRequired
          ? null
          : (outcome.nextRetryAt ?? this.nextRetry(attemptCount))
        : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.mpesaTransaction.update({
        where: { id: before.id },
        data: {
          reconciliationAttemptCount: attemptCount,
          reconciliationNextRetryAt: nextRetryAt,
          reconciliationLockedAt: null,
          reconciliationLockedBy: null,
          lastRecoveryAt: new Date(),
          manualReviewRequired,
          manualReviewReason: manualReviewRequired
            ? (outcome.manualReviewReason ?? outcome.reasonCode)
            : null,
          reconciliationLastReason: outcome.reasonCode,
        },
      });
      await tx.mpesaWithdrawalReconciliationAttempt.update({
        where: { id: attemptId },
        data: {
          completedAt: new Date(),
          providerResult: outcome.providerResult ?? {
            status: after.status,
            resultDesc: after.resultDesc,
          },
          correlationResult: outcome.correlationResult ?? { failureReason: after.failureReason },
          oldStatus: before.status,
          newStatus: after.status,
          reasonCode: outcome.reasonCode,
          errorCategory: outcome.errorCategory ?? null,
          nextRetryAt,
        },
      });
    });
  }

  private classifyOutcome(
    row: {
      status: TransactionStatus;
      failureReason: string | null;
      resultDesc: string | null;
      callbackPayload: Prisma.JsonValue | null;
      createdAt: Date;
      reconciliationAttemptCount: number;
    },
    providerStatus: { refreshed: boolean; terminal: boolean; status?: TransactionStatus },
    attemptCount: number,
  ) {
    if (row.status === TransactionStatus.COMPLETED) {
      return {
        reasonCode: 'PROVIDER_CONFIRMED_SUCCESS',
        providerResult: this.jsonOrFallback(row.callbackPayload),
        correlationResult: { terminal: true, status: row.status },
      };
    }
    if (row.status === TransactionStatus.FAILED) {
      return {
        reasonCode: 'PROVIDER_CONFIRMED_FAILURE_REVERSED',
        providerResult: this.jsonOrFallback(row.callbackPayload),
        correlationResult: { terminal: true, status: row.status },
      };
    }
    if (row.failureReason?.includes('MISMATCH')) {
      return {
        reasonCode: 'PROVIDER_RESPONSE_MISMATCH',
        errorCategory: 'CORRELATION_MISMATCH',
        providerResult: this.jsonOrFallback(row.callbackPayload),
        manualReviewRequired: true,
        manualReviewReason: row.failureReason,
      };
    }
    if (!providerStatus.refreshed) {
      return {
        reasonCode: 'PROVIDER_STATUS_NOT_REFRESHED',
        errorCategory: 'PROVIDER_UNAVAILABLE',
        nextRetryAt: this.nextRetry(attemptCount),
        manualReviewRequired: this.shouldManualReview(row, attemptCount),
      };
    }
    return {
      reasonCode:
        providerStatus.status === TransactionStatus.PENDING
          ? 'PROVIDER_STILL_PENDING'
          : 'PROVIDER_OUTCOME_UNKNOWN',
      providerResult: this.jsonOrFallback(row.callbackPayload),
      correlationResult: { terminal: false, status: providerStatus.status ?? row.status },
      nextRetryAt: this.nextRetry(attemptCount),
      manualReviewRequired: this.shouldManualReview(row, attemptCount),
      manualReviewReason: this.shouldManualReview(row, attemptCount)
        ? 'Automated reconciliation exhausted or exceeded manual review SLA'
        : undefined,
    };
  }

  private async requireWithdrawal(mpesaTransactionId: string, tenantId: string) {
    const row = await this.prisma.mpesaTransaction.findFirst({
      where: {
        id: mpesaTransactionId,
        tenantId,
        referenceType: 'FOSA_WITHDRAWAL',
        type: MpesaTxType.B2C,
      },
    });
    if (!row) throw new NotFoundException('M-Pesa FOSA withdrawal transaction not found');
    return row;
  }

  private wasProviderContacted(row: {
    providerSubmissionState: string | null;
    providerSendAttemptedAt: Date | null;
    conversationId: string | null;
  }) {
    return (
      !!row.providerSendAttemptedAt ||
      PROVIDER_CONTACT_STATES.includes(row.providerSubmissionState ?? '') ||
      !!row.conversationId
    );
  }

  private shouldManualReview(row: { createdAt: Date }, attemptCount: number): boolean {
    const ageMs = Date.now() - row.createdAt.getTime();
    return attemptCount >= this.maxAttempts() || ageMs >= this.manualReviewMs();
  }

  private nextRetry(attemptCount: number): Date {
    const baseMs = this.retryIntervalMs();
    const multiplier = Math.min(8, 2 ** Math.max(0, attemptCount - 1));
    return new Date(Date.now() + baseMs * multiplier);
  }

  private async raiseOperationalAlertOnce(params: {
    tenantId: string;
    entityType: string;
    entityId: string;
    action: string;
    severity: ComplianceAlertSeverity;
    message: string;
    details: Record<string, unknown>;
  }) {
    const requestId = `audit.${params.action}.${params.tenantId}.${params.entityId}`;
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.auditLog.findUnique({ where: { requestId } });
      if (existing) return;
      await this.audit.createAtomic(tx, {
        tenantId: params.tenantId,
        actorId: 'SYSTEM',
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        newValue: { alert: params.message, severity: params.severity },
        metadata: params.details,
        requestId,
      });
      await tx.complianceAlert.create({
        data: {
          tenantId: params.tenantId,
          policy: 'MPESA_WITHDRAWAL_RECONCILIATION',
          severity: params.severity,
          message: params.message,
          details: {
            entityType: params.entityType,
            entityId: params.entityId,
            action: params.action,
            ...params.details,
          } satisfies Prisma.InputJsonObject,
          remediation:
            'Review via admin M-Pesa reconciliation endpoints; never mutate Account.balance directly.',
        },
      });
    });
    if (params.action.includes('DLQ')) {
      this.metrics?.setB2cDeadLetterCount(params.tenantId, QUEUE_NAMES.MPESA_DISBURSEMENT_DLQ, 1);
    } else {
      this.metrics?.recordB2cReconciliationFailure(params.tenantId, params.action);
    }
  }

  private async refreshOperationalGauges(): Promise<void> {
    const rows = await this.prisma.mpesaTransaction.groupBy({
      by: ['tenantId', 'status'],
      where: {
        type: MpesaTxType.B2C,
        referenceType: 'FOSA_WITHDRAWAL',
        status: { in: [TransactionStatus.PENDING, TransactionStatus.RECON_PENDING] },
      },
      _count: { _all: true },
    });
    for (const row of rows) {
      this.metrics?.setB2cStaleWithdrawals(row.tenantId, row.status, row._count._all);
    }

    const oldest = await this.prisma.mpesaTransaction.groupBy({
      by: ['tenantId', 'status'],
      where: {
        type: MpesaTxType.B2C,
        referenceType: 'FOSA_WITHDRAWAL',
        status: { in: [TransactionStatus.PENDING, TransactionStatus.RECON_PENDING] },
      },
      _min: { createdAt: true },
    });
    for (const row of oldest) {
      const seconds = row._min.createdAt
        ? Math.floor((Date.now() - row._min.createdAt.getTime()) / 1000)
        : 0;
      if (row.status === TransactionStatus.PENDING) {
        this.metrics?.setB2cOldestPendingAgeSeconds(row.tenantId, seconds);
      } else {
        this.metrics?.setB2cReconOldestAgeSeconds(row.tenantId, seconds);
      }
    }
  }

  private auditActionForOutcome(reasonCode: string): string {
    switch (reasonCode) {
      case 'PROVIDER_CONFIRMED_SUCCESS':
        return 'MPESA.WITHDRAWAL.RECON_RESOLVED_SUCCESS';
      case 'PROVIDER_CONFIRMED_FAILURE_REVERSED':
        return 'MPESA.WITHDRAWAL.RECON_RESOLVED_FAILURE';
      case 'PROVIDER_STILL_PENDING':
        return 'MPESA.WITHDRAWAL.RECON_STILL_PENDING';
      case 'PROVIDER_RESPONSE_MISMATCH':
        return 'MPESA.WITHDRAWAL.RECON_MISMATCH';
      default:
        return 'MPESA.WITHDRAWAL.RECON_UNKNOWN';
    }
  }

  private async auditManualAction(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      actorId: string;
      action: string;
      entityId: string;
      oldStatus: TransactionStatus;
      newStatus: TransactionStatus;
      dto: ManualReconciliationEvidenceDto;
      ipAddress?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    await this.audit.createAtomic(tx, {
      tenantId: params.tenantId,
      actorId: params.actorId,
      action: params.action,
      entityType: 'MpesaTransaction',
      entityId: params.entityId,
      oldValue: { status: params.oldStatus },
      newValue: {
        status: params.newStatus,
        reason: params.dto.reason,
        evidenceReference: params.dto.evidenceReference,
      },
      metadata: {
        evidenceReference: params.dto.evidenceReference,
        evidenceNote: params.dto.evidenceNote ?? null,
        reason: params.dto.reason,
        ...params.metadata,
      },
      ipAddress: params.ipAddress,
    });
  }

  private requireEvidence(dto: ManualReconciliationEvidenceDto): void {
    if (!dto.reason?.trim() || !dto.evidenceReference?.trim()) {
      throw new BadRequestException('Manual reconciliation requires reason and evidenceReference');
    }
  }

  private evidenceJson(dto: ManualReconciliationEvidenceDto): Prisma.InputJsonObject {
    return {
      reason: dto.reason,
      evidenceReference: dto.evidenceReference,
      evidenceNote: dto.evidenceNote ?? null,
      evidenceCapturedAt: new Date().toISOString(),
    };
  }

  private jsonOrFallback(value: Prisma.JsonValue | null): Prisma.InputJsonObject {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Prisma.InputJsonObject;
    }
    return { providerResult: value ?? null };
  }

  private pendingThresholdMs(): number {
    return this.config.get<number>('app.mpesa.b2cPendingReconThresholdMinutes', 30) * 60_000;
  }

  private retryIntervalMs(): number {
    return this.config.get<number>('app.mpesa.b2cReconRetryIntervalMinutes', 15) * 60_000;
  }

  private staleOutboxMs(): number {
    return this.config.get<number>('app.mpesa.b2cStaleOutboxThresholdMinutes', 10) * 60_000;
  }

  private manualReviewMs(): number {
    return this.config.get<number>('app.mpesa.b2cManualReviewThresholdMinutes', 120) * 60_000;
  }

  private lockTtlMs(): number {
    return this.config.get<number>('app.mpesa.b2cReconLockTtlSeconds', 300) * 1000;
  }

  private maxAttempts(): number {
    return this.config.get<number>('app.mpesa.b2cMaxReconAttempts', 5);
  }
}
