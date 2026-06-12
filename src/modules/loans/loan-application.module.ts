import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LoanApplicationService } from './loan-application.service';
import { LoanAdminService } from './loan-admin.service';
import { LoanReviewService } from './loan-review.service';
import { GuarantorValidationService } from './guarantor-validation.service';
import { LoanRecoveryService } from './loan-recovery.service';
import { GuarantorResponseService } from '../../loans/guarantor-response.service';
import { GuarantorResponseController } from '../../loans/guarantor-response.controller';
import { LoanAdminController } from './loan-admin.controller';
import { LoansModule } from './loans.module';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { AuditModule } from '../audit/audit.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { ProductRuleService } from './product-rule.service';
import { LoanStateTransitionGuard } from './guards/loan-state-transition.guard';
import { SmsModule } from '../sms/sms.module';

/**
 * Loan Application & LoanGuarantor Workflow Module (MVP)
 *
 * Encapsulates the complete loan application lifecycle:
 * - Member self-service application with eligibility checks
 * - LoanGuarantor invitation and explicit consent
 * - Admin oversight (status changes, exposure checks)
 * - Domain event publishing to BullMQ
 *
 * LoansModule is imported to expose LoansService to LoanAdminController so that
 * PATCH /admin/loans/:id/status with DISBURSED routes through the real financial
 * disbursement pipeline instead of a status-only update.
 * No circular dependency: LoansModule does not import LoanApplicationModule.
 */
@Module({
  imports: [
    AuditModule,
    LoansModule,
    SmsModule,
    BullModule.registerQueue(
      { name: QUEUE_NAMES.LOAN_GUARANTOR_REMINDER },
      { name: QUEUE_NAMES.LOAN_GUARANTOR_EXPIRY },
      { name: QUEUE_NAMES.GUARANTOR_VALIDATION },
      { name: QUEUE_NAMES.EMAIL },
      { name: QUEUE_NAMES.AUDIT_LOG },
    ),
  ],
  controllers: [LoanAdminController, GuarantorResponseController],
  providers: [
    LoanApplicationService,
    LoanAdminService,
    LoanReviewService,
    GuarantorResponseService,
    GuarantorValidationService,
    LoanRecoveryService,
    ProductRuleService,
    LoanStateTransitionGuard,
    PrismaService,
    RedisService,
    IdempotencyService,
  ],
  exports: [LoanApplicationService, GuarantorResponseService, GuarantorValidationService, LoanRecoveryService, ProductRuleService],
})
export class LoanApplicationModule {}
