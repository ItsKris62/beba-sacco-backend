import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LedgerService } from '../../accounting/ledger.service';
import { AuditService } from '../../audit/audit.service';
import { QUEUE_NAMES } from '../../queue/queue.constants';
import { maskPhone } from '../utils/mpesa.utils';

/**
 * Second-stage sweep for FOSA withdrawals that MpesaB2cTimeoutProcessor already
 * marked RECON_PENDING (30 minutes after B2C initiation with no Daraja callback)
 * and that are STILL unreconciled after an additional configurable grace period
 * (default 30 min — MPESA_WITHDRAWAL_RECON_GRACE_MINUTES).
 *
 * By this point a genuinely successful B2C payout would almost certainly have
 * posted its callback, so we auto-refund the member's FOSA balance via the same
 * LedgerService.reverseTransaction() path a real Safaricom-reported failure uses
 * (see MpesaCallbackProcessor.handleB2cCallback).
 *
 * Race safety: every row transition here is a conditional `updateMany` guarded on
 * the row still being RECON_PENDING, mirroring the same guard MpesaCallbackProcessor
 * now uses. Whichever of {this sweep, a late-arriving callback} acts on a row second
 * simply no-ops (count 0) instead of double-processing it. A callback that lands
 * AFTER this sweep has already refunded is not preventable by the guard — that case
 * is logged as a CRITICAL double-credit in handleB2cCallback for manual recovery.
 *
 * Rows without a linked ledger Transaction (legacy referenceId-only MpesaTransaction
 * rows — see MpesaService.executeB2cDisbursement's `sourceTransactionId` comment)
 * cannot be safely reversed via LedgerService and are flagged for manual review
 * instead of guessed at.
 */
@Processor(QUEUE_NAMES.MPESA_WITHDRAWAL_RECON, { concurrency: 1 })
export class WithdrawalReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(WithdrawalReconciliationProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<Record<string, never>>): Promise<void> {
    const graceMinutes = this.config.get<number>('app.mpesa.withdrawalReconGraceMinutes', 30);
    const cutoff = new Date(Date.now() - graceMinutes * 60 * 1000);

    const stuck = await this.prisma.direct.mpesaTransaction.findMany({
      where: {
        referenceType: 'FOSA_WITHDRAWAL',
        status: TransactionStatus.RECON_PENDING,
        updatedAt: { lt: cutoff },
      },
      select: {
        id: true,
        tenantId: true,
        transactionId: true,
        amount: true,
        phoneNumber: true,
        conversationId: true,
      },
    });

    if (stuck.length === 0) return;

    let refunded = 0;
    let manualReview = 0;
    let failed = 0;

    for (const row of stuck) {
      if (!row.transactionId) {
        manualReview++;
        this.logger.error(
          `CRITICAL: FOSA withdrawal stuck RECON_PENDING with no linked ledger transaction — ` +
            `requires manual reconciliation | mpesaTransactionId=${row.id} tenant=${row.tenantId} ` +
            `amount=${row.amount.toString()} phone=${maskPhone(row.phoneNumber)}`,
        );
        await this.audit
          .create({
            tenantId: row.tenantId,
            actorId: 'SYSTEM',
            action: 'MPESA.WITHDRAWAL.RECON_MANUAL_REVIEW_REQUIRED',
            entityType: 'MpesaTransaction',
            entityId: row.id,
            newValue: { status: 'RECON_PENDING', reason: 'NO_LINKED_LEDGER_TRANSACTION' },
            metadata: { amount: row.amount.toString(), phone: maskPhone(row.phoneNumber) },
          })
          .catch((e: unknown) =>
            this.logger.warn(`Audit emit failed: ${e instanceof Error ? e.message : String(e)}`),
          );
        continue;
      }

      try {
        const claimed = await this.prisma.direct.$transaction(
          async (tx) => {
            const claim = await tx.mpesaTransaction.updateMany({
              where: { id: row.id, status: TransactionStatus.RECON_PENDING },
              data: {
                status: TransactionStatus.FAILED,
                failureReason: 'RECONCILIATION_TIMEOUT_AUTO_REFUNDED',
                resultDesc: `Auto-refunded after ${graceMinutes}m in RECON_PENDING with no Daraja callback`,
              },
            });
            if (claim.count === 0) return false;

            await this.ledger.reverseTransaction({
              tenantId: row.tenantId,
              originalTransactionId: row.transactionId!,
              reason: `B2C withdrawal auto-reconciled: no Daraja callback within ${graceMinutes}m of RECON_PENDING`,
              tx,
            });

            await this.audit.createAtomic(tx, {
              tenantId: row.tenantId,
              actorId: 'SYSTEM',
              action: 'MPESA.WITHDRAWAL.RECONCILIATION_AUTO_REFUND',
              entityType: 'MpesaTransaction',
              entityId: row.id,
              newValue: { status: 'FAILED', refundedAmount: row.amount.toString() },
              metadata: {
                conversationId: row.conversationId,
                phone: maskPhone(row.phoneNumber),
                graceMinutes,
              },
            });
            return true;
          },
          { isolationLevel: 'Serializable' },
        );

        if (claimed) {
          refunded++;
          this.logger.warn(
            `Auto-refunded stuck FOSA withdrawal | mpesaTransactionId=${row.id} tenant=${row.tenantId} ` +
              `amount=${row.amount.toString()}`,
          );
        }
        // claimed === false: a callback (or a previous sweep run) already claimed this
        // row between the SELECT above and this transaction — normal race resolution.
      } catch (error) {
        failed++;
        this.logger.error(
          `CRITICAL: withdrawal auto-refund failed — requires manual reconciliation | ` +
            `mpesaTransactionId=${row.id} tenant=${row.tenantId}`,
          error instanceof Error ? error.stack : String(error),
        );
        // The Serializable transaction above rolled back on this error, so the row is
        // still RECON_PENDING and will be retried by the next sweep automatically — this
        // audit entry exists purely for admin visibility in the meantime, not as the
        // only record of the failure.
        await this.audit
          .create({
            tenantId: row.tenantId,
            actorId: 'SYSTEM',
            action: 'MPESA.WITHDRAWAL.RECONCILIATION_AUTO_REFUND_FAILED',
            entityType: 'MpesaTransaction',
            entityId: row.id,
            newValue: { error: error instanceof Error ? error.message : String(error) },
            metadata: { amount: row.amount.toString(), phone: maskPhone(row.phoneNumber) },
          })
          .catch((e: unknown) =>
            this.logger.warn(`Audit emit failed: ${e instanceof Error ? e.message : String(e)}`),
          );
        // Never rethrow here — one bad row must not abort the sweep for the rest of the batch.
      }
    }

    this.logger.log(
      `Withdrawal reconciliation sweep | job=${job.id} candidates=${stuck.length} ` +
        `refunded=${refunded} manualReview=${manualReview} failed=${failed}`,
    );
  }
}
