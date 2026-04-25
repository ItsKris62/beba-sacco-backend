import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Decimal } from 'decimal.js';
import { Prisma, TransactionStatus, TransactionType, MpesaTxType, MpesaTriggerSource, LoanStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  QUEUE_NAMES,
  MpesaCallbackJobPayload,
} from '../queue.constants';
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
    @InjectQueue(QUEUE_NAMES.MPESA_CALLBACK_DLQ)
    private readonly dlq: Queue,
  ) {
    super();
  }

  // ─── Main dispatcher ──────────────────────────────────────────────────────

  async process(job: Job<MpesaCallbackJobPayload>): Promise<void> {
    const { callbackPayload, callbackType } = job.data;
    this.logger.log(`Processing mpesa callback | job=${job.id} type=${callbackType}`);

    if (isStkCallback(callbackPayload)) {
      await this.handleStkCallback(callbackPayload as unknown as StkCallbackPayload, job.id ?? '');
    } else if (isC2bCallback(callbackPayload)) {
      await this.handleC2bCallback(callbackPayload as unknown as C2bCallbackPayload, job.id ?? '');
    } else if (isB2cCallback(callbackPayload)) {
      await this.handleB2cCallback(callbackPayload as unknown as B2cCallbackPayload, job.id ?? '');
    } else {
      this.logger.warn(`Unknown callback structure for job ${job.id} – logging and discarding`);
    }
  }

  // ─── STK Push result ──────────────────────────────────────────────────────

  private async handleStkCallback(body: StkCallbackPayload, jobId: string): Promise<void> {
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
      this.logger.log(
        `STK callback duplicate skipped: ${CheckoutRequestID} → ${mpesaTx.status}`,
      );
      return;
    }

    const rawPayload = body as unknown as Prisma.InputJsonValue;

    if (ResultCode !== 0) {
      await this.prisma.mpesaTransaction.update({
        where: { id: mpesaTx.id },
        data: {
          status: TransactionStatus.FAILED,
          resultCode: ResultCode,
          resultDesc: ResultDesc,
          callbackPayload: rawPayload,
        },
      });
      this.logger.log(
        `STK Push failed | checkout=${CheckoutRequestID} code=${ResultCode} desc=${ResultDesc}`,
      );
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

    this.logger.log(
      `STK Push processed | receipt=${receipt} amount=${amount.toFixed(2)} ` +
        `checkout=${CheckoutRequestID} phone=${maskPhone(mpesaTx.phoneNumber)}`,
    );
  }

  // ─── C2B result (direct paybill payment) ─────────────────────────────────

  private async handleC2bCallback(body: C2bCallbackPayload, jobId: string): Promise<void> {
    const { TransID, TransAmount, BillRefNumber, MSISDN, TransTime } = body;

    // Layer 3: reference is built at create time so a duplicate TransID simply
    // fails the @unique constraint — but we also check explicitly for a clean log.
    const existing = await this.prisma.mpesaTransaction.findFirst({
      where: { mpesaReceiptNumber: TransID },
    });
    if (existing) {
      this.logger.log(`C2B duplicate skipped: TransID=${TransID}`);
      return;
    }

    const amount = new Decimal(TransAmount);
    const rawPayload = body as unknown as Prisma.InputJsonValue;
    const reference = buildMpesaRef.c2b(TransID);

    // Use findMany so we detect cross-tenant account number collisions.
    // accountNumber is unique within a tenant (@@unique([tenantId, accountNumber]))
    // but NOT globally — a findFirst without tenantId would non-deterministically
    // credit whichever tenant's record the DB returns first.
    const accounts = await this.prisma.account.findMany({
      where: { accountNumber: BillRefNumber },
      select: { id: true, balance: true, memberId: true, tenantId: true },
    });

    if (accounts.length === 0) {
      this.logger.warn(
        `C2B: account not found for BillRefNumber=${BillRefNumber} TransID=${TransID}`,
      );
      await this.prisma.mpesaTransaction.create({
        data: {
          tenantId: 'UNRESOLVED',
          type: MpesaTxType.C2B,
          triggerSource: MpesaTriggerSource.MEMBER,
          phoneNumber: MSISDN,
          amount: amount.toDecimalPlaces(4).toString(),
          accountReference: BillRefNumber,
          mpesaReceiptNumber: TransID,
          reference,
          status: TransactionStatus.FAILED,
          resultCode: 9999,
          resultDesc: 'Account not found – requires manual reconciliation',
          callbackPayload: rawPayload,
          transactionDate: parseDarajaTimestamp(TransTime),
        },
      });
      return;
    }

    if (accounts.length > 1) {
      // Cross-tenant account number collision — cannot safely credit without
      // a per-tenant shortcode mapping. Flag for manual reconciliation.
      this.logger.error(
        `C2B TENANT COLLISION: BillRefNumber=${BillRefNumber} matches ${accounts.length} ` +
          `accounts across tenants [${accounts.map((a) => a.tenantId).join(', ')}] ` +
          `TransID=${TransID} — requires manual reconciliation`,
      );
      await this.prisma.mpesaTransaction.create({
        data: {
          tenantId: 'UNRESOLVED',
          type: MpesaTxType.C2B,
          triggerSource: MpesaTriggerSource.MEMBER,
          phoneNumber: MSISDN,
          amount: amount.toDecimalPlaces(4).toString(),
          accountReference: BillRefNumber,
          mpesaReceiptNumber: TransID,
          reference,
          status: TransactionStatus.FAILED,
          resultCode: 9998,
          resultDesc: 'Cross-tenant account collision – requires manual reconciliation',
          callbackPayload: rawPayload,
          transactionDate: parseDarajaTimestamp(TransTime),
        },
      });
      return;
    }

    const account = accounts[0];

    const mpesaTx = await this.prisma.mpesaTransaction.create({
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
  }

  // ─── B2C result ───────────────────────────────────────────────────────────

  private async handleB2cCallback(body: B2cCallbackPayload, jobId: string): Promise<void> {
    const { ConversationID, ResultCode, ResultDesc, TransactionID, ResultParameters } =
      body.Result;

    const mpesaTx = await this.prisma.mpesaTransaction.findFirst({
      where: { conversationId: ConversationID },
    });

    if (!mpesaTx) {
      this.logger.warn(
        `B2C callback: no MpesaTransaction for ConversationID=${ConversationID}`,
      );
      return;
    }

    // Layer 2 idempotency
    if (mpesaTx.status !== TransactionStatus.PENDING) {
      this.logger.log(
        `B2C callback duplicate skipped: ${ConversationID} → ${mpesaTx.status}`,
      );
      return;
    }

    const rawPayload = body as unknown as Prisma.InputJsonValue;

    if (ResultCode !== 0) {
      await this.prisma.mpesaTransaction.update({
        where: { id: mpesaTx.id },
        data: {
          status: TransactionStatus.FAILED,
          resultCode: ResultCode,
          resultDesc: ResultDesc,
          callbackPayload: rawPayload,
        },
      });
      this.logger.warn(
        `B2C failed | conversation=${ConversationID} code=${ResultCode} desc=${ResultDesc}`,
      );
      return;
    }

    const meta = parseB2cResultMeta(ResultParameters);
    const amount = new Decimal(mpesaTx.amount.toString());
    const receipt = meta.TransactionReceipt ?? TransactionID ?? uuidv4();

    if (!mpesaTx.loanId) {
      this.logger.error(
        `B2C ${ConversationID} has no loanId – cannot post ledger entry`,
      );
      return;
    }

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

    this.logger.log(
      `B2C disbursement processed | receipt=${receipt} amount=${amount.toFixed(2)} ` +
        `loan=${mpesaTx.loanId} phone=${maskPhone(mpesaTx.phoneNumber)}`,
    );
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

    await this.prisma.$transaction(async (tx) => {
      // Layer 3 idempotency: Transaction.reference @unique
      const dup = await tx.transaction.findUnique({ where: { reference } });
      if (dup) {
        this.logger.log(`Ledger: duplicate reference ${reference} – skipping`);
        return;
      }

      if (isLoanRepayment) {
        // ── Loan repayment path ──────────────────────────────────────────────
        const loan = await tx.loan.findFirst({
          where: { loanNumber: parsed.target, tenantId: params.tenantId },
          select: {
            id: true,
            totalRepaid: true,
            outstandingBalance: true,
            memberId: true,
          },
        });

        if (!loan) {
          this.logger.warn(
            `Ledger: loan "${parsed.target}" not found during callback`,
          );
          return;
        }

        const fosa = await tx.account.findFirst({
          where: {
            memberId: loan.memberId,
            tenantId: params.tenantId,
            accountType: 'FOSA',
            isActive: true,
          },
          select: { id: true, balance: true },
        });

        const totalRepaid = new Decimal(loan.totalRepaid.toString()).plus(params.amount);
        const outstanding = Decimal.max(
          new Decimal(loan.outstandingBalance.toString()).minus(params.amount),
          new Decimal(0),
        );
        const isFullyPaid = outstanding.isZero();

        const fosaId =
          fosa?.id ?? (await this.getFosaAccountId(tx, loan.memberId, params.tenantId));

        const ledgerTx = await tx.transaction.create({
          data: {
            tenantId: params.tenantId,
            accountId: fosaId,
            loanId: loan.id,
            type: TransactionType.LOAN_REPAYMENT,
            status: TransactionStatus.COMPLETED,
            amount: params.amount.toDecimalPlaces(4).toString(),
            balanceBefore: fosa
              ? new Decimal(fosa.balance.toString()).toDecimalPlaces(4).toString()
              : '0.0000',
            balanceAfter: fosa
              ? new Decimal(fosa.balance.toString())
                  .plus(params.amount)
                  .toDecimalPlaces(4)
                  .toString()
              : '0.0000',
            reference,
            description: `M-Pesa loan repayment – ${params.receipt}`,
            processedBy: 'MPESA_SYSTEM',
          },
        });

        await tx.loan.update({
          where: { id: loan.id },
          data: {
            totalRepaid: totalRepaid.toDecimalPlaces(4).toString(),
            outstandingBalance: outstanding.toDecimalPlaces(4).toString(),
            status: isFullyPaid ? LoanStatus.FULLY_PAID : undefined,
          },
        });

        if (fosa) {
          await tx.account.update({
            where: { id: fosa.id },
            data: {
              balance: new Decimal(fosa.balance.toString())
                .plus(params.amount)
                .toDecimalPlaces(4)
                .toString(),
            },
          });
        }

        if (params.mpesaTxId) {
          await tx.mpesaTransaction.update({
            where: { id: params.mpesaTxId },
            data: {
              transactionId: ledgerTx.id,
              loanId: loan.id,
              status: TransactionStatus.COMPLETED,
              resultCode: params.resultCode,
              resultDesc: params.resultDesc,
              mpesaReceiptNumber: params.receipt,
              transactionDate: params.transactionDate,
              callbackPayload: params.rawPayload,
            },
          });
        }
      } else {
        // ── Savings deposit path ──────────────────────────────────────────────
        const accountNumber = parsed.isMemberIdDeposit
          ? await this.resolveDefaultFosaByMember(parsed.target, params.tenantId)
          : parsed.target;

        const account = await tx.account.findFirst({
          where: { accountNumber, tenantId: params.tenantId, isActive: true },
          select: { id: true, balance: true },
        });

        if (!account) {
          this.logger.warn(
            `Ledger: account "${accountNumber}" not found – manual recon needed`,
          );
          return;
        }

        const balanceBefore = new Decimal(account.balance.toString());
        const balanceAfter = balanceBefore.plus(params.amount);

        const ledgerTx = await tx.transaction.create({
          data: {
            tenantId: params.tenantId,
            accountId: account.id,
            type: TransactionType.DEPOSIT,
            status: TransactionStatus.COMPLETED,
            amount: params.amount.toDecimalPlaces(4).toString(),
            balanceBefore: balanceBefore.toDecimalPlaces(4).toString(),
            balanceAfter: balanceAfter.toDecimalPlaces(4).toString(),
            reference,
            description: `M-Pesa deposit – ${params.receipt}`,
            processedBy: 'MPESA_SYSTEM',
          },
        });

        await tx.account.update({
          where: { id: account.id },
          data: { balance: balanceAfter.toDecimalPlaces(4).toString() },
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
      }
    });
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

    await this.prisma.$transaction(async (tx) => {
      const dup = await tx.transaction.findUnique({ where: { reference } });
      if (dup) return;

      const loan = await tx.loan.findUnique({
        where: { id: params.loanId },
        select: { id: true, memberId: true, status: true },
      });
      if (!loan) return;

      const fosa = await tx.account.findFirst({
        where: { memberId: loan.memberId, tenantId: params.tenantId, accountType: 'FOSA', isActive: true },
        select: { id: true, balance: true },
      });

      const fosaId = fosa?.id ?? (await this.getFosaAccountId(tx, loan.memberId, params.tenantId));
      const balanceBefore = new Decimal(fosa?.balance.toString() ?? '0');
      const balanceAfter = balanceBefore.plus(params.amount);

      const ledgerTx = await tx.transaction.create({
        data: {
          tenantId: params.tenantId,
          accountId: fosaId,
          loanId: params.loanId,
          type: TransactionType.LOAN_DISBURSEMENT,
          status: TransactionStatus.COMPLETED,
          amount: params.amount.toDecimalPlaces(4).toString(),
          balanceBefore: balanceBefore.toDecimalPlaces(4).toString(),
          balanceAfter: balanceAfter.toDecimalPlaces(4).toString(),
          reference,
          description: `M-Pesa B2C disbursement – ${params.receipt}`,
          processedBy: 'MPESA_SYSTEM',
        },
      });

      if (fosa) {
        await tx.account.update({
          where: { id: fosa.id },
          data: { balance: balanceAfter.toDecimalPlaces(4).toString() },
        });
      }

      if (loan.status === LoanStatus.APPROVED) {
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
    });
  }

  // ─── DLQ handler ─────────────────────────────────────────────────────────

  @OnWorkerEvent('failed')
  async onFailed(job: Job<MpesaCallbackJobPayload>): Promise<void> {
    if ((job.attemptsMade ?? 0) < (job.opts?.attempts ?? 3)) return;

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
      { removeOnFail: false, removeOnComplete: false },
    );
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async resolveDefaultFosaByMember(
    memberId: string,
    tenantId: string,
  ): Promise<string> {
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
      where: { memberId, tenantId, isActive: true },
      select: { id: true },
    });
    if (acc) return acc.id;
    throw new Error(`No active account for member ${memberId} in tenant ${tenantId}`);
  }
}
