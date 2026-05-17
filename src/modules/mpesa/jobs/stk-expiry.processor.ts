import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MpesaTxType, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { QUEUE_NAMES } from '../../queue/queue.constants';

@Processor(QUEUE_NAMES.MPESA_STK_EXPIRY, { concurrency: 1 })
export class StkExpiryProcessor extends WorkerHost {
  private readonly logger = new Logger(StkExpiryProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<Record<string, never>>): Promise<void> {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000);

    const result = await this.prisma.client.mpesaTransaction.updateMany({
      where: {
        status: TransactionStatus.PENDING,
        type: MpesaTxType.STK_PUSH,
        createdAt: { lt: cutoff },
      },
      data: {
        status: TransactionStatus.FAILED,
        failureReason: 'STK_TIMEOUT_SWEEP',
        resultDesc: 'STK push timed out without a Daraja callback',
      },
    });

    if (result.count > 0) {
      this.logger.log(
        `STK expiry sweep marked ${result.count} transaction(s) failed | job=${job.id}`,
      );
    }
  }
}
