import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { KycReviewProcessor } from './kyc-review.processor';
import { AuditModule } from '../audit/audit.module';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_NAMES } from '../queue/queue.constants';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUE_NAMES.KYC_REVIEW },
      { name: QUEUE_NAMES.KYC_REVIEW_DLQ },
      { name: QUEUE_NAMES.EMAIL },
    ),
    AuditModule,
  ],
  providers: [KycReviewProcessor, PrismaService],
})
export class KycModule {}
