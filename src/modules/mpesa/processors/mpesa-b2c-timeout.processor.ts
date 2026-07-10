import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { LoanStatus, Prisma, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { QUEUE_NAMES, MpesaB2cTimeoutJobPayload } from '../../queue/queue.constants';

/**
 * Fires 30 minutes after a B2C call is initiated (see MpesaService.executeB2cDisbursement).
 * If Safaricom's result callback never arrived, marks the MpesaTransaction
 * RECON_PENDING for manual follow-up instead of leaving it PENDING forever.
 *
 * Must match on `referenceId`/`referenceType` (what MpesaTransaction actually stores
 * for every B2C row — see executeB2cDisbursement()'s create()), not `loanId`. A prior
 * version of this job queried by `loanId`, which is only ever set for the disabled
 * LOAN_DISBURSEMENT B2C path — for FOSA_WITHDRAWAL rows `loanId` is always null, so
 * every withdrawal timeout job silently no-opped ("transaction_already_reconciled")
 * without ever finding the stuck PENDING row.
 */
@Processor(QUEUE_NAMES.MPESA_B2C_TIMEOUT, { concurrency: 2 })
export class MpesaB2cTimeoutProcessor extends WorkerHost {
  private readonly logger = new Logger(MpesaB2cTimeoutProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<MpesaB2cTimeoutJobPayload>): Promise<void> {
    const { referenceId, referenceType, tenantId, conversationId } = job.data;

    const result = await this.prisma.directClient.$transaction(
      async (tx) => {
        const mpesaTx = await tx.mpesaTransaction.findFirst({
          where: {
            tenantId,
            conversationId,
            referenceId,
            referenceType,
            status: TransactionStatus.PENDING,
          },
          select: { id: true, status: true, loanId: true },
        });

        if (!mpesaTx) {
          return { changed: false, reason: 'transaction_already_reconciled' };
        }

        if (referenceType === 'LOAN_DISBURSEMENT') {
          // Legacy path — direct B2C loan disbursement is architecturally disabled
          // (MpesaService.executeB2cDisbursement() throws for LOAN_DISBURSEMENT), so
          // this branch only matters for any row queued before that change shipped.
          const loanId = mpesaTx.loanId ?? referenceId;
          const loan = await tx.loan.findFirst({
            where: { id: loanId, tenantId },
            select: { id: true, tenantId: true, status: true },
          });

          if (!loan) {
            return { changed: false, reason: 'loan_not_found' };
          }

          if (loan.status === LoanStatus.DISBURSED) {
            await tx.loan.update({
              where: { id: loanId },
              data: { status: LoanStatus.APPROVED, disbursementFailureReason: 'B2C_TIMEOUT' },
            });
          } else if (loan.status === LoanStatus.APPROVED) {
            await tx.loan.update({
              where: { id: loanId },
              data: { disbursementFailureReason: 'B2C_TIMEOUT' },
            });
          } else {
            return { changed: false, reason: `loan_status_${loan.status}` };
          }

          await tx.mpesaTransaction.update({
            where: { id: mpesaTx.id },
            data: {
              status: TransactionStatus.RECON_PENDING,
              failureReason: 'B2C_TIMEOUT',
              resultDesc: 'B2C callback not received before timeout window',
            },
          });

          await tx.auditLog.create({
            data: {
              tenantId,
              actorId: null,
              action: 'B2C_TIMEOUT_REVERT',
              entityType: 'Loan',
              entityId: loanId,
              oldValue: { status: loan.status },
              newValue: {
                status: loan.status === LoanStatus.DISBURSED ? LoanStatus.APPROVED : loan.status,
                disbursementFailureReason: 'B2C_TIMEOUT',
              },
              metadata: {
                conversationId,
                mpesaTransactionId: mpesaTx.id,
                jobId: job.id,
                revertedAt: new Date().toISOString(),
              } satisfies Prisma.InputJsonObject,
            },
          });

          return { changed: true, reason: 'timeout_marked_for_reconciliation' };
        }

        // FOSA_WITHDRAWAL: the FOSA balance was already debited (via LedgerService)
        // when the withdrawal was initiated. Mark for manual reconciliation rather
        // than auto-reversing — Safaricom may still complete the payout after this
        // 30-minute window closes, and reversing here could race a late success
        // callback into crediting the member twice. An operator can reverse via
        // LedgerService.reverseTransaction() (using MpesaTransaction.transactionId)
        // once they've confirmed with Safaricom the payout genuinely failed.
        await tx.mpesaTransaction.update({
          where: { id: mpesaTx.id },
          data: {
            status: TransactionStatus.RECON_PENDING,
            failureReason: 'B2C_TIMEOUT',
            resultDesc: 'B2C callback not received before timeout window',
          },
        });

        await tx.auditLog.create({
          data: {
            tenantId,
            actorId: null,
            action: 'B2C_TIMEOUT_REVERT',
            entityType: 'MpesaTransaction',
            entityId: mpesaTx.id,
            oldValue: { status: TransactionStatus.PENDING },
            newValue: { status: TransactionStatus.RECON_PENDING, failureReason: 'B2C_TIMEOUT' },
            metadata: {
              conversationId,
              referenceId,
              referenceType,
              jobId: job.id,
              revertedAt: new Date().toISOString(),
            } satisfies Prisma.InputJsonObject,
          },
        });

        return { changed: true, reason: 'timeout_marked_for_reconciliation' };
      },
      { isolationLevel: 'Serializable' as const },
    );

    if (result.changed) {
      this.logger.error(
        `B2C timeout marked for reconciliation | refType=${referenceType} refId=${referenceId} conversation=${conversationId} job=${job.id}`,
      );
      return;
    }

    this.logger.debug(
      `B2C timeout skipped | refType=${referenceType} refId=${referenceId} conversation=${conversationId} reason=${result.reason}`,
    );
  }
}
