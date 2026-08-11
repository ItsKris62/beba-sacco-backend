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
import { createHash } from 'crypto';
import {
  Prisma,
  MpesaTxType,
  MpesaTriggerSource,
  OutboxStatus,
  TransactionStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { DarajaClientService } from './daraja-client.service';
import {
  MwaloniAuthDiagnostic,
  MwaloniClientService,
  MwaloniResponse,
} from './mwaloni-client.service';
import { B2cProviderUnavailableException, MpesaException } from './exceptions/mpesa.exceptions';
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
import { LedgerService } from '../accounting/ledger.service';

export interface B2cWalletBalanceSnapshot {
  provider: 'MWALONI';
  currency: string;
  balance: number | null;
  availableBalance: number | null;
  actualBalance: number | null;
  providerStatus: string | null;
  message: string | null;
  checkedAt: string;
  providerData: Prisma.JsonValue;
}

export interface MwaloniB2cAuthDiagnostic extends MwaloniAuthDiagnostic {
  tenantId: string;
}

// ─── Redis key helpers ────────────────────────────────────────────────────────

const stkRateLimitKey = (tenantId: string, memberId: string) =>
  `mpesa:stk:rl:${tenantId}:${memberId}`;

const CALLBACK_RETRY_DELAY_MS = 60_000;

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
    @Optional() private readonly mwaloni?: MwaloniClientService,
    @Optional() private readonly ledger?: LedgerService,
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

  async getB2cWalletBalance(
    actorUserId: string,
    tenantId: string,
  ): Promise<B2cWalletBalanceSnapshot> {
    if (!this.mwaloni?.isEnabled()) {
      throw new B2cProviderUnavailableException('Mwaloni B2C wallet is not enabled');
    }

    const response = await this.mwaloni.fetchBalance();
    const snapshot = this.normalizeMwaloniBalance(response);

    await this.audit
      .create({
        tenantId,
        actorId: actorUserId,
        action: 'MPESA.B2C_WALLET.BALANCE_CHECK',
        entityType: 'MwaloniWallet',
        entityId: 'global',
        newValue: {
          provider: snapshot.provider,
          currency: snapshot.currency,
          balance: snapshot.balance,
          availableBalance: snapshot.availableBalance,
          actualBalance: snapshot.actualBalance,
          providerStatus: snapshot.providerStatus,
        },
        metadata: {
          provider: snapshot.provider,
          providerStatus: snapshot.providerStatus,
          hasBalance: snapshot.balance !== null,
        },
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `B2C wallet balance audit failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );

    return snapshot;
  }

  async diagnoseMwaloniB2cAuthentication(
    actorUserId: string,
    tenantId: string,
  ): Promise<MwaloniB2cAuthDiagnostic> {
    const diagnostic = this.mwaloni
      ? await this.mwaloni.diagnoseAuthentication()
      : ({
          credentialSource: 'ENVIRONMENT_VARIABLES',
          effectiveEnvironment: this.config.get<string>('app.mwaloni.env', 'sandbox'),
          effectiveBaseUrlHost: null,
          connectionId: null,
          serviceId: this.config.get<string>('app.mwaloni.serviceId')?.trim() || null,
          enabled: false,
          fields: {
            serviceId: {
              present: false,
              length: 0,
              trimmedLength: 0,
              hasLeadingWhitespace: false,
              hasTrailingWhitespace: false,
            },
            username: {
              present: false,
              length: 0,
              trimmedLength: 0,
              hasLeadingWhitespace: false,
              hasTrailingWhitespace: false,
            },
            password: {
              present: false,
              length: 0,
              trimmedLength: 0,
              hasLeadingWhitespace: false,
              hasTrailingWhitespace: false,
            },
            apiKey: {
              present: false,
              length: 0,
              trimmedLength: 0,
              hasLeadingWhitespace: false,
              hasTrailingWhitespace: false,
            },
          },
          requestShape: {
            endpoint: 'authenticate',
            method: 'POST',
            contentType: 'application/json',
            apiKeyHeader: 'x-api-key',
            authorizationHeaderSent: false,
            bodyFields: ['username', 'password'],
            usesTokenCache: false,
          },
          authResult: {
            attempted: false,
            success: false,
            status: 'CLIENT_UNAVAILABLE',
            message: 'Mwaloni diagnostic client is not available',
            tokenReturned: false,
            tokenType: null,
            expiresIn: null,
            httpStatus: null,
            errorCode: 'MWALONI_CLIENT_UNAVAILABLE',
            retryable: false,
          },
        } as MwaloniAuthDiagnostic);

    const result: MwaloniB2cAuthDiagnostic = {
      tenantId,
      ...diagnostic,
    };

    await this.audit.create({
      tenantId,
      actorId: actorUserId,
      action: 'MPESA.B2C_WALLET.AUTH_DIAGNOSTIC',
      entityType: 'MwaloniWallet',
      entityId: diagnostic.connectionId ?? 'global',
      newValue: {
        tenantId,
        connectionId: diagnostic.connectionId,
        credentialSource: diagnostic.credentialSource,
        effectiveEnvironment: diagnostic.effectiveEnvironment,
        effectiveBaseUrlHost: diagnostic.effectiveBaseUrlHost,
        serviceId: diagnostic.serviceId,
        enabled: diagnostic.enabled,
        fields: diagnostic.fields,
        authResult: diagnostic.authResult,
      },
      metadata: {
        provider: 'MWALONI',
        diagnostic: 'B2C_AUTH',
        authAttempted: diagnostic.authResult.attempted,
        authSuccess: diagnostic.authResult.success,
        providerStatus: diagnostic.authResult.status,
        credentialSource: diagnostic.credentialSource,
        effectiveEnvironment: diagnostic.effectiveEnvironment,
      },
    });

    return result;
  }

  // ─── Direct B2C (called by the disbursement processor) ─────────────────

  /**
   * Performs the actual B2C payout using the mandatory Mwaloni payment wallet.
   * C2B/STK remain Daraja; B2C never falls back to Daraja.
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

    if (sourceTransactionId) {
      const existing = await this.prisma.mpesaTransaction.findUnique({
        where: { transactionId: sourceTransactionId },
        select: {
          id: true,
          conversationId: true,
          referenceId: true,
          referenceType: true,
          tenantId: true,
          status: true,
          reconciliationDueAt: true,
        },
      });
      if (existing?.conversationId) {
        if (
          existing.status === TransactionStatus.PENDING ||
          existing.status === TransactionStatus.RECON_PENDING
        ) {
          await this.scheduleB2cTimeoutCheck({
            referenceId: existing.referenceId ?? referenceId,
            referenceType: (existing.referenceType ?? referenceType) as
              | 'LOAN_DISBURSEMENT'
              | 'FOSA_WITHDRAWAL',
            tenantId: existing.tenantId,
            conversationId: existing.conversationId,
          });
        }
        return { conversationId: existing.conversationId, mpesaTxId: existing.id };
      }
      if (existing) {
        throw new BadRequestException(
          'B2C dispatch is already in an ambiguous provider state and requires reconciliation',
        );
      }
    }

    if (!this.mwaloni?.isEnabled()) {
      throw new B2cProviderUnavailableException(
        'Mwaloni B2C payment wallet is not enabled or available',
      );
    }

    return this.executeMwaloniMobilePayout({
      referenceId,
      referenceType,
      tenantId,
      memberId,
      accountReference,
      phone,
      amount,
      triggeredBy,
      sourceTransactionId,
    });
  }

  // ─── Callback enqueueing ────────────────────────────────────────────────

  private async executeMwaloniMobilePayout(params: {
    referenceId: string;
    referenceType: 'LOAN_DISBURSEMENT' | 'FOSA_WITHDRAWAL';
    tenantId: string;
    memberId: string;
    accountReference: string;
    phone: string;
    amount: number;
    triggeredBy: string;
    sourceTransactionId?: string;
  }): Promise<{ conversationId: string; mpesaTxId: string }> {
    if (!this.mwaloni) {
      throw new B2cProviderUnavailableException('Mwaloni B2C client is not available');
    }

    const orderNumber = this.buildMwaloniOrderNumber(params);
    const reference = buildMpesaRef.b2c(orderNumber);
    const existing = await this.prisma.mpesaTransaction.findUnique({ where: { reference } });

    if (existing) {
      if (
        existing.status === TransactionStatus.PENDING ||
        existing.status === TransactionStatus.RECON_PENDING
      ) {
        await this.refreshMwaloniB2cStatus(existing.id);
      }
      return { conversationId: orderNumber, mpesaTxId: existing.id };
    }

    const reconciliationDueAt = new Date(Date.now() + 30 * 60 * 1000);
    const requestPayload = {
      provider: 'MWALONI',
      orderNumber,
      request: {
        channel: 'daraja-mobile',
        serviceId: this.config.get<string>('app.mwaloni.serviceId'),
        accountNumber: maskPhone(params.phone),
        amount: params.amount,
        accountReference: params.accountReference,
      },
    } satisfies Prisma.InputJsonObject;

    const mpesaTx = await this.prisma.$transaction(async (tx) => {
      const row = await tx.mpesaTransaction.create({
        data: {
          tenantId: params.tenantId,
          memberId: params.memberId,
          referenceType: params.referenceType,
          referenceId: params.referenceId,
          ...(params.sourceTransactionId && { transactionId: params.sourceTransactionId }),
          type: MpesaTxType.B2C,
          triggerSource:
            params.triggeredBy === 'SYSTEM'
              ? MpesaTriggerSource.SYSTEM
              : MpesaTriggerSource.OFFICER,
          conversationId: orderNumber,
          phoneNumber: params.phone,
          amount: new Decimal(params.amount).toDecimalPlaces(4).toString(),
          accountReference: params.accountReference,
          description: 'FOSA Withdrawal via Mwaloni',
          reference,
          status: TransactionStatus.PENDING,
          reconciliationDueAt,
          callbackPayload: requestPayload,
        },
      });

      await this.audit.createAtomic(tx, {
        tenantId: params.tenantId,
        actorId: params.triggeredBy,
        action: 'MWALONI.B2C.INITIATED',
        entityType: 'MpesaTransaction',
        entityId: row.id,
        newValue: {
          status: 'PENDING',
          provider: 'MWALONI',
          orderNumber,
          amount: params.amount,
        },
        metadata: {
          referenceType: params.referenceType,
          referenceId: params.referenceId,
          transactionId: params.sourceTransactionId,
          memberId: params.memberId,
          phone: maskPhone(params.phone),
        },
      });

      return row;
    });

    const response = await this.mwaloni.sendMobile({
      orderNumber,
      phoneNumber: params.phone,
      amount: params.amount,
      description: `FOSA withdrawal ${params.accountReference}`.slice(0, 100),
    });

    await this.applyMwaloniStatus(mpesaTx.id, response, 'send-money');

    this.logger.log(
      `Mwaloni B2C submitted | tenant=${params.tenantId} refType=${params.referenceType} ` +
        `refId=${params.referenceId} order=${orderNumber} phone=${maskPhone(params.phone)} amount=${params.amount}`,
    );

    await this.scheduleB2cTimeoutCheck({
      referenceId: params.referenceId,
      referenceType: params.referenceType,
      tenantId: params.tenantId,
      conversationId: orderNumber,
    });

    return { conversationId: orderNumber, mpesaTxId: mpesaTx.id };
  }

  async refreshMwaloniB2cStatus(mpesaTransactionId: string): Promise<{
    refreshed: boolean;
    terminal: boolean;
    status?: TransactionStatus;
  }> {
    if (!this.mwaloni?.isEnabled()) {
      return { refreshed: false, terminal: false };
    }

    const mpesaTx = await this.prisma.mpesaTransaction.findUnique({
      where: { id: mpesaTransactionId },
      select: { id: true, conversationId: true, status: true, type: true },
    });
    if (!mpesaTx || mpesaTx.type !== MpesaTxType.B2C || !mpesaTx.conversationId) {
      return { refreshed: false, terminal: false };
    }
    if (
      mpesaTx.status !== TransactionStatus.PENDING &&
      mpesaTx.status !== TransactionStatus.RECON_PENDING
    ) {
      return { refreshed: false, terminal: true, status: mpesaTx.status };
    }

    const response = await this.mwaloni.getStatus(mpesaTx.conversationId);
    return this.applyMwaloniStatus(mpesaTx.id, response, 'get-transaction-status');
  }

  async refreshMwaloniB2cStatusByConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<{ refreshed: boolean; terminal: boolean; status?: TransactionStatus }> {
    const mpesaTx = await this.prisma.mpesaTransaction.findFirst({
      where: { tenantId, conversationId, type: MpesaTxType.B2C },
      select: { id: true },
    });
    if (!mpesaTx) return { refreshed: false, terminal: false };
    return this.refreshMwaloniB2cStatus(mpesaTx.id);
  }

  private async applyMwaloniStatus(
    mpesaTransactionId: string,
    response: MwaloniResponse,
    source: 'send-money' | 'get-transaction-status',
  ): Promise<{ refreshed: boolean; terminal: boolean; status?: TransactionStatus }> {
    const status = String(response.status ?? '').trim();
    const message = response.message ?? 'Mwaloni response received';
    const payload = {
      provider: 'MWALONI',
      source,
      response: this.toJsonObject(response),
      checkedAt: new Date().toISOString(),
    } satisfies Prisma.InputJsonObject;

    if (this.isMwaloniSuccess(status)) {
      await this.prisma.$transaction(async (tx) => {
        const claim = await tx.mpesaTransaction.updateMany({
          where: {
            id: mpesaTransactionId,
            status: { in: [TransactionStatus.PENDING, TransactionStatus.RECON_PENDING] },
          },
          data: {
            status: TransactionStatus.COMPLETED,
            resultCode: 0,
            resultDesc: message,
            callbackPayload: payload,
            transactionDate: new Date(),
          },
        });
        const row = await tx.mpesaTransaction.findUniqueOrThrow({
          where: { id: mpesaTransactionId },
        });
        if (claim.count > 0) {
          await this.audit.createAtomic(tx, {
            tenantId: row.tenantId,
            actorId: 'SYSTEM',
            action: 'MWALONI.B2C.COMPLETED',
            entityType: 'MpesaTransaction',
            entityId: row.id,
            newValue: {
              status: row.status,
              resultCode: row.resultCode,
              resultDesc: row.resultDesc,
            },
            metadata: {
              provider: 'MWALONI',
              orderNumber: row.conversationId,
              referenceId: row.referenceId,
              transactionId: row.transactionId,
              memberId: row.memberId,
              amount: row.amount.toString(),
              phone: maskPhone(row.phoneNumber),
              providerStatus: response.status,
            },
          });
        }
        return row;
      });

      return { refreshed: true, terminal: true, status: TransactionStatus.COMPLETED };
    }

    if (this.isMwaloniPending(status)) {
      await this.prisma.mpesaTransaction.update({
        where: { id: mpesaTransactionId },
        data: {
          resultDesc: message,
          callbackPayload: payload,
        },
      });
      return { refreshed: true, terminal: false, status: TransactionStatus.PENDING };
    }

    const resultCode = /^\d+$/.test(status) ? Number(status) : null;
    await this.failMwaloniTransaction(mpesaTransactionId, {
      resultCode,
      resultDesc: message,
      failureReason: status ? `MWALONI_STATUS_${status}` : 'MWALONI_STATUS_UNKNOWN',
      payload,
    });

    return { refreshed: true, terminal: true, status: TransactionStatus.FAILED };
  }

  private async failMwaloniTransaction(
    mpesaTransactionId: string,
    params: {
      resultCode: number | null;
      resultDesc: string;
      failureReason: string;
      payload: Prisma.InputJsonObject;
    },
  ) {
    const txClient = this.prisma.directClient ?? this.prisma;
    return txClient.$transaction(
      async (tx) => {
        const mpesaTx = await tx.mpesaTransaction.findUnique({
          where: { id: mpesaTransactionId },
        });
        if (!mpesaTx) {
          throw new NotFoundException('Mwaloni B2C transaction not found');
        }

        if (
          mpesaTx.status !== TransactionStatus.PENDING &&
          mpesaTx.status !== TransactionStatus.RECON_PENDING
        ) {
          return mpesaTx;
        }

        const updated = await tx.mpesaTransaction.update({
          where: { id: mpesaTx.id },
          data: {
            status: TransactionStatus.FAILED,
            resultCode: params.resultCode,
            resultDesc: params.resultDesc,
            failureReason: params.failureReason,
            callbackPayload: params.payload,
          },
        });

        if (mpesaTx.referenceType === 'FOSA_WITHDRAWAL' && mpesaTx.transactionId && this.ledger) {
          await this.ledger.reverseTransaction({
            tenantId: mpesaTx.tenantId,
            originalTransactionId: mpesaTx.transactionId,
            reason: `Mwaloni B2C failed: ${params.resultDesc}`,
            tx,
          });
        }

        await this.audit.createAtomic(tx, {
          tenantId: mpesaTx.tenantId,
          actorId: 'SYSTEM',
          action: 'MWALONI.B2C.FAILED_REFUNDED',
          entityType: 'MpesaTransaction',
          entityId: mpesaTx.id,
          oldValue: { status: mpesaTx.status },
          newValue: {
            status: TransactionStatus.FAILED,
            resultCode: params.resultCode,
            resultDesc: params.resultDesc,
            failureReason: params.failureReason,
          },
          metadata: {
            provider: 'MWALONI',
            orderNumber: mpesaTx.conversationId,
            referenceId: mpesaTx.referenceId,
            transactionId: mpesaTx.transactionId,
            memberId: mpesaTx.memberId,
            amount: mpesaTx.amount.toString(),
            phone: maskPhone(mpesaTx.phoneNumber),
          },
        });

        return updated;
      },
      { isolationLevel: 'Serializable' },
    );
  }

  private async auditMwaloniTerminal(
    mpesaTx: {
      id: string;
      tenantId: string;
      memberId: string | null;
      referenceId: string | null;
      transactionId: string | null;
      phoneNumber: string;
      amount: Decimal;
      conversationId: string | null;
      status: TransactionStatus;
      resultCode: number | null;
      resultDesc: string | null;
    },
    action: string,
    response: MwaloniResponse,
  ): Promise<void> {
    await this.audit
      .create({
        tenantId: mpesaTx.tenantId,
        actorId: 'SYSTEM',
        action,
        entityType: 'MpesaTransaction',
        entityId: mpesaTx.id,
        newValue: {
          status: mpesaTx.status,
          resultCode: mpesaTx.resultCode,
          resultDesc: mpesaTx.resultDesc,
        },
        metadata: {
          provider: 'MWALONI',
          orderNumber: mpesaTx.conversationId,
          referenceId: mpesaTx.referenceId,
          transactionId: mpesaTx.transactionId,
          memberId: mpesaTx.memberId,
          amount: mpesaTx.amount.toString(),
          phone: maskPhone(mpesaTx.phoneNumber),
          providerStatus: response.status,
        },
      })
      .catch((e: unknown) =>
        this.logger.warn(`Audit emit failed: ${e instanceof Error ? e.message : String(e)}`),
      );
  }

  private buildMwaloniOrderNumber(params: {
    referenceId: string;
    sourceTransactionId?: string;
  }): string {
    if (params.sourceTransactionId) return `MWD-${params.sourceTransactionId}`;
    return `MWD-${params.referenceId}-${Date.now()}`;
  }

  private isMwaloniSuccess(status: string): boolean {
    return status === '00';
  }

  private isMwaloniPending(status: string): boolean {
    return ['02', '03', 'PENDING', 'PROCESSING', 'QUEUED', 'IN_PROGRESS'].includes(
      status.toUpperCase(),
    );
  }

  private normalizeMwaloniBalance(response: MwaloniResponse): B2cWalletBalanceSnapshot {
    const availableBalance = this.extractNumericField(response, [
      'availableBalance',
      'available_balance',
      'available',
      'walletBalance',
      'wallet_balance',
      'balance',
    ]);
    const actualBalance = this.extractNumericField(response, [
      'actualBalance',
      'actual_balance',
      'ledgerBalance',
      'ledger_balance',
      'currentBalance',
      'current_balance',
      'balance',
    ]);
    const balance = availableBalance ?? actualBalance;
    const currency =
      this.extractStringField(response, ['currency', 'currencyCode', 'currency_code']) ?? 'KES';

    return {
      provider: 'MWALONI',
      currency,
      balance,
      availableBalance,
      actualBalance,
      providerStatus: response.status ?? null,
      message: response.message ?? null,
      checkedAt: new Date().toISOString(),
      providerData: this.sanitizeProviderPayload(response),
    };
  }

  private extractNumericField(value: unknown, fieldNames: string[]): number | null {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.extractNumericField(item, fieldNames);
        if (found !== null) return found;
      }
      return null;
    }

    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const wanted = new Set(fieldNames.map((name) => name.toLowerCase()));

    for (const [key, raw] of Object.entries(record)) {
      if (!wanted.has(key.toLowerCase())) continue;
      const numeric = this.toFiniteNumber(raw);
      if (numeric !== null) return numeric;
    }

    for (const raw of Object.values(record)) {
      const found = this.extractNumericField(raw, fieldNames);
      if (found !== null) return found;
    }
    return null;
  }

  private extractStringField(value: unknown, fieldNames: string[]): string | null {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.extractStringField(item, fieldNames);
        if (found) return found;
      }
      return null;
    }

    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const wanted = new Set(fieldNames.map((name) => name.toLowerCase()));

    for (const [key, raw] of Object.entries(record)) {
      if (wanted.has(key.toLowerCase()) && typeof raw === 'string' && raw.trim()) {
        return raw.trim();
      }
    }

    for (const raw of Object.values(record)) {
      const found = this.extractStringField(raw, fieldNames);
      if (found) return found;
    }
    return null;
  }

  private toFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const normalized = value
      .replace(/,/g, '')
      .replace(/[^\d.-]/g, '')
      .trim();
    if (!normalized) return null;
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? numeric : null;
  }

  private sanitizeProviderPayload(value: unknown): Prisma.JsonValue {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeProviderPayload(item));
    }
    if (typeof value === 'object') {
      const sanitized: Record<string, Prisma.JsonValue> = {};
      for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        sanitized[key] = this.isSensitiveProviderKey(key)
          ? '[REDACTED]'
          : this.sanitizeProviderPayload(raw);
      }
      return sanitized;
    }
    return String(value);
  }

  private isSensitiveProviderKey(key: string): boolean {
    return /(token|password|secret|api[_-]?key|authorization|credential)/i.test(key);
  }

  private toJsonObject(value: unknown): Prisma.InputJsonObject {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonObject;
  }

  private async scheduleB2cTimeoutCheck(params: {
    referenceId: string;
    referenceType: 'LOAN_DISBURSEMENT' | 'FOSA_WITHDRAWAL';
    tenantId: string;
    conversationId: string;
  }): Promise<void> {
    try {
      await this.b2cTimeoutQueue.add('b2c-timeout-check', params, {
        delay: 30 * 60 * 1000,
        jobId: `b2c-timeout.${params.conversationId}`,
        removeOnComplete: true,
        removeOnFail: { age: 86400, count: 50 },
      });
    } catch (error) {
      this.logger.warn(
        `B2C timeout job scheduling failed; DB reconciliationDueAt remains authoritative | conversation=${params.conversationId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async enqueueCallback(
    payload: Record<string, unknown>,
    callbackType: MpesaCallbackJobPayload['callbackType'],
    uniqueId: string,
    tenantId = 'resolve-in-processor',
    correlationId?: string,
  ): Promise<void> {
    const inbox = await this.persistCallbackPayload(
      payload,
      callbackType,
      uniqueId,
      tenantId,
      correlationId,
    );
    await this.enqueueCallbackInbox(inbox.id);
  }

  async dispatchPendingCallbackInbox(limit = 50): Promise<number> {
    const now = new Date();
    const staleProcessingCutoff = new Date(Date.now() - 5 * 60_000);
    const rows = await this.prisma.mpesaCallbackInbox.findMany({
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
      select: { id: true },
    });

    let queued = 0;
    for (const row of rows) {
      const result = await this.enqueueCallbackInbox(row.id);
      if (result.queued) queued++;
    }
    return queued;
  }

  private async enqueueCallbackInbox(
    callbackInboxId: string,
  ): Promise<{ queued: boolean; jobId?: string }> {
    const inbox = await this.prisma.mpesaCallbackInbox.findUnique({
      where: { id: callbackInboxId },
      select: {
        id: true,
        tenantId: true,
        callbackType: true,
        providerUniqueId: true,
        correlationId: true,
        mpesaTransactionId: true,
        status: true,
      },
    });
    if (!inbox || inbox.status === OutboxStatus.DELIVERED) {
      return { queued: false };
    }

    const callbackType = inbox.callbackType as MpesaCallbackJobPayload['callbackType'];
    const jobId =
      `mpesa-callback-${inbox.tenantId}-${callbackType}-${inbox.providerUniqueId}`.replace(
        /[^A-Za-z0-9_.:-]/g,
        '-',
      );

    try {
      await this.callbackQueue.add(
        'process-callback',
        {
          tenantId: inbox.tenantId,
          correlationId: inbox.correlationId ?? undefined,
          mpesaTransactionId: inbox.mpesaTransactionId ?? undefined,
          callbackInboxId: inbox.id,
          callbackType,
        },
        {
          jobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 3000 },
          removeOnComplete: { age: 3600, count: 200 },
          removeOnFail: { age: 604800, count: 100 },
        },
      );
      await this.prisma.mpesaCallbackInbox.update({
        where: { id: inbox.id },
        data: {
          status: OutboxStatus.PROCESSING,
          queueJobId: jobId,
          lastError: null,
          nextRetryAt: null,
        },
      });
      this.logger.log(
        `JOB_ENQUEUED queue=${QUEUE_NAMES.MPESA_CALLBACK} type=${callbackType} jobId=${jobId} tenant=${inbox.tenantId} mpesaTransactionId=${inbox.mpesaTransactionId ?? ''} correlation=${inbox.correlationId ?? ''}`,
      );
      return { queued: true, jobId };
    } catch (error) {
      await this.prisma.mpesaCallbackInbox.update({
        where: { id: inbox.id },
        data: {
          status: OutboxStatus.FAILED,
          attempts: { increment: 1 },
          lastError: error instanceof Error ? error.message : String(error),
          nextRetryAt: new Date(Date.now() + CALLBACK_RETRY_DELAY_MS),
        },
      });
      this.logger.warn(
        `Callback inbox persisted but queue dispatch failed inbox=${inbox.id} type=${callbackType}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { queued: false, jobId };
    }
  }

  private async persistCallbackPayload(
    payload: Record<string, unknown>,
    callbackType: MpesaCallbackJobPayload['callbackType'],
    uniqueId: string,
    tenantId: string,
    correlationId?: string,
  ): Promise<{ id: string; mpesaTransactionId?: string | null }> {
    const rawPayload = payload as Prisma.InputJsonValue;
    const resolvedTenantId =
      tenantId && tenantId !== 'resolve-in-processor' ? tenantId : 'UNRESOLVED';
    const rawBodySha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

    if (isStkCallback(payload)) {
      const checkoutRequestId = payload.Body.stkCallback.CheckoutRequestID;
      return this.prisma.$transaction(async (tx) => {
        const transaction = await tx.mpesaTransaction.findUnique({
          where: { checkoutRequestId },
          select: { id: true, tenantId: true },
        });

        if (!transaction) {
          throw new Error(
            `STK callback has no MpesaTransaction for CheckoutRequestID=${checkoutRequestId}`,
          );
        }

        const uniqueKey = this.callbackUniqueKey(
          'MPESA',
          transaction.tenantId,
          callbackType,
          uniqueId,
        );
        await tx.mpesaTransaction.update({
          where: { id: transaction.id },
          data: { callbackPayload: rawPayload },
        });
        return tx.mpesaCallbackInbox.upsert({
          where: { uniqueKey },
          create: {
            tenantId: transaction.tenantId,
            callbackType,
            providerUniqueId: uniqueId,
            uniqueKey,
            payload: rawPayload,
            rawBodySha256,
            correlationId,
            mpesaTransactionId: transaction.id,
          },
          update: {
            payload: rawPayload,
            rawBodySha256,
            correlationId,
            mpesaTransactionId: transaction.id,
          },
          select: { id: true, mpesaTransactionId: true },
        });
      });
    }

    if (isB2cCallback(payload)) {
      const { ConversationID, OriginatorConversationID } = payload.Result;
      return this.prisma.$transaction(async (tx) => {
        const transaction = await tx.mpesaTransaction.findFirst({
          where: {
            OR: [
              { conversationId: ConversationID },
              { originatorConversationId: OriginatorConversationID },
            ],
          },
          select: { id: true, tenantId: true },
        });

        if (!transaction) {
          throw new Error(
            `B2C callback has no MpesaTransaction for ConversationID=${ConversationID}`,
          );
        }

        const uniqueKey = this.callbackUniqueKey(
          'MPESA',
          transaction.tenantId,
          callbackType,
          uniqueId,
        );
        await tx.mpesaTransaction.update({
          where: { id: transaction.id },
          data: { callbackPayload: rawPayload },
        });
        return tx.mpesaCallbackInbox.upsert({
          where: { uniqueKey },
          create: {
            tenantId: transaction.tenantId,
            callbackType,
            providerUniqueId: uniqueId,
            uniqueKey,
            payload: rawPayload,
            rawBodySha256,
            correlationId,
            mpesaTransactionId: transaction.id,
          },
          update: {
            payload: rawPayload,
            rawBodySha256,
            correlationId,
            mpesaTransactionId: transaction.id,
          },
          select: { id: true, mpesaTransactionId: true },
        });
      });
    }

    if (isC2bCallback(payload)) {
      const amount = new Decimal(payload.TransAmount);
      const reference = buildMpesaRef.c2b(payload.TransID);
      return this.prisma.$transaction(async (tx) => {
        const transaction = await tx.mpesaTransaction.upsert({
          where: { reference },
          create: {
            tenantId: resolvedTenantId,
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
          select: { id: true, tenantId: true },
        });
        const uniqueKey = this.callbackUniqueKey(
          'MPESA',
          transaction.tenantId,
          callbackType,
          uniqueId,
        );
        return tx.mpesaCallbackInbox.upsert({
          where: { uniqueKey },
          create: {
            tenantId: transaction.tenantId,
            callbackType,
            providerUniqueId: uniqueId,
            uniqueKey,
            payload: rawPayload,
            rawBodySha256,
            correlationId,
            mpesaTransactionId: transaction.id,
          },
          update: {
            payload: rawPayload,
            rawBodySha256,
            correlationId,
            mpesaTransactionId: transaction.id,
          },
          select: { id: true, mpesaTransactionId: true },
        });
      });
    }

    throw new Error(`Unsupported M-Pesa callback structure for type=${callbackType}`);
  }

  private callbackUniqueKey(
    provider: 'MPESA' | 'MWALONI',
    tenantId: string,
    callbackType: MpesaCallbackJobPayload['callbackType'],
    uniqueId: string,
  ): string {
    return `${provider}:${tenantId}:${callbackType}:${uniqueId}`;
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
