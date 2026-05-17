import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { LoanStatus, Prisma, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { QUEUE_NAMES, MpesaB2cTimeoutJobPayload } from '../../queue/queue.constants';

@Processor(QUEUE_NAMES.MPESA_B2C_TIMEOUT, { concurrency: 2 })
export class MpesaB2cTimeoutProcessor extends WorkerHost {
  private readonly logger = new Logger(MpesaB2cTimeoutProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<MpesaB2cTimeoutJobPayload>): Promise<void> {
    const { loanId, tenantId, conversationId } = job.data;

    const result = await this.prisma.directClient.$transaction(
      async (tx) => {
        const mpesaTx = await tx.mpesaTransaction.findFirst({
          where: {
            tenantId,
            conversationId,
            loanId,
            status: TransactionStatus.PENDING,
          },
          select: { id: true, status: true },
        });

        if (!mpesaTx) {
          return { changed: false, reason: 'transaction_already_reconciled' };
        }

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
            data: {
              status: LoanStatus.APPROVED,
              disbursementFailureReason: 'B2C_TIMEOUT',
            },
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
      },
      { isolationLevel: 'Serializable' as const },
    );

    if (result.changed) {
      this.logger.error(
        `B2C timeout marked for reconciliation | loan=${loanId} conversation=${conversationId} job=${job.id}`,
      );
      return;
    }

    this.logger.debug(
      `B2C timeout skipped | loan=${loanId} conversation=${conversationId} reason=${result.reason}`,
    );
  }
}
