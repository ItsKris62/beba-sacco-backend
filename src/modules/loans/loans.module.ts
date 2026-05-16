import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { AuditModule } from '../audit/audit.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { DisbursementGateService } from '../../loans/disbursement-gate.service';
import { ProductRuleService } from './product-rule.service';
import { RepaymentReminderService } from './repayment-reminder.service';
import { IntegrationsModule } from '../integrations/integrations.module';

@Module({
  imports: [
    AuditModule,
    IntegrationsModule,
    BullModule.registerQueue(
      { name: QUEUE_NAMES.LOAN_GUARANTOR_REMINDER },
      { name: QUEUE_NAMES.EMAIL },
    ),
  ],
  controllers: [LoansController],
  providers: [LoansService, PrismaService, RedisService, IdempotencyService, DisbursementGateService, ProductRuleService, RepaymentReminderService],
  exports: [LoansService, DisbursementGateService, ProductRuleService],
})
export class LoansModule {}
