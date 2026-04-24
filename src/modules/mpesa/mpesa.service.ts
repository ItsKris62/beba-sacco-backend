import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Decimal } from 'decimal.js';
import { MpesaTxType, MpesaTriggerSource, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { DarajaClientService } from './daraja-client.service';
import { MemberDepositDto, DepositPurpose } from './dto/deposit-request.dto';
import { maskPhone, buildMpesaRef } from './utils/mpesa.utils';
import {
  MpesaCallbackJobPayload,
  MpesaDisbursementJobPayload,
  QUEUE_NAMES,
} from '../queue/queue.constants';

// ─── Redis key helpers ────────────────────────────────────────────────────────

const stkRateLimitKey = (tenantId: string, memberId: string) =>
  `mpesa:stk:rl:${tenantId}:${memberId}`;

function secondsUntilMidnightEAT(): number {
  const now = new Date();
  const eatOffset = 3 * 60 * 60 * 1000;
  const eat = new Date(now.getTime() + eatOffset);
  const midnight = new Date(
    Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate() + 1),
  );
  return Math.ceil((midnight.getTime() - now.getTime()) / 1000);
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class MpesaService {
  private readonly logger = new Logger(MpesaService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly daraja: DarajaClientService,
    @InjectQueue(QUEUE_NAMES.MPESA_CALLBACK)
    private readonly callbackQueue: Queue<MpesaCallbackJobPayload>,
    @InjectQueue(QUEUE_NAMES.MPESA_DISBURSEMENT)
    private readonly disbursementQueue: Queue<MpesaDisbursementJobPayload>,
    @InjectQueue(QUEUE_NAMES.MPESA_CALLBACK_DLQ)
    private readonly callbackDlqQueue: Queue,
  ) {}

  // ─── Member Deposit (STK Push) ──────────────────────────────────────────

  async initiateDeposit(
    dto: MemberDepositDto,
    tenantId: string,
    actorUserId: string,
    triggeredBy: string,
    triggerSource: MpesaTriggerSource = MpesaTriggerSource.MEMBER,
  ): Promise<{ checkoutRequestId: string; customerMessage: string; mpesaTxId: string }> {
    const member = await this.prisma.member.findFirst({
      where: { userId: actorUserId, tenantId },
      select: { id: true },
    });
    if (!member) {
      throw new BadRequestException('No member profile found for this user in the current tenant');
    }
    const memberId = member.id;

    const maxPerDay = this.config.get<number>('app.mpesa.stkRateLimitPerDay', 3);
    const rlKey = stkRateLimitKey(tenantId, memberId);
    const currentCount = await this.redis.incr(rlKey);
    if (currentCount === 1) {
      await this.redis.expire(rlKey, secondsUntilMidnightEAT());
    }
    if (currentCount > maxPerDay) {
      throw new BadRequestException(
        `STK Push limit reached: ${maxPerDay} requests per day per member`,
      );
    }

    const accountRef = this.buildAccountRef(dto);
    await this.verifyAccountRef(dto.purpose, accountRef, tenantId);

    const baseUrl = this.config.get<string>('app.mpesa.callbackUrl', '');
    const callbackUrl = `${baseUrl}/mpesa/callback`;

    const amount = Math.ceil(dto.amount);
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

    this.logger.log(
      `STK Push initiated | tenant=${tenantId} member=${memberId} ` +
        `phone=${maskPhone(dto.phoneNumber)} amount=${amount} ` +
        `checkout=${darajaResp.CheckoutRequestID}`,
    );

    return {
      checkoutRequestId: darajaResp.CheckoutRequestID,
      customerMessage: darajaResp.CustomerMessage,
      mpesaTxId: mpesaTx.id,
    };
  }

  // ─── B2C Loan Disbursement (queue entry point) ──────────────────────────

  /**
   * Resolves loan phone + amount from the DB, then enqueues a B2C disbursement job.
   * Phone and amount are embedded in the job payload so the processor is a pure
   * executor with no DB lookups — avoids stale-data race conditions under retries.
   */
  async queueLoanDisbursement(
    loanId: string,
    tenantId: string,
    triggeredBy: string,
  ): Promise<{ jobId: string }> {
    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, tenantId },
      include: {
        member: { include: { user: { select: { phoneNumber: true, phone: true } } } },
      },
    });
    if (!loan) {
      throw new NotFoundException(`Loan ${loanId} not found in tenant ${tenantId}`);
    }

    const phone = loan.member.user.phoneNumber ?? loan.member.user.phone;
    if (!phone) {
      throw new BadRequestException(
        `Member ${loan.memberId} has no phone number on file for B2C disbursement`,
      );
    }
    const amount = Math.ceil(new Decimal(loan.principalAmount.toString()).toNumber());

    const jobId = `b2c-disburse-${loanId}`;
    await this.disbursementQueue.add(
      'disburse-loan',
      { loanId, tenantId, phone, amount, triggeredBy },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: { count: 500 },
        removeOnFail: false,
      },
    );
    this.logger.log(
      `B2C disbursement queued | loan=${loanId} job=${jobId} phone=${maskPhone(phone)} amount=${amount}`,
    );
    return { jobId };
  }

  // ─── Direct B2C (called by the disbursement processor) ─────────────────

  /**
   * Performs the actual Daraja B2C call using pre-resolved phone + amount.
   * Called only by MpesaDisbursementProcessor — never from HTTP handlers.
   */
  async executeB2cDisbursement(
    loanId: string,
    tenantId: string,
    phone: string,
    amount: number,
    triggeredBy: string,
  ): Promise<{ conversationId: string; mpesaTxId: string }> {
    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, tenantId },
      select: { memberId: true, loanNumber: true, principalAmount: true },
    });
    if (!loan) {
      throw new NotFoundException(`Loan ${loanId} not found in tenant ${tenantId}`);
    }

    const existing = await this.prisma.mpesaTransaction.findFirst({
      where: {
        tenantId,
        loanId,
        type: MpesaTxType.B2C,
        status: { in: [TransactionStatus.PENDING, TransactionStatus.COMPLETED] },
      },
    });
    if (existing) {
      this.logger.warn(
        `B2C disbursement skipped – record already exists for loan ${loanId}: status=${existing.status}`,
      );
      return {
        conversationId: existing.conversationId ?? existing.id,
        mpesaTxId: existing.id,
      };
    }

    const b2cShortcode = this.config.get<string>('app.mpesa.b2cShortcode', '600000');
    const initiatorName = this.config.get<string>('app.mpesa.initiatorName', 'testapi');
    const securityCredential = this.config.get<string>('app.mpesa.securityCredential', '');
    const resultUrl = this.config.get<string>('app.mpesa.b2cResultUrl', '');
    const queueTimeoutUrl = this.config.get<string>('app.mpesa.b2cQueueTimeoutUrl', '');

    if (!securityCredential) {
      throw new InternalServerErrorException('MPESA_SECURITY_CREDENTIAL not configured');
    }

    const darajaResp = await this.daraja.initiateB2C({
      initiatorName,
      securityCredential,
      commandId: 'BusinessPayment',
      amount,
      partyA: b2cShortcode,
      partyB: phone,
      remarks: `Loan disbursement ${loan.loanNumber ?? loanId}`.slice(0, 100),
      occasionRef: loan.loanNumber ?? loanId,
      resultUrl,
      queueTimeoutUrl,
    });

    const reference = buildMpesaRef.b2c(darajaResp.ConversationID);

    const mpesaTx = await this.prisma.mpesaTransaction.create({
      data: {
        tenantId,
        memberId: loan.memberId,
        loanId,
        type: MpesaTxType.B2C,
        triggerSource:
          triggeredBy === 'SYSTEM' ? MpesaTriggerSource.SYSTEM : MpesaTriggerSource.OFFICER,
        conversationId: darajaResp.ConversationID,
        originatorConversationId: darajaResp.OriginatorConversationID,
        phoneNumber: phone,
        amount: new Decimal(amount).toDecimalPlaces(4).toString(),
        accountReference: loan.loanNumber ?? loanId,
        description: 'Loan disbursement',
        reference,
        status: TransactionStatus.PENDING,
      },
    });

    this.logger.log(
      `B2C initiated | tenant=${tenantId} loan=${loanId} ` +
        `phone=${maskPhone(phone)} conversation=${darajaResp.ConversationID} amount=${amount}`,
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
  ): Promise<void> {
    const jobId = `${callbackType.toLowerCase().replace('_', '-')}-${uniqueId}`;
    await this.callbackQueue.add(
      'process-callback',
      { tenantId: 'resolve-in-processor', callbackPayload: payload, callbackType },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: { count: 2000 },
        removeOnFail: false,
      },
    );
    this.logger.log(`Callback enqueued | type=${callbackType} jobId=${jobId}`);
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
      removeOnComplete: { count: 2000 },
      removeOnFail: false,
    });

    // Remove from DLQ after successful re-enqueue
    await job.remove();

    this.logger.warn(
      `DLQ job replayed | originalJobId=${jobId} newJobId=${newJobId} type=${payload.callbackType}`,
    );

    return { requeued: true, jobId: newJobId };
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

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
      const loanNumber = accountRef.replace(/^LOAN-/, '');
      const loan = await this.prisma.loan.findFirst({
        where: { loanNumber, tenantId },
        select: { id: true, status: true },
      });
      if (!loan) {
        throw new NotFoundException(`Loan "${loanNumber}" not found`);
      }
      const repayableStatuses = ['DISBURSED', 'ACTIVE'];
      if (!repayableStatuses.includes(loan.status)) {
        throw new BadRequestException(`Loan "${loanNumber}" is not in a repayable state`);
      }
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
