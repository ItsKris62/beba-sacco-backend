import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Decimal } from 'decimal.js';
import {
  Prisma,
  OutboxStatus,
  TransactionStatus,
  JournalEntryType,
  MpesaTxType,
  MpesaTriggerSource,
  LoanStatus,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService, CreateAuditLogDto } from '../../audit/audit.service';
import { CacheService } from '../../../common/services/cache.service';
import { DOMAIN_EVENTS, DomainEventName } from '../../../common/constants/events';
import { LoanRepaymentService } from '../../loans/loan-repayment.service';
import { LedgerService } from '../../accounting/ledger.service';
import { MetricsService } from '../../metrics/metrics.service';
import { QUEUE_NAMES, MpesaCallbackJobPayload } from '../queue.constants';
import {
  isStkCallback,
  isC2bCallback,
  isB2cCallback,
  parseStkMeta,
  parseB2cResultMeta,
  StkCallbackPayload,
  C2bCallbackPayload,
  B2cCallbackPayload,
} from '../../mpesa/dto/mpesa-callback.dto';
import {
  maskPhone,
  parseReference,
  buildMpesaRef,
  parseDarajaTimestamp,
  isTimestampSkewed,
} from '../../mpesa/utils/mpesa.utils';
import { normalizePhone } from '../../data-import/utils/phone-normalizer';

/**
 * Processes all Daraja callback payloads (STK Push, C2B, B2C results).
 *
 * Three-layer idempotency:
 *  Layer 1 – BullMQ jobId derived from Daraja unique ID (queue-level dedup).
 *  Layer 2 – MpesaTransaction.status !== PENDING guard (in-process dedup).
 *  Layer 3 – MpesaTransaction.reference @unique constraint (DB-level safety net).
 *
 * DLQ strategy:
 *  BullMQ retries 3× (3s, 6s, 12s). After exhaustion @OnWorkerEvent('failed')
 *  moves the job to MPESA_CALLBACK_DLQ. No auto-replay.
 *
 * SASRA compliance:
 *  Raw callbackPayload persisted on every MpesaTransaction regardless of outcome.
 */
@Processor(QUEUE_NAMES.MPESA_CALLBACK, { concurrency: 5 })
export class MpesaCallbackProcessor extends WorkerHost {
  private readonly logger = new Logger(MpesaCallbackProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly loanRepayment: LoanRepaymentService,
    private readonly cache: CacheService,
    private readonly ledger: LedgerService,
    @InjectQueue(QUEUE_NAMES.MPESA_CALLBACK_DLQ)
    private readonly dlq: Queue,
    private readonly eventEmitter: EventEmitter2,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    super();
  }

  private emitDomainEvent(eventName: DomainEventName, payload: Record<string, unknown>): void {
    try {
      this.eventEmitter.emit(eventName, payload);
    } catch (error: unknown) {
      this.logger.error(
        `Domain event emit failed (${eventName}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async createAuditOnce(dto: CreateAuditLogDto): Promise<void> {
    try {
      await this.audit.create(dto);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return;
      }
      throw error;
    }
  }

  // ─── Main dispatcher ──────────────────────────────────────────────────────

  async process(job: Job<MpesaCallbackJobPayload>): Promise<void> {
    const { mpesaTransactionId, callbackType, tenantId, correlationId, callbackInboxId } = job.data;
    let callbackPayload = job.data.callbackPayload;
    let resolvedTenantId = tenantId;
    let resolvedMpesaTransactionId = mpesaTransactionId;

    if (callbackInboxId) {
      const inbox = await this.prisma.mpesaCallbackInbox.findUnique({
        where: { id: callbackInboxId },
        select: {
          id: true,
          tenantId: true,
          payload: true,
          status: true,
          mpesaTransactionId: true,
        },
      });
      if (!inbox) {
        throw new Error(`M-Pesa callback inbox row not found for ${callbackInboxId}`);
      }
      if (inbox.status === OutboxStatus.DELIVERED) {
        this.logger.log(`M-Pesa callback inbox duplicate skipped: ${callbackInboxId}`);
        return;
      }
      callbackPayload = inbox.payload as unknown as Record<string, unknown>;
      resolvedTenantId = inbox.tenantId;
      resolvedMpesaTransactionId = inbox.mpesaTransactionId ?? resolvedMpesaTransactionId;
    }

    if (resolvedMpesaTransactionId && !callbackPayload) {
      const transaction = await this.prisma.mpesaTransaction.findUnique({
        where: { id: resolvedMpesaTransactionId },
        select: { id: true, tenantId: true, callbackPayload: true },
      });

      if (!transaction?.callbackPayload) {
        throw new Error(
          `M-Pesa callback payload not found for transaction ${resolvedMpesaTransactionId}`,
        );
      }

      callbackPayload = transaction.callbackPayload as unknown as Record<string, unknown>;
      resolvedTenantId = transaction.tenantId;
    }

    if (!callbackPayload) {
      throw new Error(`M-Pesa callback job ${job.id} has no payload reference or legacy payload`);
    }

    this.logger.log(
      `Processing mpesa callback | job=${job.id} type=${callbackType} tenant=${resolvedTenantId} mpesaTransactionId=${resolvedMpesaTransactionId ?? ''} correlation=${correlationId ?? ''}`,
    );

    try {
      if (isStkCallback(callbackPayload)) {
        await this.handleStkCallback(
          callbackPayload as unknown as StkCallbackPayload,
          job.id ?? '',
        );
      } else if (isC2bCallback(callbackPayload)) {
        await this.handleC2bCallback(
          callbackPayload as unknown as C2bCallbackPayload,
          job.id ?? '',
          resolvedTenantId,
          resolvedMpesaTransactionId,
        );
      } else if (isB2cCallback(callbackPayload)) {
        await this.handleB2cCallback(
          callbackPayload as unknown as B2cCallbackPayload,
          job.id ?? '',
        );
      } else {
        this.logger.warn(`Unknown callback structure for job ${job.id} - logging and discarding`);
      }

      if (callbackInboxId) {
        await this.prisma.mpesaCallbackInbox.update({
          where: { id: callbackInboxId },
          data: {
            status: OutboxStatus.DELIVERED,
            processedAt: new Date(),
            lastError: null,
            nextRetryAt: null,
          },
        });
      }
    } catch (error) {
      if (callbackInboxId) {
        await this.prisma.mpesaCallbackInbox.update({
          where: { id: callbackInboxId },
          data: {
            status: OutboxStatus.FAILED,
            attempts: { increment: 1 },
            lastError: error instanceof Error ? error.message : String(error),
            nextRetryAt: new Date(Date.now() + 60_000),
          },
        });
      }
      throw error;
    }
  }
  // ─── STK Push result ──────────────────────────────────────────────────────

  private async handleStkCallback(body: StkCallbackPayload, _jobId: string): Promise<void> {
    const cb = body.Body.stkCallback;
    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = cb;

    const mpesaTx = await this.prisma.mpesaTransaction.findUnique({
      where: { checkoutRequestId: CheckoutRequestID },
    });

    if (!mpesaTx) {
      this.logger.warn(
        `STK callback: no MpesaTransaction for CheckoutRequestID=${CheckoutRequestID}`,
      );
      return;
    }

    // Layer 2 idempotency: already processed (e.g. Safaricom retry after timeout)
    if (mpesaTx.status !== TransactionStatus.PENDING) {
      this.logger.log(`STK callback duplicate skipped: ${CheckoutRequestID} → ${mpesaTx.status}`);
      return;
    }

    const rawPayload = body as unknown as Prisma.InputJsonValue;

    if (ResultCode !== 0) {
      await this.prisma.$transaction(async (tx) => {
        const claim = await tx.mpesaTransaction.updateMany({
          where: { id: mpesaTx.id, status: TransactionStatus.PENDING },
          data: {
            status: TransactionStatus.FAILED,
            resultCode: ResultCode,
            resultDesc: ResultDesc,
            callbackPayload: rawPayload,
          },
        });
        if (claim.count === 0) return;

        await this.audit.createAtomic(tx, {
          tenantId: mpesaTx.tenantId,
          actorId: 'SYSTEM',
          action: 'MPESA.DEPOSIT.FAILED',
          entityType: 'MpesaTransaction',
          entityId: mpesaTx.id,
          newValue: { status: 'FAILED', resultCode: ResultCode, resultDesc: ResultDesc },
          metadata: {
            checkoutRequestId: CheckoutRequestID,
            amount: mpesaTx.amount.toString(),
            phone: maskPhone(mpesaTx.phoneNumber),
            accountReference: mpesaTx.accountReference,
          },
          requestId: `audit.MPESA.DEPOSIT.FAILED.${mpesaTx.tenantId}.${mpesaTx.id}`,
        });
      });
      this.logger.log(
        `STK Push failed | checkout=${CheckoutRequestID} code=${ResultCode} desc=${ResultDesc}`,
      );
      this.emitDomainEvent(DOMAIN_EVENTS.MPESA.DEPOSIT_FAILED, {
        tenantId: mpesaTx.tenantId,
        memberId: mpesaTx.memberId ?? 'UNKNOWN',
        mpesaTransactionId: mpesaTx.id,
        transactionRef: CheckoutRequestID,
        amount: new Decimal(mpesaTx.amount.toString()).toNumber(),
        reason: ResultDesc,
        resultCode: ResultCode,
      });
      return;
    }

    const meta = parseStkMeta(CallbackMetadata?.Item);
    const receipt = meta.MpesaReceiptNumber ?? uuidv4();
    const amount = new Decimal(mpesaTx.amount.toString());

    if (meta.TransactionDate) {
      const { skewed, skewSeconds } = isTimestampSkewed(meta.TransactionDate);
      if (skewed) {
        this.logger.warn(
          `Timestamp skew ${skewSeconds}s for STK ${CheckoutRequestID} – proceeding (SASRA: log, not block)`,
        );
      }
    }

    await this.postLedgerEntry({
      tenantId: mpesaTx.tenantId,
      memberId: mpesaTx.memberId ?? undefined,
      loanId: mpesaTx.loanId ?? undefined,
      accountReference: mpesaTx.accountReference ?? '',
      amount,
      receipt,
      mpesaTxId: mpesaTx.id,
      rawPayload,
      resultCode: ResultCode,
      resultDesc: ResultDesc,
      transactionDate: meta.TransactionDate
        ? parseDarajaTimestamp(meta.TransactionDate)
        : new Date(),
    });

    this.metrics?.recordMpesaStkPushSuccess(mpesaTx.tenantId);

    this.logger.log(
      `STK Push processed | receipt=${receipt} amount=${amount.toFixed(2)} ` +
        `checkout=${CheckoutRequestID} phone=${maskPhone(mpesaTx.phoneNumber)}`,
    );
  }

  // ─── C2B result (direct paybill payment) ─────────────────────────────────

  private async handleC2bCallback(
    body: C2bCallbackPayload,
    _jobId: string,
    resolvedTenantId?: string,
    persistedTxId?: string,
  ): Promise<void> {
    const { TransID, TransAmount, BillRefNumber, MSISDN, TransTime } = body;

    try {
      const existing = await this.prisma.mpesaTransaction.findFirst({
        where: { mpesaReceiptNumber: TransID },
      });
      if (existing && existing.id !== persistedTxId) {
        this.logger.log(`C2B duplicate skipped: TransID=${TransID}`);
        return;
      }
      if (
        existing &&
        existing.id === persistedTxId &&
        existing.status !== TransactionStatus.PENDING
      ) {
        this.logger.log(`C2B duplicate skipped: TransID=${TransID} -> ${existing.status}`);
        return;
      }

      const amount = new Decimal(TransAmount);
      const rawPayload = body as unknown as Prisma.InputJsonValue;
      const reference = buildMpesaRef.c2b(TransID);
      const fallbackTenantId =
        resolvedTenantId && resolvedTenantId !== 'resolve-in-processor'
          ? resolvedTenantId
          : 'UNRESOLVED';

      const accounts = await this.prisma.account.findMany({
        where: {
          accountNumber: BillRefNumber,
          ...(resolvedTenantId && resolvedTenantId !== 'resolve-in-processor'
            ? { tenantId: resolvedTenantId }
            : {}),
        },
        select: { id: true, balance: true, memberId: true, tenantId: true },
      });

      if (accounts.length === 0) {
        this.logger.warn(
          `C2B: account not found for BillRefNumber=${BillRefNumber} TransID=${TransID}`,
        );
        await this.prisma.$transaction(async (tx) => {
          const rejected = persistedTxId
            ? await tx.mpesaTransaction.update({
                where: { id: persistedTxId },
                data: {
                  tenantId: fallbackTenantId,
                  status: TransactionStatus.FAILED,
                  resultCode: 9999,
                  resultDesc: 'Account not found - requires manual reconciliation',
                  callbackPayload: rawPayload,
                  transactionDate: parseDarajaTimestamp(TransTime),
                },
              })
            : await tx.mpesaTransaction.create({
                data: {
                  tenantId: fallbackTenantId,
                  type: MpesaTxType.C2B,
                  triggerSource: MpesaTriggerSource.MEMBER,
                  phoneNumber: MSISDN,
                  amount: amount.toDecimalPlaces(4).toString(),
                  accountReference: BillRefNumber,
                  mpesaReceiptNumber: TransID,
                  reference,
                  status: TransactionStatus.FAILED,
                  resultCode: 9999,
                  resultDesc: 'Account not found - requires manual reconciliation',
                  callbackPayload: rawPayload,
                  transactionDate: parseDarajaTimestamp(TransTime),
                },
              });

          await this.audit.createAtomic(tx, {
            tenantId: fallbackTenantId,
            actorId: 'SYSTEM',
            action: 'MPESA.C2B.REJECTED',
            entityType: 'MpesaTransaction',
            entityId: rejected.id,
            newValue: { status: 'FAILED', resultCode: 9999 },
            metadata: {
              transId: TransID,
              phoneNumber: maskPhone(MSISDN),
              accountReference: BillRefNumber,
              amount: amount.toFixed(4),
              rejection_reason: 'ACCOUNT_NOT_FOUND',
            },
            requestId: `audit.MPESA.C2B.REJECTED.${fallbackTenantId}.${TransID}`,
          });
        });
        return;
      }

      if (accounts.length > 1) {
        this.logger.error(
          `C2B TENANT COLLISION: BillRefNumber=${BillRefNumber} matches ${accounts.length} ` +
            `accounts across tenants [${accounts.map((a) => a.tenantId).join(', ')}] ` +
            `TransID=${TransID} - requires manual reconciliation`,
        );
        await this.prisma.$transaction(async (tx) => {
          const rejected = persistedTxId
            ? await tx.mpesaTransaction.update({
                where: { id: persistedTxId },
                data: {
                  tenantId: fallbackTenantId,
                  status: TransactionStatus.FAILED,
                  resultCode: 9998,
                  resultDesc: 'Cross-tenant account collision - requires manual reconciliation',
                  callbackPayload: rawPayload,
                  transactionDate: parseDarajaTimestamp(TransTime),
                },
              })
            : await tx.mpesaTransaction.create({
                data: {
                  tenantId: fallbackTenantId,
                  type: MpesaTxType.C2B,
                  triggerSource: MpesaTriggerSource.MEMBER,
                  phoneNumber: MSISDN,
                  amount: amount.toDecimalPlaces(4).toString(),
                  accountReference: BillRefNumber,
                  mpesaReceiptNumber: TransID,
                  reference,
                  status: TransactionStatus.FAILED,
                  resultCode: 9998,
                  resultDesc: 'Cross-tenant account collision - requires manual reconciliation',
                  callbackPayload: rawPayload,
                  transactionDate: parseDarajaTimestamp(TransTime),
                },
              });

          await this.audit.createAtomic(tx, {
            tenantId: fallbackTenantId,
            actorId: 'SYSTEM',
            action: 'MPESA.C2B.REJECTED',
            entityType: 'MpesaTransaction',
            entityId: rejected.id,
            newValue: { status: 'FAILED', resultCode: 9998 },
            metadata: {
              transId: TransID,
              phoneNumber: maskPhone(MSISDN),
              accountReference: BillRefNumber,
              amount: amount.toFixed(4),
              rejection_reason: 'CROSS_TENANT_COLLISION',
              collidingTenantIds: accounts.map((a) => a.tenantId),
            },
            requestId: `audit.MPESA.C2B.REJECTED.${fallbackTenantId}.${TransID}`,
          });
        });
        return;
      }

      const account = accounts[0];
      const mpesaTx = persistedTxId
        ? await this.prisma.mpesaTransaction.update({
            where: { id: persistedTxId },
            data: {
              tenantId: account.tenantId,
              memberId: account.memberId,
              type: MpesaTxType.C2B,
              triggerSource: MpesaTriggerSource.MEMBER,
              phoneNumber: MSISDN,
              amount: amount.toDecimalPlaces(4).toString(),
              accountReference: BillRefNumber,
              mpesaReceiptNumber: TransID,
              reference,
              status: TransactionStatus.PENDING,
              callbackPayload: rawPayload,
              transactionDate: parseDarajaTimestamp(TransTime),
            },
          })
        : await this.prisma.mpesaTransaction.create({
            data: {
              tenantId: account.tenantId,
              memberId: account.memberId,
              type: MpesaTxType.C2B,
              triggerSource: MpesaTriggerSource.MEMBER,
              phoneNumber: MSISDN,
              amount: amount.toDecimalPlaces(4).toString(),
              accountReference: BillRefNumber,
              mpesaReceiptNumber: TransID,
              reference,
              status: TransactionStatus.PENDING,
              callbackPayload: rawPayload,
              transactionDate: parseDarajaTimestamp(TransTime),
            },
          });

      await this.postLedgerEntry({
        tenantId: account.tenantId,
        memberId: account.memberId,
        accountReference: BillRefNumber,
        amount,
        receipt: TransID,
        mpesaTxId: mpesaTx.id,
        rawPayload,
        resultCode: 0,
        resultDesc: 'Success',
        transactionDate: parseDarajaTimestamp(TransTime),
      });

      this.logger.log(
        `C2B processed | TransID=${TransID} amount=${amount.toFixed(2)} ` +
          `account=${BillRefNumber} phone=${maskPhone(MSISDN)}`,
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.logger.log(`C2B duplicate skipped by unique constraint: TransID=${TransID}`);
        return;
      }
      throw error;
    }
  }
  // ─── B2C result ───────────────────────────────────────────────────────────

  private async handleB2cCallback(body: B2cCallbackPayload, _jobId: string): Promise<void> {
    const { ConversationID, ResultCode, ResultDesc, TransactionID, ResultParameters } = body.Result;

    const mpesaTx = await this.prisma.mpesaTransaction.findFirst({
      where: { conversationId: ConversationID },
    });

    if (!mpesaTx) {
      this.logger.warn(`B2C callback: no MpesaTransaction for ConversationID=${ConversationID}`);
      return;
    }

    // Layer 2 idempotency. RECON_PENDING is included alongside PENDING because
    // MpesaB2cTimeoutProcessor marks stuck FOSA_WITHDRAWAL rows RECON_PENDING after
    // 30 minutes without a callback — if we treated that as terminal here, a genuinely
    // late Daraja callback (success or failure) would be silently dropped forever, and
    // WithdrawalReconciliationProcessor's later auto-refund of the same row would go
    // unreconciled against it. The claim-then-act guards below (updateMany with a
    // status precondition) ensure whichever of {this callback, the recon sweep} acts
    // second on a given row safely no-ops instead of double-processing it.
    if (
      mpesaTx.status !== TransactionStatus.PENDING &&
      mpesaTx.status !== TransactionStatus.RECON_PENDING
    ) {
      this.logger.log(`B2C callback duplicate skipped: ${ConversationID} → ${mpesaTx.status}`);
      return;
    }

    const rawPayload = body as unknown as Prisma.InputJsonValue;

    const callbackMeta = parseB2cResultMeta(ResultParameters);
    const callbackMismatches = this.findB2cCallbackMismatches(mpesaTx, callbackMeta);
    if (callbackMismatches.length > 0) {
      await this.markB2cCallbackMismatch(mpesaTx, rawPayload, {
        conversationId: ConversationID,
        originatorConversationId: body.Result.OriginatorConversationID,
        providerTransactionId: TransactionID,
        resultCode: ResultCode,
        resultDesc: ResultDesc,
        mismatches: callbackMismatches,
      });
      return;
    }

    if (ResultCode !== 0) {
      if (mpesaTx.referenceType === 'FOSA_WITHDRAWAL' && mpesaTx.transactionId) {
        // Reverse the original ledger debit through LedgerService.reverseTransaction()
        // — keeps GL and Account.balance in lockstep. The old code credited the
        // balance back with a hand-written Transaction.create() + Account.update(),
        // bypassing the GL a second time (on top of the withdrawal debit itself,
        // which is now also routed through the ledger — see MemberPortalService.withdrawMpesa()).
        const txClient = this.prisma.direct ?? this.prisma;
        const claimed = await txClient.$transaction(
          async (tx) => {
            // Claim this row before touching the ledger — if WithdrawalReconciliationProcessor
            // already won the race and reversed it (row is no longer PENDING/RECON_PENDING),
            // count is 0 and we must not call reverseTransaction() a second time.
            const claim = await tx.mpesaTransaction.updateMany({
              where: {
                id: mpesaTx.id,
                status: { in: [TransactionStatus.PENDING, TransactionStatus.RECON_PENDING] },
              },
              data: {
                status: TransactionStatus.FAILED,
                resultCode: ResultCode,
                resultDesc: ResultDesc,
                callbackPayload: rawPayload,
              },
            });
            if (claim.count === 0) return false;

            await this.ledger.reverseTransaction({
              tenantId: mpesaTx.tenantId,
              originalTransactionId: mpesaTx.transactionId!,
              reason: `B2C withdrawal failed: ${ResultDesc} (code ${ResultCode})`,
              tx,
            });

            await this.audit.createAtomic(tx, {
              tenantId: mpesaTx.tenantId,
              actorId: 'SYSTEM',
              action: 'MPESA.DISBURSEMENT.FAILED_REFUNDED',
              entityType: 'MpesaTransaction',
              entityId: mpesaTx.id,
              newValue: {
                status: 'FAILED',
                resultCode: ResultCode,
                resultDesc: ResultDesc,
                refundedAmount: mpesaTx.amount.toString(),
              },
              metadata: {
                conversationId: ConversationID,
                referenceId: mpesaTx.referenceId,
                amount: mpesaTx.amount,
                phone: maskPhone(mpesaTx.phoneNumber),
              },
            });
            return true;
          },
          { isolationLevel: 'Serializable' },
        );
        if (!claimed) {
          this.logger.warn(
            `B2C failure callback arrived after the row was already reconciled — skipped | conversation=${ConversationID}`,
          );
        } else {
          this.logger.warn(
            `B2C failed and FOSA withdrawal reversed | conversation=${ConversationID} code=${ResultCode} desc=${ResultDesc}`,
          );
        }
      } else if (mpesaTx.referenceType === 'FOSA_WITHDRAWAL' && mpesaTx.referenceId) {
        // Legacy rows may not have the original ledger Transaction.id needed for
        // LedgerService.reverseTransaction(). Never guess by crediting Account.balance
        // directly; leave the row in reconciliation for an operator to resolve.
        const txClient = this.prisma.direct ?? this.prisma;
        const claimed = await txClient.$transaction(
          async (tx) => {
            const account = await tx.account.findUnique({
              where: { id: mpesaTx.referenceId! },
              select: { id: true, tenantId: true, memberId: true, accountNumber: true },
            });

            const claim = await tx.mpesaTransaction.updateMany({
              where: {
                id: mpesaTx.id,
                status: { in: [TransactionStatus.PENDING, TransactionStatus.RECON_PENDING] },
                OR: [
                  { failureReason: null },
                  { failureReason: { not: 'B2C_FAILURE_NO_LINKED_LEDGER_TRANSACTION' } },
                ],
              },
              data: {
                status: TransactionStatus.RECON_PENDING,
                resultCode: ResultCode,
                resultDesc: ResultDesc,
                failureReason: 'B2C_FAILURE_NO_LINKED_LEDGER_TRANSACTION',
                callbackPayload: rawPayload,
              },
            });
            if (claim.count === 0) return false;

            await this.audit.createAtomic(tx, {
              tenantId: mpesaTx.tenantId,
              actorId: 'SYSTEM',
              action: 'MPESA.DISBURSEMENT.FAILURE_MANUAL_REVIEW_REQUIRED',
              entityType: 'MpesaTransaction',
              entityId: mpesaTx.id,
              newValue: {
                status: TransactionStatus.RECON_PENDING,
                resultCode: ResultCode,
                resultDesc: ResultDesc,
                reason: 'NO_LINKED_LEDGER_TRANSACTION',
              },
              metadata: {
                conversationId: ConversationID,
                originatorConversationId: body.Result.OriginatorConversationID,
                providerTransactionId: TransactionID,
                referenceId: mpesaTx.referenceId,
                originalReference: mpesaTx.reference,
                accountId: account?.id ?? mpesaTx.referenceId,
                accountNumber: account?.accountNumber ?? null,
                memberId: account?.memberId ?? mpesaTx.memberId,
                amount: mpesaTx.amount.toString(),
                phone: maskPhone(mpesaTx.phoneNumber),
                automaticReversalUnsafe: true,
              },
              requestId: `audit.MPESA.DISBURSEMENT.FAILURE_MANUAL_REVIEW_REQUIRED.${mpesaTx.tenantId}.${mpesaTx.id}`,
            });
            return true;
          },
          { isolationLevel: 'Serializable' },
        );
        if (claimed) {
          this.logger.error(
            `B2C failed but no linked ledger transaction exists; manual reconciliation required | ` +
              `conversation=${ConversationID} mpesaTransactionId=${mpesaTx.id} code=${ResultCode}`,
          );
        }
      } else {
        await this.prisma.$transaction(async (tx) => {
          const claim = await tx.mpesaTransaction.updateMany({
            where: {
              id: mpesaTx.id,
              status: { in: [TransactionStatus.PENDING, TransactionStatus.RECON_PENDING] },
            },
            data: {
              status: TransactionStatus.FAILED,
              resultCode: ResultCode,
              resultDesc: ResultDesc,
              callbackPayload: rawPayload,
            },
          });
          if (claim.count === 0) return;

          await this.audit.createAtomic(tx, {
            tenantId: mpesaTx.tenantId,
            actorId: 'SYSTEM',
            action: 'MPESA.DISBURSEMENT.FAILED',
            entityType: 'MpesaTransaction',
            entityId: mpesaTx.id,
            newValue: { status: 'FAILED', resultCode: ResultCode, resultDesc: ResultDesc },
            metadata: {
              conversationId: ConversationID,
              referenceId: mpesaTx.referenceId,
              amount: mpesaTx.amount.toString(),
              phone: maskPhone(mpesaTx.phoneNumber),
            },
            requestId: `audit.MPESA.DISBURSEMENT.FAILED.${mpesaTx.tenantId}.${mpesaTx.id}`,
          });
        });
        this.logger.warn(
          `B2C failed | conversation=${ConversationID} code=${ResultCode} desc=${ResultDesc}`,
        );
      }
      return;
    }

    const meta = callbackMeta;
    const amount = new Decimal(mpesaTx.amount.toString());
    const receipt = meta.TransactionReceipt ?? TransactionID ?? uuidv4();

    if (mpesaTx.referenceType === 'FOSA_WITHDRAWAL') {
      const txClient = this.prisma.direct ?? this.prisma;
      const claimed = await txClient.$transaction(async (tx) => {
        const claim = await tx.mpesaTransaction.updateMany({
          where: {
            id: mpesaTx.id,
            status: { in: [TransactionStatus.PENDING, TransactionStatus.RECON_PENDING] },
          },
          data: {
            status: TransactionStatus.COMPLETED,
            resultCode: ResultCode,
            resultDesc: ResultDesc,
            mpesaReceiptNumber: receipt,
            transactionDate: meta.TransactionCompletedDateTime
              ? new Date(meta.TransactionCompletedDateTime)
              : new Date(),
            callbackPayload: rawPayload,
          },
        });
        if (claim.count === 0) return false;

        await this.audit.createAtomic(tx, {
          tenantId: mpesaTx.tenantId,
          actorId: 'SYSTEM',
          action: 'MPESA.DISBURSEMENT.COMPLETED',
          entityType: 'MpesaTransaction',
          entityId: mpesaTx.id,
          newValue: { status: 'COMPLETED', receipt, amount: amount.toFixed(4) },
          metadata: { referenceId: mpesaTx.referenceId, phone: maskPhone(mpesaTx.phoneNumber) },
        });
        return true;
      });

      if (!claimed) {
        // The row was already reversed by WithdrawalReconciliationProcessor's auto-refund
        // before this genuinely-late SUCCESS callback arrived — the member has now been
        // paid out by Safaricom AND had their FOSA balance refunded. This is a real
        // double-credit that the claim-guard cannot retroactively prevent (it only stops
        // the two writers racing concurrently, not a callback arriving after the grace
        // window has already elapsed and been acted on). Surface loudly for manual recovery.
        this.logger.error(
          `CRITICAL: B2C withdrawal succeeded AFTER auto-refund reconciliation — member may be ` +
            `double-credited | conversation=${ConversationID} mpesaTransactionId=${mpesaTx.id} ` +
            `amount=${amount.toFixed(2)} phone=${maskPhone(mpesaTx.phoneNumber)}`,
        );
        await this.createAuditOnce({
          tenantId: mpesaTx.tenantId,
          actorId: 'SYSTEM',
          action: 'MPESA.WITHDRAWAL.LATE_SUCCESS_AFTER_AUTO_REFUND',
          entityType: 'MpesaTransaction',
          entityId: mpesaTx.id,
          newValue: { receipt, amount: amount.toFixed(4) },
          metadata: {
            conversationId: ConversationID,
            phone: maskPhone(mpesaTx.phoneNumber),
            priorStatus: mpesaTx.status,
            priorFailureReason: mpesaTx.failureReason,
          },
          requestId: `audit.MPESA.WITHDRAWAL.LATE_SUCCESS_AFTER_AUTO_REFUND.${mpesaTx.tenantId}.${mpesaTx.id}.${receipt}`,
        });
      }
    } else if (mpesaTx.loanId) {
      await this.postDisbursementLedger({
        tenantId: mpesaTx.tenantId,
        loanId: mpesaTx.loanId,
        memberId: mpesaTx.memberId ?? undefined,
        amount,
        receipt,
        mpesaTxId: mpesaTx.id,
        rawPayload,
        resultCode: ResultCode,
        resultDesc: ResultDesc,
        transactionDate: meta.TransactionCompletedDateTime
          ? new Date(meta.TransactionCompletedDateTime)
          : new Date(),
      });
    } else {
      this.logger.error(
        `B2C ${ConversationID} has no loanId or referenceId – cannot process success`,
      );
      return;
    }

    this.logger.log(
      `B2C disbursement processed | receipt=${receipt} amount=${amount.toFixed(2)} ` +
        `loan=${mpesaTx.loanId} phone=${maskPhone(mpesaTx.phoneNumber)}`,
    );
  }

  private findB2cCallbackMismatches(
    mpesaTx: { amount: Decimal; phoneNumber: string },
    meta: ReturnType<typeof parseB2cResultMeta>,
  ): string[] {
    const mismatches: string[] = [];
    if (meta.TransactionAmount !== undefined) {
      const normalizedAmount = String(meta.TransactionAmount)
        .replace(/,/g, '')
        .replace(/[^\d.-]/g, '')
        .trim();
      if (!normalizedAmount) {
        mismatches.push('AMOUNT_MISMATCH');
      } else if (
        !new Decimal(normalizedAmount).toDecimalPlaces(4).equals(mpesaTx.amount.toDecimalPlaces(4))
      ) {
        mismatches.push('AMOUNT_MISMATCH');
      }
    }

    if (meta.ReceiverPartyPublicName) {
      const receiverPhone = this.extractPhoneFromProviderText(meta.ReceiverPartyPublicName);
      const expectedPhone = normalizePhone(mpesaTx.phoneNumber).normalized;
      if (receiverPhone && expectedPhone && receiverPhone !== expectedPhone) {
        mismatches.push('PHONE_MISMATCH');
      }
    }
    return mismatches;
  }

  private extractPhoneFromProviderText(value: string): string | null {
    const match = value.match(/(?:\+?254|0)?[17]\d{8}/);
    return match ? normalizePhone(match[0]).normalized : null;
  }

  private async markB2cCallbackMismatch(
    mpesaTx: {
      id: string;
      tenantId: string;
      memberId: string | null;
      referenceId: string | null;
      reference: string;
      transactionId: string | null;
      phoneNumber: string;
      amount: Decimal;
      status: TransactionStatus;
    },
    rawPayload: Prisma.InputJsonValue,
    details: {
      conversationId: string;
      originatorConversationId: string;
      providerTransactionId: string;
      resultCode: number;
      resultDesc: string;
      mismatches: string[];
    },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const claim = await tx.mpesaTransaction.updateMany({
        where: {
          id: mpesaTx.id,
          status: { in: [TransactionStatus.PENDING, TransactionStatus.RECON_PENDING] },
        },
        data: {
          status: TransactionStatus.RECON_PENDING,
          resultCode: details.resultCode,
          resultDesc: details.resultDesc,
          failureReason: 'B2C_CALLBACK_MISMATCH',
          callbackPayload: rawPayload,
        },
      });
      if (claim.count === 0) return;

      await this.audit.createAtomic(tx, {
        tenantId: mpesaTx.tenantId,
        actorId: 'SYSTEM',
        action: 'MPESA.DISBURSEMENT.CALLBACK_MISMATCH',
        entityType: 'MpesaTransaction',
        entityId: mpesaTx.id,
        oldValue: { status: mpesaTx.status },
        newValue: {
          status: TransactionStatus.RECON_PENDING,
          resultCode: details.resultCode,
          resultDesc: details.resultDesc,
          failureReason: 'B2C_CALLBACK_MISMATCH',
          mismatches: details.mismatches,
        },
        metadata: {
          conversationId: details.conversationId,
          originatorConversationId: details.originatorConversationId,
          providerTransactionId: details.providerTransactionId,
          referenceId: mpesaTx.referenceId,
          transactionId: mpesaTx.transactionId,
          originalReference: mpesaTx.reference,
          memberId: mpesaTx.memberId,
          expectedAmount: mpesaTx.amount.toString(),
          expectedPhone: maskPhone(mpesaTx.phoneNumber),
          automaticCompletionUnsafe: true,
        },
        requestId: `audit.MPESA.DISBURSEMENT.CALLBACK_MISMATCH.${mpesaTx.tenantId}.${mpesaTx.id}.${details.providerTransactionId}`,
      });
      for (const mismatch of details.mismatches) {
        this.metrics?.recordB2cCallbackMismatch(mpesaTx.tenantId, mismatch);
      }
    });
  }

  // ─── Ledger helpers ───────────────────────────────────────────────────────

  /**
   * Posts a credit (deposit or repayment) to the ledger inside a single
   * Prisma interactive transaction.
   *
   * ACID guarantees:
   *  1. Transaction.reference @unique prevents double-posting (Layer 3).
   *  2. Account.balance updated atomically with the Transaction record.
   *  3. Loan totals updated if this is a repayment.
   *  4. MpesaTransaction.status updated last (acts as commit flag).
   */
  private async postLedgerEntry(params: {
    tenantId: string;
    memberId?: string | null;
    loanId?: string | null;
    accountReference: string;
    amount: Decimal;
    receipt: string;
    mpesaTxId?: string;
    rawPayload: Prisma.InputJsonValue;
    resultCode: number;
    resultDesc: string;
    transactionDate: Date;
  }): Promise<void> {
    const parsed = parseReference(params.accountReference);
    const isLoanRepayment = parsed.type === 'LOAN_REPAYMENT';
    const reference = `MPESA-${params.receipt}`;

    // Populated inside the transaction; read after commit to emit audit log.
    let auditData: {
      action: string;
      entityId: string;
      balanceBefore: string;
      balanceAfter: string;
      loanId?: string;
      loanNumber?: string;
      isFullyPaid?: boolean;
    } | null = null;

    if (isLoanRepayment) {
      const result = await this.loanRepayment.processRepayment({
        tenantId: params.tenantId,
        memberId: params.memberId,
        loanNumber: parsed.target,
        accountReference: params.accountReference,
        amount: params.amount,
        reference,
        processedBy: 'MPESA_SYSTEM',
        mpesaTxId: params.mpesaTxId,
        receipt: params.receipt,
        resultCode: params.resultCode,
        resultDesc: params.resultDesc,
        callbackPayload: params.rawPayload,
        transactionDate: params.transactionDate,
      });
      await this.cache.invalidateTenantDashboard(params.tenantId);
      await this.createAuditOnce({
        tenantId: params.tenantId,
        actorId: 'SYSTEM',
        action: 'MPESA.LOAN_REPAYMENT.COMPLETED',
        entityType: 'MpesaTransaction',
        entityId: params.mpesaTxId ?? result.loanId,
        newValue: {
          status: 'COMPLETED',
          receipt: params.receipt,
          amount: params.amount.toFixed(4),
          loanId: result.loanId,
          loanNumber: result.loanNumber,
          isFullyPaid: result.status === LoanStatus.FULLY_PAID,
        },
        metadata: {
          reference,
          accountReference: params.accountReference,
          memberId: params.memberId,
          transactionDate: params.transactionDate.toISOString(),
        },
        requestId: `audit.MPESA.LOAN_REPAYMENT.COMPLETED.${params.tenantId}.${params.receipt}`,
      });
      this.emitDomainEvent(DOMAIN_EVENTS.MPESA.REPAYMENT_SUCCESS, {
        tenantId: params.tenantId,
        memberId: params.memberId ?? 'UNKNOWN',
        loanId: result.loanId,
        mpesaTransactionId: params.mpesaTxId,
        transactionRef: reference,
        amount: params.amount.toNumber(),
        receipt: params.receipt,
      });
      if (result.status === LoanStatus.FULLY_PAID) {
        this.emitDomainEvent(DOMAIN_EVENTS.LOAN.REPAID, {
          tenantId: params.tenantId,
          loanId: result.loanId,
          memberId: params.memberId ?? 'UNKNOWN',
          amountPaid: params.amount.toNumber(),
          transactionRef: reference,
        });
      }
      return;
    }

    // ── Savings deposit path ────────────────────────────────────────────────────
    // Routed through LedgerService.postEntry() (not a manual Transaction.create() +
    // Account.update()) so the GL (JournalEntry/GLPosting) can never drift from the
    // live Account.balance — see Phase 1 audit: this used to write both tables by
    // hand here, bypassing the GL entirely. The reference is the M-Pesa receipt
    // number: Safaricom retries the same callback on transient failures, and
    // postEntry()'s (tenantId, reference) replay check is what turns a retry into a
    // no-op instead of a double credit.
    const accountNumber = parsed.isMemberIdDeposit
      ? await this.resolveDefaultFosaByMember(parsed.target, params.tenantId)
      : parsed.target;

    const depositReference = `MPESA_DEP-${params.receipt}-${params.tenantId}`;

    // Use SERIALIZABLE isolation to prevent lost updates on concurrent deposits
    // to the same account. Falls back to pooler client if direct URL is unavailable.
    const txClient = this.prisma.direct ?? this.prisma;
    const result = await txClient.$transaction(
      async (tx) => {
        const account = await tx.account.findFirst({
          where: { accountNumber, tenantId: params.tenantId, isActive: true },
          select: { id: true },
        });
        if (!account) {
          this.logger.warn(`Ledger: account "${accountNumber}" not found – manual recon needed`);
          return null;
        }

        const { transaction: ledgerTx, journalEntry } = await this.ledger.postEntry({
          tenantId: params.tenantId,
          reference: depositReference,
          journalType: JournalEntryType.MPESA_DEPOSIT,
          accountId: account.id,
          amount: params.amount,
          direction: 'CREDIT',
          description: `M-Pesa deposit – ${params.receipt}`,
          tx,
        });

        if (params.mpesaTxId) {
          await tx.mpesaTransaction.update({
            where: { id: params.mpesaTxId },
            data: {
              transactionId: ledgerTx.id,
              status: TransactionStatus.COMPLETED,
              resultCode: params.resultCode,
              resultDesc: params.resultDesc,
              mpesaReceiptNumber: params.receipt,
              transactionDate: params.transactionDate,
              callbackPayload: params.rawPayload,
            },
          });
        }

        await this.audit.createAtomic(tx, {
          tenantId: params.tenantId,
          actorId: 'SYSTEM',
          action: 'MPESA.DEPOSIT.COMPLETED',
          entityType: 'MpesaTransaction',
          entityId: params.mpesaTxId ?? ledgerTx.id,
          oldValue: { status: 'PENDING', balanceBefore: ledgerTx.balanceBefore.toString() },
          newValue: {
            status: 'COMPLETED',
            balanceAfter: ledgerTx.balanceAfter.toString(),
            receipt: params.receipt,
            amount: params.amount.toFixed(4),
          },
          metadata: {
            reference,
            accountReference: params.accountReference,
            memberId: params.memberId,
            transactionDate: params.transactionDate.toISOString(),
          },
        });

        return {
          journalEntryId: journalEntry.id,
          balanceBefore: ledgerTx.balanceBefore.toString(),
          balanceAfter: ledgerTx.balanceAfter.toString(),
        };
      },
      { isolationLevel: 'Serializable' as const },
    );

    if (result) {
      auditData = {
        action: 'MPESA.DEPOSIT.COMPLETED',
        entityId: params.mpesaTxId ?? result.journalEntryId,
        balanceBefore: result.balanceBefore,
        balanceAfter: result.balanceAfter,
      };
    }

    // Emit audit log after the transaction commits — fire-and-forget so a missed
    // audit event never rolls back the ledger entry.
    if (auditData) {
      await this.cache.invalidateTenantDashboard(params.tenantId);
      this.emitDomainEvent(DOMAIN_EVENTS.MPESA.DEPOSIT_SUCCESS, {
        tenantId: params.tenantId,
        memberId: params.memberId ?? 'UNKNOWN',
        mpesaTransactionId: params.mpesaTxId,
        transactionRef: reference,
        amount: params.amount.toNumber(),
        receipt: params.receipt,
      });
    }
  }

  private async postDisbursementLedger(params: {
    tenantId: string;
    loanId: string;
    memberId?: string;
    amount: Decimal;
    receipt: string;
    mpesaTxId: string;
    rawPayload: Prisma.InputJsonValue;
    resultCode: number;
    resultDesc: string;
    transactionDate: Date;
  }): Promise<void> {
    const reference = `MPESA-B2C-${params.receipt}`;

    // MpesaService.executeB2cDisbursement() currently rejects LOAN_DISBURSEMENT
    // requests before Daraja dispatch, so this B2C callback branch is dormant for
    // loan disbursements today. Keep it ledger-routed so lifting that feature gate
    // cannot reintroduce direct Account.balance writes.
    const txClient = this.prisma.direct ?? this.prisma;
    const auditData = await txClient.$transaction(
      async (
        tx,
      ): Promise<{
        balanceBefore: string;
        balanceAfter: string;
        loanStatusChanged: boolean;
      } | null> => {
        const loan = await tx.loan.findUnique({
          where: { id: params.loanId },
          select: { id: true, memberId: true, status: true },
        });
        if (!loan) return null;

        const fosa = await tx.account.findFirst({
          where: {
            memberId: loan.memberId,
            tenantId: params.tenantId,
            accountType: 'FOSA',
            isActive: true,
          },
          select: { id: true },
        });

        const fosaId =
          fosa?.id ?? (await this.getFosaAccountId(tx, loan.memberId, params.tenantId));

        const { transaction: ledgerTx } = await this.ledger.postEntry({
          tx,
          tenantId: params.tenantId,
          reference,
          journalType: JournalEntryType.LOAN_DISBURSEMENT,
          accountId: fosaId,
          amount: params.amount,
          direction: 'CREDIT',
          description: `M-Pesa B2C disbursement – ${params.receipt}`,
          loanId: params.loanId,
        });

        const loanStatusChanged = loan.status === LoanStatus.APPROVED;
        if (loanStatusChanged) {
          await tx.loan.update({
            where: { id: params.loanId },
            data: {
              status: LoanStatus.DISBURSED,
              disbursedAt: params.transactionDate,
              disbursedBy: 'MPESA_SYSTEM',
            },
          });
        }

        await tx.mpesaTransaction.update({
          where: { id: params.mpesaTxId },
          data: {
            transactionId: ledgerTx.id,
            status: TransactionStatus.COMPLETED,
            resultCode: params.resultCode,
            resultDesc: params.resultDesc,
            mpesaReceiptNumber: params.receipt,
            transactionDate: params.transactionDate,
            callbackPayload: params.rawPayload,
          },
        });

        return {
          balanceBefore: new Decimal(ledgerTx.balanceBefore.toString())
            .toDecimalPlaces(4)
            .toString(),
          balanceAfter: new Decimal(ledgerTx.balanceAfter.toString()).toDecimalPlaces(4).toString(),
          loanStatusChanged,
        };
      },
      { isolationLevel: 'Serializable' as const },
    );

    if (auditData) {
      await this.cache.invalidateTenantDashboard(params.tenantId);
      await this.createAuditOnce({
        tenantId: params.tenantId,
        actorId: 'SYSTEM',
        action: 'MPESA.DISBURSEMENT.COMPLETED',
        entityType: 'MpesaTransaction',
        entityId: params.mpesaTxId,
        oldValue: { status: 'PENDING', balanceBefore: auditData.balanceBefore },
        newValue: {
          status: 'COMPLETED',
          balanceAfter: auditData.balanceAfter,
          receipt: params.receipt,
          amount: params.amount.toFixed(4),
          loanMarkedDisbursed: auditData.loanStatusChanged,
        },
        metadata: {
          reference,
          loanId: params.loanId,
          memberId: params.memberId,
          transactionDate: params.transactionDate.toISOString(),
        },
        requestId: `audit.MPESA.DISBURSEMENT.COMPLETED.${params.tenantId}.${params.mpesaTxId}`,
      });
    }
  }

  // ─── DLQ handler ─────────────────────────────────────────────────────────

  @OnWorkerEvent('failed')
  async onFailed(job: Job<MpesaCallbackJobPayload>): Promise<void> {
    if ((job.attemptsMade ?? 0) < (job.opts?.attempts ?? 3)) return;

    this.metrics?.recordMpesaCallbackFailure(job.data.tenantId, job.data.callbackType);

    this.logger.error(
      `mpesa.callback job ${job.id} moved to DLQ after ${job.attemptsMade} attempts`,
      job.failedReason,
    );

    await this.dlq.add(
      'dead-letter',
      {
        originalJobId: job.id,
        ...job.data,
        failedReason: job.failedReason,
        failedAt: new Date().toISOString(),
      },
      { removeOnComplete: { age: 3600, count: 200 }, removeOnFail: { age: 604800, count: 100 } },
    );

    // Audit the DLQ transition — critical for manual reconciliation
    this.audit
      .create({
        tenantId: job.data.tenantId ?? 'UNRESOLVED',
        actorId: 'SYSTEM',
        action: 'MPESA.CALLBACK.DLQ',
        entityType: 'MpesaCallback',
        entityId: job.id ?? undefined,
        metadata: {
          callbackType: job.data.callbackType,
          attemptsMade: job.attemptsMade,
          failedReason: job.failedReason,
          failedAt: new Date().toISOString(),
        },
      })
      .catch((e: unknown) =>
        this.logger.warn(`Audit emit failed: ${e instanceof Error ? e.message : String(e)}`),
      );
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async resolveDefaultFosaByMember(memberId: string, tenantId: string): Promise<string> {
    const account = await this.prisma.account.findFirst({
      where: { memberId, tenantId, accountType: 'FOSA', isActive: true },
      select: { accountNumber: true },
    });
    if (!account) throw new Error(`No FOSA account for member ${memberId}`);
    return account.accountNumber;
  }

  private async getFosaAccountId(
    tx: Prisma.TransactionClient,
    memberId: string,
    tenantId: string,
  ): Promise<string> {
    const acc = await tx.account.findFirst({
      where: { memberId, tenantId, accountType: 'FOSA', isActive: true },
      select: { id: true },
    });
    if (acc) return acc.id;
    throw new Error(`No active FOSA account for member ${memberId} in tenant ${tenantId}`);
  }
}
