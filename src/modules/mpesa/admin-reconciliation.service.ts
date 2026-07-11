import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { JournalEntryType, TransactionStatus } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerService } from '../accounting/ledger.service';
import { AuditService } from '../audit/audit.service';
import { MpesaService } from './mpesa.service';
import { maskPhone } from './utils/mpesa.utils';
import { ReconciliationRecoverDto, ReconciliationRecoveryAction } from './dto/reconciliation-recover.dto';

const LATE_SUCCESS_ACTION = 'MPESA.WITHDRAWAL.LATE_SUCCESS_AFTER_AUTO_REFUND';
const RECOVERED_ACTION = 'MPESA.WITHDRAWAL.MANUALLY_RECOVERED';
const AUTO_REFUND_FAILURE_REASON = 'RECONCILIATION_TIMEOUT_AUTO_REFUNDED';

export interface PendingReconciliationCase {
  mpesaTransactionId: string;
  caseType: 'STUCK_RECON_PENDING' | 'LATE_SUCCESS_DOUBLE_CREDIT';
  amount: number;
  phoneNumber: string;
  status: TransactionStatus;
  hasLinkedLedgerTransaction: boolean;
  occurredAt: Date;
}

/**
 * Admin-facing recovery workflow for the two M-Pesa withdrawal edge cases that
 * WithdrawalReconciliationProcessor and MpesaCallbackProcessor's handleB2cCallback
 * cannot safely resolve automatically:
 *
 *  - STUCK_RECON_PENDING: MpesaTransaction rows still sitting in RECON_PENDING —
 *    either a legacy row with no linked ledger Transaction (never auto-refundable),
 *    or one whose auto-refund attempt keeps failing and rolling back.
 *  - LATE_SUCCESS_DOUBLE_CREDIT: a Daraja success callback arrived AFTER the sweep
 *    already auto-refunded the same withdrawal — the member may have been paid by
 *    Safaricom AND had their FOSA balance credited back. Logged as a CRITICAL audit
 *    event (MPESA.WITHDRAWAL.LATE_SUCCESS_AFTER_AUTO_REFUND) with no automatic fix,
 *    since only a human confirming with Safaricom can tell which side is correct.
 *
 * There is no TransactionStatus.MANUAL_REVIEW / RECOVERED_MANUALLY in the schema —
 * "resolved" is tracked via a MPESA.WITHDRAWAL.MANUALLY_RECOVERED audit entry against
 * the same entityId, consistent with AuditLog being the append-only source of truth
 * elsewhere in this codebase (AuditLog rows are never updated).
 */
@Injectable()
export class AdminReconciliationService {
  private readonly logger = new Logger(AdminReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly mpesaService: MpesaService,
  ) {}

  // ─── LIST PENDING ─────────────────────────────────────────────────────────

  async listPending(
    tenantId: string,
    opts: { limit?: number; offset?: number; fromDate?: Date; toDate?: Date } = {},
  ): Promise<{ data: PendingReconciliationCase[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(100, Math.max(1, Number(opts.limit ?? 20)));
    const offset = Math.max(0, Number(opts.offset ?? 0));
    const dateFilter =
      opts.fromDate || opts.toDate
        ? { ...(opts.fromDate && { gte: opts.fromDate }), ...(opts.toDate && { lte: opts.toDate }) }
        : undefined;

    const stuckRows = await this.prisma.mpesaTransaction.findMany({
      where: {
        tenantId,
        referenceType: 'FOSA_WITHDRAWAL',
        status: TransactionStatus.RECON_PENDING,
        ...(dateFilter && { updatedAt: dateFilter }),
      },
      select: { id: true, amount: true, phoneNumber: true, status: true, transactionId: true, updatedAt: true },
      orderBy: { updatedAt: 'asc' },
    });

    const lateSuccessLogs = await this.prisma.auditLog.findMany({
      where: {
        tenantId,
        entityType: 'MpesaTransaction',
        action: LATE_SUCCESS_ACTION,
        ...(dateFilter && { timestamp: dateFilter }),
      },
      select: { entityId: true, timestamp: true, newValue: true },
      orderBy: { timestamp: 'asc' },
    });

    const candidateIds = [...new Set(lateSuccessLogs.map((log) => log.entityId).filter((id): id is string => !!id))];
    const resolvedLogs = candidateIds.length
      ? await this.prisma.auditLog.findMany({
          where: { tenantId, entityType: 'MpesaTransaction', action: RECOVERED_ACTION, entityId: { in: candidateIds } },
          select: { entityId: true },
        })
      : [];
    const resolvedIds = new Set(resolvedLogs.map((log) => log.entityId));

    const unresolvedLateSuccessIds = [...new Set(
      lateSuccessLogs
        .filter((log) => log.entityId && !resolvedIds.has(log.entityId))
        .map((log) => log.entityId as string),
    )];

    const lateSuccessRows = unresolvedLateSuccessIds.length
      ? await this.prisma.mpesaTransaction.findMany({
          where: { id: { in: unresolvedLateSuccessIds }, tenantId },
          select: { id: true, amount: true, phoneNumber: true, status: true, transactionId: true, updatedAt: true },
        })
      : [];

    const cases: PendingReconciliationCase[] = [
      ...stuckRows.map((row) => ({
        mpesaTransactionId: row.id,
        caseType: 'STUCK_RECON_PENDING' as const,
        amount: new Decimal(row.amount.toString()).toNumber(),
        phoneNumber: maskPhone(row.phoneNumber),
        status: row.status,
        hasLinkedLedgerTransaction: !!row.transactionId,
        occurredAt: row.updatedAt,
      })),
      ...lateSuccessRows.map((row) => ({
        mpesaTransactionId: row.id,
        caseType: 'LATE_SUCCESS_DOUBLE_CREDIT' as const,
        amount: new Decimal(row.amount.toString()).toNumber(),
        phoneNumber: maskPhone(row.phoneNumber),
        status: row.status,
        hasLinkedLedgerTransaction: !!row.transactionId,
        occurredAt: row.updatedAt,
      })),
    ].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

    return {
      data: cases.slice(offset, offset + limit),
      total: cases.length,
      limit,
      offset,
    };
  }

  // ─── EXECUTE RECOVERY ─────────────────────────────────────────────────────

  async recover(
    mpesaTransactionId: string,
    dto: ReconciliationRecoverDto,
    tenantId: string,
    actorId: string,
    ipAddress?: string,
  ) {
    const mpesaTx = await this.prisma.mpesaTransaction.findFirst({
      where: { id: mpesaTransactionId, tenantId, referenceType: 'FOSA_WITHDRAWAL' },
    });
    if (!mpesaTx) throw new NotFoundException('M-Pesa withdrawal transaction not found');

    if (dto.action === ReconciliationRecoveryAction.REVERSE_AUTO_REFUND) {
      return this.reverseAutoRefund(mpesaTx, tenantId, actorId, dto.notes, ipAddress);
    }
    return this.manualB2cPayout(mpesaTx, tenantId, actorId, dto.notes, ipAddress);
  }

  private async reverseAutoRefund(
    mpesaTx: { id: string; status: TransactionStatus; failureReason: string | null; transactionId: string | null },
    tenantId: string,
    actorId: string,
    notes: string,
    ipAddress?: string,
  ) {
    if (mpesaTx.status !== TransactionStatus.FAILED || mpesaTx.failureReason !== AUTO_REFUND_FAILURE_REASON) {
      throw new BadRequestException(
        'REVERSE_AUTO_REFUND is only valid for withdrawals the system previously auto-refunded ' +
          '(status FAILED with failureReason RECONCILIATION_TIMEOUT_AUTO_REFUNDED)',
      );
    }
    if (!mpesaTx.transactionId) {
      throw new BadRequestException('No linked ledger transaction — cannot locate the auto-refund to reverse');
    }

    return this.prisma.$transaction(
      async (tx) => {
        const original = await tx.transaction.findFirst({ where: { id: mpesaTx.transactionId!, tenantId } });
        if (!original) throw new NotFoundException('Original withdrawal ledger transaction not found');

        const reversal = await tx.transaction.findFirst({
          where: { tenantId, reference: `${original.reference}-REVERSAL` },
        });
        if (!reversal) {
          throw new ConflictException(
            'Auto-refund reversal transaction not found for this withdrawal — ledger may be inconsistent',
          );
        }

        const { transaction: reReversal } = await this.ledger.reverseTransaction({
          tenantId,
          originalTransactionId: reversal.id,
          reason: `Manual recovery — auto-refund reversed by admin: ${notes}`,
          reversedByUserId: actorId,
          tx,
        });

        await this.audit.createAtomic(tx, {
          tenantId,
          actorId,
          action: RECOVERED_ACTION,
          entityType: 'MpesaTransaction',
          entityId: mpesaTx.id,
          newValue: { recoveryAction: 'REVERSE_AUTO_REFUND', reReversalTransactionId: reReversal.id },
          metadata: { notes, ipAddress },
        });

        return {
          mpesaTransactionId: mpesaTx.id,
          action: 'REVERSE_AUTO_REFUND' as const,
          reReversalTransactionId: reReversal.id,
        };
      },
      { isolationLevel: 'Serializable' },
    );
  }

  private async manualB2cPayout(
    mpesaTx: {
      id: string;
      memberId: string | null;
      status: TransactionStatus;
      failureReason: string | null;
      transactionId: string | null;
      amount: { toString(): string };
      phoneNumber: string;
    },
    tenantId: string,
    actorId: string,
    notes: string,
    ipAddress?: string,
  ) {
    if (mpesaTx.status === TransactionStatus.COMPLETED) {
      throw new BadRequestException(
        'This withdrawal already completed successfully — a manual payout would double-pay the member',
      );
    }
    if (!mpesaTx.memberId) {
      throw new BadRequestException('No member linked to this M-Pesa transaction — cannot resolve a FOSA account');
    }

    const fosaAccount = await this.prisma.account.findFirst({
      where: { memberId: mpesaTx.memberId, tenantId, accountType: 'FOSA', isActive: true },
      select: { id: true },
    });
    if (!fosaAccount) throw new NotFoundException('No active FOSA account found for this member');

    const amount = new Decimal(mpesaTx.amount.toString());
    const wasAutoRefunded =
      mpesaTx.status === TransactionStatus.FAILED && mpesaTx.failureReason === AUTO_REFUND_FAILURE_REASON;

    let sourceTransactionId = mpesaTx.transactionId ?? undefined;

    if (wasAutoRefunded) {
      // The member's FOSA balance was already credited back by the auto-refund — they
      // currently hold the funds. A fresh debit is required before paying out via M-Pesa,
      // otherwise they'd keep the FOSA credit AND receive the M-Pesa payout.
      const debit = await this.prisma.$transaction(
        async (tx) => {
          const account = await tx.account.findFirst({
            where: { id: fosaAccount.id, tenantId },
            select: { balance: true, lockedBalance: true, frozenSavings: true },
          });
          if (!account) throw new NotFoundException('FOSA account no longer found');
          const available = new Decimal(account.balance.toString()).minus(
            new Decimal(account.lockedBalance.toString()).plus(new Decimal(account.frozenSavings.toString())),
          );
          if (available.lessThan(amount)) {
            throw new BadRequestException('Insufficient FOSA available balance for manual recovery re-debit');
          }

          const { transaction } = await this.ledger.postEntry({
            tenantId,
            reference: `MANUAL_RECOVERY-${mpesaTx.id}-${actorId}`,
            journalType: JournalEntryType.WITHDRAWAL,
            accountId: fosaAccount.id,
            amount,
            direction: 'DEBIT',
            actorId,
            description: `Manual recovery re-debit for withdrawal ${mpesaTx.id}`,
            tx,
          });

          await this.audit.createAtomic(tx, {
            tenantId,
            actorId,
            action: 'MPESA.WITHDRAWAL.MANUAL_RECOVERY_REDEBIT',
            entityType: 'MpesaTransaction',
            entityId: mpesaTx.id,
            newValue: { transactionId: transaction.id, amount: amount.toString() },
            metadata: { notes, ipAddress },
          });

          return transaction;
        },
        { isolationLevel: 'Serializable' },
      );
      sourceTransactionId = debit.id;
    }

    const { conversationId, mpesaTxId } = await this.mpesaService.executeB2cDisbursement(
      fosaAccount.id,
      'FOSA_WITHDRAWAL',
      tenantId,
      mpesaTx.phoneNumber,
      amount.toNumber(),
      actorId,
      sourceTransactionId,
    );

    await this.audit
      .create({
        tenantId,
        actorId,
        action: RECOVERED_ACTION,
        entityType: 'MpesaTransaction',
        entityId: mpesaTx.id,
        newValue: { recoveryAction: 'MANUAL_B2C_PAYOUT', newMpesaTransactionId: mpesaTxId, conversationId },
        metadata: { notes, ipAddress },
      })
      .catch((e: unknown) => this.logger.warn(`Audit emit failed: ${e instanceof Error ? e.message : String(e)}`));

    return {
      mpesaTransactionId: mpesaTx.id,
      action: 'MANUAL_B2C_PAYOUT' as const,
      newMpesaTransactionId: mpesaTxId,
      conversationId,
    };
  }
}
