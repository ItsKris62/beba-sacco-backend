import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Decimal } from 'decimal.js';
import { Prisma, MpesaTxType, MpesaTriggerSource, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { DarajaClientService } from './daraja-client.service';
import { MpesaException, MpesaConfigException } from './exceptions/mpesa.exceptions';
import { MemberDepositDto, DepositPurpose } from './dto/deposit-request.dto';
import { isStkCallback, isC2bCallback, isB2cCallback } from './dto/mpesa-callback.dto';
import { maskPhone, buildMpesaRef, parseDarajaTimestamp } from './utils/mpesa.utils';
import { AuditService } from '../audit/audit.service';
import {
  MpesaCallbackJobPayload,
  MpesaB2cTimeoutJobPayload,
  MpesaDisbursementJobPayload,
  QUEUE_NAMES,
} from '../queue/queue.constants';
import { MpesaTransactionStatusDto } from './dto/mpesa-transaction-status.dto';
import { LoanRepaymentService } from '../loans/loan-repayment.service';
import { MetricsService } from '../metrics/metrics.service';

// ─── Redis key helpers ────────────────────────────────────────────────────────

const stkRateLimitKey = (tenantId: string, memberId: string) =>
  `mpesa:stk:rl:${tenantId}:${memberId}`;

function secondsUntilMidnightEAT(): number {
  const now = new Date();
  const eatOffset = 3 * 60 * 60 * 1000;
  const eat = new Date(now.getTime() + eatOffset);
  const midnightEatUtcMs =
    Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate() + 1) - eatOffset;
  return Math.ceil((midnightEatUtcMs - now.getTime()) / 1000);
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class MpesaService {
  private readonly logger = new Logger(MpesaService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly idempotency: IdempotencyService,
    private readonly daraja: DarajaClientService,
    private readonly audit: AuditService,
    private readonly loanRepaymentService: LoanRepaymentService,
    @InjectQueue(QUEUE_NAMES.MPESA_CALLBACK)
    private readonly callbackQueue: Queue<MpesaCallbackJobPayload>,
    @InjectQueue(QUEUE_NAMES.MPESA_DISBURSEMENT)
    private readonly disbursementQueue: Queue<MpesaDisbursementJobPayload>,
    @InjectQueue(QUEUE_NAMES.MPESA_B2C_TIMEOUT)
    private readonly b2cTimeoutQueue: Queue<MpesaB2cTimeoutJobPayload>,
    @InjectQueue(QUEUE_NAMES.MPESA_CALLBACK_DLQ)
    private readonly callbackDlqQueue: Queue,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  // ─── Member Deposit (STK Push) ──────────────────────────────────────────

  async initiateDeposit(
    dto: MemberDepositDto,
    tenantId: string,
    actorUserId: string,
    triggeredBy: string,
    triggerSource: MpesaTriggerSource = MpesaTriggerSource.MEMBER,
    idempotencyKey?: string,
  ): Promise<{
    checkoutRequestId: string;
    merchantRequestId: string;
    customerMessage: string;
    mpesaTxId: string;
  }> {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');
    }
    const member = await this.prisma.member.findFirst({
      where: { userId: actorUserId, tenantId },
      select: { id: true },
    });
    if (!member) {
      throw new BadRequestException('No member profile found for this user in the current tenant');
    }
    const memberId = member.id;
    const idemKey = `mpesa:stk:${tenantId}:${memberId}:${idempotencyKey.trim()}`;
    const idem = await this.idempotency.checkAndReserve(idemKey, tenantId, 24 * 60 * 60);
    if (idem.status === 'COMPLETED') {
      return idem.result as {
        checkoutRequestId: string;
        merchantRequestId: string;
        customerMessage: string;
        mpesaTxId: string;
      };
    }
    if (idem.status === 'PROCESSING') {
      throw new BadRequestException('STK push request is already processing');
    }

    // Hoisted so the catch block can reach these without re-computing.
    const rlKey = stkRateLimitKey(tenantId, memberId);
    // Set to true only after the daily limit guard passes. Ensures the catch
    // block does NOT attempt a decrement on the "limit already exceeded" throw,
    // where the INCR was a legitimate counter hit that must stay.
    let rateLimitSlotConsumed = false;

    try {
      const maxPerDay = this.config.get<number>('app.mpesa.stkRateLimitPerDay', 3);
      const midnightEatMs = Date.now() + secondsUntilMidnightEAT() * 1000;
      const currentCount = await this.redis.incrWithExpireAt(rlKey, midnightEatMs);
      if (currentCount > maxPerDay) {
        // The member genuinely hit their daily cap — do NOT decrement.
        throw new BadRequestException(
          `STK Push limit reached: ${maxPerDay} requests per day per member`,
        );
      }
      // The guard passed: slot tentatively consumed. Will be returned if Daraja
      // fails with a transient error (M-Pesa down, network blip).
      rateLimitSlotConsumed = true;

      const accountRef = this.buildAccountRef(dto);
      await this.verifyAccountRef(dto.purpose, accountRef, tenantId);

      const baseUrl = this.config.get<string>('app.mpesa.callbackUrl', '');
      const callbackUrl = `${baseUrl}/mpesa/callback`;

      const amount = Math.round(dto.amount);
      const transactionDesc =
        dto.note ?? (dto.purpose === DepositPurpose.LOAN_REPAYMENT ? 'Loan repay' : 'Deposit');

      const darajaResp = await this.daraja.initiateSTKPush({
        phoneNumber: dto.phoneNumber,
        amount,
        accountReference: accountRef,
        transactionDesc,
        callbackUrl,
      });

      const reference = buildMpesaRef.stk(darajaResp.CheckoutRequestID);

      const mpesaTx = await this.prisma.mpesaTransaction.create({
        data: {
          tenantId,
          memberId,
          type: MpesaTxType.STK_PUSH,
          triggerSource,
          checkoutRequestId: darajaResp.CheckoutRequestID,
          merchantRequestId: darajaResp.MerchantRequestID,
          phoneNumber: dto.phoneNumber,
          amount: new Decimal(dto.amount).toDecimalPlaces(4).toString(),
          accountReference: accountRef,
          description: transactionDesc,
          reference,
          status: TransactionStatus.PENDING,
        },
      });
      this.metrics?.recordMpesaStkPush(tenantId);

      this.logger.log(
        `STK Push initiated | tenant=${tenantId} member=${memberId} ` +
          `phone=${maskPhone(dto.phoneNumber)} amount=${amount} ` +
          `checkout=${darajaResp.CheckoutRequestID}`,
      );

      this.audit
        .create({
          tenantId,
          actorId: actorUserId,
          action: 'MPESA.DEPOSIT.INITIATED',
          entityType: 'MpesaTransaction',
          entityId: mpesaTx.id,
          newValue: {
            status: 'PENDING',
            checkoutRequestId: darajaResp.CheckoutRequestID,
            amount,
            accountReference: accountRef,
            triggerSource,
          },
          metadata: {
            phone: maskPhone(dto.phoneNumber),
            purpose: dto.purpose,
            memberId,
            idempotencyKey: idempotencyKey.trim(),
          },
        })
        .catch((e: unknown) =>
          this.logger.warn(`Audit emit failed: ${e instanceof Error ? e.message : String(e)}`),
        );

      const result = {
        checkoutRequestId: darajaResp.CheckoutRequestID,
        merchantRequestId: darajaResp.MerchantRequestID,
        customerMessage: darajaResp.CustomerMessage,
        mpesaTxId: mpesaTx.id,
      };
      await this.idempotency.complete(idemKey, tenantId, result, 24 * 60 * 60);
      return result;
    } catch (error) {
      // Return the rate-limit slot when M-Pesa itself was the problem.
      //
      // All three conditions must hold:
      //   1. rateLimitSlotConsumed — the INCR passed the limit guard, so we
      //      actually incremented against the member's allowance.
      //   2. error instanceof MpesaException — business/validation errors
      //      (wrong account number, unknown loan) intentionally consume a slot
      //      to deter enumeration; only Daraja transport/service errors are returned.
      //   3. error.retryable — permanent Daraja rejections (bad credentials,
      //      invalid shortcode) also consume a slot since resubmitting
      //      immediately would fail again with no operator action.
      if (rateLimitSlotConsumed && error instanceof MpesaException && error.retryable) {
        await this.safeReleaseRateLimitSlot(rlKey, tenantId, memberId);
      }
      // TODO(incident 2026-07-20): already releases unconditionally (good —
      // no leak here), but the release call itself isn't wrapped in its own
      // try/catch, so a Redis failure during cleanup would throw from here
      // and mask the original `error`. See loan-application.service.ts's
      // memberApply() catch block for the safe pattern.
      await this.idempotency.release(idemKey, tenantId);
      throw error;
    }
  }

  // ─── B2C Loan Disbursement (queue entry point) ──────────────────────────

  /**
   * Resolves loan phone + amount from the DB, then enqueues a B2C disbursement job.
   * Phone and amount are embedded in the job payload so the processor is a pure
   * executor with no DB lookups — avoids stale-data race conditions under retries.
   *
   * ARCHITECTURAL DECISION: Direct B2C M-Pesa disbursement is DISABLED.
   * Reasoning:
   * 1. Reconciliation Control: We must enforce disbursement to the member's internal FOSA wallet
   *    first to allow future offsets for BOSA contributions or outstanding fines.
   * 2. API Reliability: Safaricom B2C timeouts cause reconciliation nightmares. Internal DB
   *    transactions to the FOSA wallet are 100% reliable. The member must explicitly initiate a
   *    FOSA withdrawal to M-Pesa to pull the funds out. Do not attempt to "fix" this.
   */
  async queueLoanDisbursement(
    _loanId: string,
    _tenantId: string,
    _triggeredBy: string,
  ): Promise<{ jobId: string }> {
    throw new BadRequestException(
      'Direct M-Pesa loan disbursement is disabled. Disburse the loan to FOSA first, then initiate a FOSA withdrawal for M-Pesa payout.',
    );
  }

  async getTransactionStatus(
    checkoutRequestId: string,
    userId: string,
    tenantId: string,
  ): Promise<MpesaTransactionStatusDto> {
    const transaction = await this.prisma.mpesaTransaction.findFirst({
      where: {
        checkoutRequestId,
        tenantId,
        type: MpesaTxType.STK_PUSH,
        member: { userId },
      },
      select: {
        checkoutRequestId: true,
        status: true,
        amount: true,
        updatedAt: true,
        failureReason: true,
      },
    });

    if (!transaction?.checkoutRequestId) {
      throw new NotFoundException('M-Pesa transaction not found');
    }

    return {
      checkoutRequestId: transaction.checkoutRequestId,
      status: transaction.status,
      amount: transaction.amount.toString(),
      lastUpdated: transaction.updatedAt,
      failureReason: transaction.failureReason ?? undefined,
    };
  }

  // ─── Direct B2C (called by the disbursement processor) ─────────────────

  /**
   * Performs the actual Daraja B2C call using pre-resolved phone + amount.
   * Called only by MpesaDisbursementProcessor — never from HTTP handlers.
   */
  async executeB2cDisbursement(
    referenceId: string,
    referenceType: 'LOAN_DISBURSEMENT' | 'FOSA_WITHDRAWAL',
    tenantId: string,
    phone: string,
    amount: number,
    triggeredBy: string,
    sourceTransactionId?: string,
  ): Promise<{ conversationId: string; mpesaTxId: string }> {
    let memberId = '';
    let accountReference = referenceId;

    if (referenceType === 'LOAN_DISBURSEMENT') {
      throw new BadRequestException(
        'Direct M-Pesa loan disbursement execution is disabled. Use FOSA withdrawal payout after loan disbursement.',
      );
    } else if (referenceType === 'FOSA_WITHDRAWAL') {
      const account = await this.prisma.account.findUnique({
        where: { id: referenceId },
        select: { memberId: true, accountNumber: true },
      });
      if (!account) throw new NotFoundException('FOSA account not found for withdrawal');
      memberId = account.memberId;
      accountReference = account.accountNumber;
    }

    const b2cShortcode = this.config.get<string>('app.mpesa.b2cShortcode', '600000');
    const initiatorName = this.config.get<string>('app.mpesa.initiatorName', 'testapi');
    const securityCredential = this.config.get<string>('app.mpesa.securityCredential', '');
    const resultUrl = this.config.get<string>('app.mpesa.b2cResultUrl', '');
    const queueTimeoutUrl = this.config.get<string>('app.mpesa.b2cQueueTimeoutUrl', '');

    if (!securityCredential) {
      throw new MpesaConfigException('MPESA_SECURITY_CREDENTIAL');
    }

    const darajaResp = await this.daraja.initiateB2C({
      initiatorName,
      securityCredential,
      commandId: 'BusinessPayment',
      amount,
      partyA: b2cShortcode,
      partyB: phone,
      remarks:
        `${referenceType === 'FOSA_WITHDRAWAL' ? 'Withdrawal' : 'Disbursement'} ${accountReference}`.slice(
          0,
          100,
        ),
      occasionRef: accountReference,
      resultUrl,
      queueTimeoutUrl,
    });

    const reference = buildMpesaRef.b2c(darajaResp.ConversationID);

    const mpesaTx = await this.prisma.mpesaTransaction.create({
      data: {
        tenantId,
        memberId,
        referenceType,
        referenceId,
        // Links back to the ledger Transaction that already moved the money (e.g. a
        // FOSA withdrawal debit) so a failed/timed-out B2C call can be reversed via
        // LedgerService.reverseTransaction() — see MpesaCallbackProcessor.handleB2cCallback().
        ...(sourceTransactionId && { transactionId: sourceTransactionId }),
        type: MpesaTxType.B2C,
        triggerSource:
          triggeredBy === 'SYSTEM' ? MpesaTriggerSource.SYSTEM : MpesaTriggerSource.OFFICER,
        conversationId: darajaResp.ConversationID,
        originatorConversationId: darajaResp.OriginatorConversationID,
        phoneNumber: phone,
        amount: new Decimal(amount).toDecimalPlaces(4).toString(),
        accountReference,
        description: `${referenceType === 'FOSA_WITHDRAWAL' ? 'FOSA Withdrawal' : 'Loan disbursement'}`,
        reference,
        status: TransactionStatus.PENDING,
      },
    });

    this.logger.log(
      `B2C initiated | tenant=${tenantId} refType=${referenceType} refId=${referenceId} ` +
        `phone=${maskPhone(phone)} conversation=${darajaResp.ConversationID} amount=${amount}`,
    );

    await this.b2cTimeoutQueue.add(
      'b2c-timeout-check',
      { referenceId, referenceType, tenantId, conversationId: darajaResp.ConversationID },
      {
        delay: 30 * 60 * 1000,
        jobId: `b2c-timeout.${darajaResp.ConversationID}`,
        removeOnComplete: true,
        removeOnFail: { age: 86400, count: 50 },
      },
    );

    return {
      conversationId: darajaResp.ConversationID,
      mpesaTxId: mpesaTx.id,
    };
  }

  // ─── Callback enqueueing ────────────────────────────────────────────────

  async enqueueCallback(
    payload: Record<string, unknown>,
    callbackType: MpesaCallbackJobPayload['callbackType'],
    uniqueId: string,
    tenantId = 'resolve-in-processor',
    correlationId?: string,
  ): Promise<void> {
    const mpesaTransactionId = await this.persistCallbackPayload(payload, callbackType, tenantId);
    const jobId = `${callbackType.toLowerCase().replace('_', '-')}-${uniqueId}`;

    await this.callbackQueue.add(
      'process-callback',
      { tenantId, correlationId, mpesaTransactionId, callbackType },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: { age: 3600, count: 200 },
        removeOnFail: { age: 604800, count: 100 },
      },
    );
    this.logger.log(
      `JOB_ENQUEUED queue=${QUEUE_NAMES.MPESA_CALLBACK} type=${callbackType} jobId=${jobId} tenant=${tenantId} mpesaTransactionId=${mpesaTransactionId} correlation=${correlationId ?? ''}`,
    );
  }

  private async persistCallbackPayload(
    payload: Record<string, unknown>,
    callbackType: MpesaCallbackJobPayload['callbackType'],
    tenantId: string,
  ): Promise<string> {
    const rawPayload = payload as Prisma.InputJsonValue;

    if (isStkCallback(payload)) {
      const checkoutRequestId = payload.Body.stkCallback.CheckoutRequestID;
      const transaction = await this.prisma.mpesaTransaction.findUnique({
        where: { checkoutRequestId },
        select: { id: true },
      });

      if (!transaction) {
        throw new Error(
          `STK callback has no MpesaTransaction for CheckoutRequestID=${checkoutRequestId}`,
        );
      }

      await this.prisma.mpesaTransaction.update({
        where: { id: transaction.id },
        data: { callbackPayload: rawPayload },
      });
      return transaction.id;
    }

    if (isB2cCallback(payload)) {
      const { ConversationID, OriginatorConversationID } = payload.Result;
      const transaction = await this.prisma.mpesaTransaction.findFirst({
        where: {
          OR: [
            { conversationId: ConversationID },
            { originatorConversationId: OriginatorConversationID },
          ],
        },
        select: { id: true },
      });

      if (!transaction) {
        throw new Error(
          `B2C callback has no MpesaTransaction for ConversationID=${ConversationID}`,
        );
      }

      await this.prisma.mpesaTransaction.update({
        where: { id: transaction.id },
        data: { callbackPayload: rawPayload },
      });
      return transaction.id;
    }

    if (isC2bCallback(payload)) {
      const amount = new Decimal(payload.TransAmount);
      const reference = buildMpesaRef.c2b(payload.TransID);
      const transaction = await this.prisma.mpesaTransaction.upsert({
        where: { reference },
        create: {
          tenantId: tenantId && tenantId !== 'resolve-in-processor' ? tenantId : 'UNRESOLVED',
          type: MpesaTxType.C2B,
          triggerSource: MpesaTriggerSource.MEMBER,
          phoneNumber: payload.MSISDN,
          amount: amount.toDecimalPlaces(4).toString(),
          accountReference: payload.BillRefNumber,
          mpesaReceiptNumber: payload.TransID,
          reference,
          status: TransactionStatus.PENDING,
          callbackPayload: rawPayload,
          transactionDate: parseDarajaTimestamp(payload.TransTime),
        },
        update: {
          callbackPayload: rawPayload,
          transactionDate: parseDarajaTimestamp(payload.TransTime),
        },
        select: { id: true },
      });
      return transaction.id;
    }

    throw new Error(`Unsupported M-Pesa callback structure for type=${callbackType}`);
  }
  // ─── DLQ admin: requeue a failed callback job ───────────────────────────

  /**
   * Moves a job from MPESA_CALLBACK_DLQ back to MPESA_CALLBACK for replay.
   * Requires TENANT_ADMIN or MANAGER role (enforced at the controller layer).
   * Only use after manual investigation — DLQ jobs failed for a reason.
   */
  async requeueFromDlq(jobId: string): Promise<{ requeued: boolean; jobId: string }> {
    const job = await this.callbackDlqQueue.getJob(jobId);
    if (!job) {
      throw new NotFoundException(`DLQ job ${jobId} not found`);
    }

    const payload = job.data as MpesaCallbackJobPayload;
    const newJobId = `dlq-replay-${jobId}-${Date.now()}`;

    await this.callbackQueue.add('process-callback', payload, {
      jobId: newJobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: { age: 3600, count: 200 },
      removeOnFail: { age: 604800, count: 100 },
    });

    // Remove from DLQ after successful re-enqueue
    await job.remove();

    this.logger.warn(
      `DLQ job replayed | originalJobId=${jobId} newJobId=${newJobId} type=${payload.callbackType}`,
    );

    return { requeued: true, jobId: newJobId };
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  /**
   * Returns a previously consumed rate-limit slot after a transient Daraja failure.
   *
   * Redis errors are intentionally swallowed. If decrIfPositive fails the counter
   * stays too high for the rest of the day — the member may see a false rate-limit
   * on their next attempt. That is the safer failure mode: prefer a temporary
   * false-limit over masking the original error or leaking an unhandled rejection.
   *
   * The warn-level log provides an audit trail in production logs for on-call
   * investigation if members report unexpected limits during an outage window.
   */
  private async safeReleaseRateLimitSlot(
    rlKey: string,
    tenantId: string,
    memberId: string,
  ): Promise<void> {
    const newCount = await this.redis.decrIfPositive(rlKey);
    this.logger.warn(
      `STK rate-limit slot restored (retryable Daraja error) | ` +
        `tenant=${tenantId} member=${memberId} newCount=${newCount}`,
    );
  }

  private buildAccountRef(dto: MemberDepositDto): string {
    if (dto.purpose === DepositPurpose.LOAN_REPAYMENT) {
      return `LOAN-${dto.accountRef}`.slice(0, 30);
    }
    return dto.accountRef.slice(0, 30);
  }

  private async verifyAccountRef(
    purpose: DepositPurpose,
    accountRef: string,
    tenantId: string,
  ): Promise<void> {
    if (purpose === DepositPurpose.LOAN_REPAYMENT) {
      await this.loanRepaymentService.validateLoanForRepayment(accountRef, tenantId);
    } else {
      const account = await this.prisma.account.findFirst({
        where: { accountNumber: accountRef, tenantId, isActive: true },
        select: { id: true },
      });
      if (!account) {
        throw new NotFoundException(`Account "${accountRef}" not found or inactive`);
      }
    }
  }

  // ─── Scheduler-initiated STK Push (no userId resolution, no rate-limit) ──

  /**
   * Initiates an STK Push for a loan repayment that was enqueued by
   * MpesaRepaymentScheduler. Called exclusively from MpesaRepaymentProcessor.
   *
   * Differences from initiateDeposit():
   *  - Accepts memberId directly (scheduler resolved it from the loan at schedule time)
   *  - Skips rate-limit check (scheduler already enforced stk:limit:{memberId})
   *  - Skips account-ref validation (scheduler already verified via loan query)
   *  - triggerSource is always SYSTEM
   *
   * Idempotency: The BullMQ jobId (stk-repay-{loanId}-{YYYYMMDD}) on the
   * MPESA_STK_REPAYMENT queue prevents duplicate processing within the same day
   * (Layer 1). MpesaTransaction.reference @unique is Layer 3.
   */
  async initiateScheduledStkPush(payload: {
    loanId: string;
    memberId: string;
    tenantId: string;
    phone: string;
    amount: number;
    accountReference: string;
    triggerSource: MpesaTriggerSource;
  }): Promise<{ checkoutRequestId: string; mpesaTxId: string }> {
    const { loanId, memberId, tenantId, phone, amount, accountReference, triggerSource } = payload;

    const baseUrl = this.config.get<string>('app.mpesa.callbackUrl', '');
    const callbackUrl = `${baseUrl}/mpesa/callback`;

    const darajaResp = await this.daraja.initiateSTKPush({
      phoneNumber: phone,
      amount,
      accountReference,
      transactionDesc: 'Scheduled loan repayment',
      callbackUrl,
    });

    const reference = buildMpesaRef.stk(darajaResp.CheckoutRequestID);

    const mpesaTx = await this.prisma.mpesaTransaction.create({
      data: {
        tenantId,
        memberId,
        loanId,
        type: MpesaTxType.STK_PUSH,
        triggerSource,
        checkoutRequestId: darajaResp.CheckoutRequestID,
        merchantRequestId: darajaResp.MerchantRequestID,
        phoneNumber: phone,
        amount: new Decimal(amount).toDecimalPlaces(4).toString(),
        accountReference,
        description: 'Scheduled loan repayment',
        reference,
        status: TransactionStatus.PENDING,
      },
    });

    this.logger.log(
      `Scheduled STK Push | tenant=${tenantId} member=${memberId} loan=${loanId} ` +
        `phone=${maskPhone(phone)} amount=${amount} checkout=${darajaResp.CheckoutRequestID}`,
    );

    return {
      checkoutRequestId: darajaResp.CheckoutRequestID,
      mpesaTxId: mpesaTx.id,
    };
  }

  static secondsUntilMidnightEAT(): number {
    return secondsUntilMidnightEAT();
  }
}
