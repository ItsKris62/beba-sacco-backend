import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LoanApplicationService } from './loan-application.service';
import { LoanAdminController } from './loan-admin.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { AuditModule } from '../audit/audit.module';
import { QUEUE_NAMES } from '../queue/queue.constants';

/**
 * Loan Application & Guarantor Workflow Module (MVP)
 *
 * Encapsulates the complete loan application lifecycle:
 * - Member self-service application with eligibility checks
 * - Guarantor invitation and explicit consent
 * - Admin oversight (status changes, exposure checks)
 * - Domain event publishing to BullMQ
 */
@Module({
  imports: [
    AuditModule,
    BullModule.registerQueue(
      { name: QUEUE_NAMES.LOAN_GUARANTOR_REMINDER },
      { name: QUEUE_NAMES.EMAIL },
      { name: QUEUE_NAMES.AUDIT_LOG },
    ),
  ],
  controllers: [LoanAdminController],
  providers: [LoanApplicationService, PrismaService, RedisService, IdempotencyService],
  exports: [LoanApplicationService],
})
export class LoanApplicationModule {}
