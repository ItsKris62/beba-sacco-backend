import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QUEUE_NAMES } from './queue.constants';

// Processors
import { MpesaCallbackProcessor } from './processors/mpesa-callback.processor';
import { GuarantorReminderProcessor } from './processors/guarantor-reminder.processor';
import { AuditLogProcessor } from './processors/audit-log.processor';
import { LoanDisburseProcessor } from './processors/loan-disburse.processor';
import { EmailProcessor } from './processors/email.processor';
// Phase 4 processors
import { InterestAccrualProcessor } from './processors/interest-accrual.processor';
import { MpesaReconciliationProcessor } from './processors/mpesa-reconciliation.processor';
import { LedgerIntegrityProcessor } from './processors/ledger-integrity.processor';
import { RepaymentScheduleProcessor } from './processors/repayment-schedule.processor';
import { OutboundWebhookProcessor } from './processors/outbound-webhook.processor';
// Phase 5 processors – registered in IntegrationsModule which owns their queues
// import { CrbExportProcessor } from './processors/crb-export.processor';
// import { AmlScreenProcessor } from './processors/aml-screen.processor';
// import { MultiChannelNotifyProcessor } from './processors/multi-channel-notify.processor';

// Service dependencies needed by processors
import { MpesaModule } from '../mpesa/mpesa.module';
import { LoansModule } from '../loans/loans.module';
import { AuditModule } from '../audit/audit.module';
import { PlunkService } from '../../common/services/plunk.service';
import { FinancialModule } from '../financial/financial.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

/**
 * Queue Module – BullMQ + Upstash Redis
 *
 * Queues:
 *  - mpesa.callback          – Process Daraja STK callback payloads
 *  - loan.guarantor.reminder – Send guarantor nudge SMS/email
 *  - audit.log               – Async audit log writes (fire-and-forget)
 *  - loan.disburse           – Scheduled loan disbursement
 *  - email                   – Transactional email (Phase 3)
 *
 * Default job options:
 *  - removeOnComplete: 1000 (keep last 1000 for debugging)
 *  - removeOnFail: false    (keep all failures for inspection)
 *  - attempts: 3, exponential backoff from 2 s
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('app.redis.host'),
          port: configService.get<number>('app.redis.port'),
          password: configService.get<string>('app.redis.password'),
          tls: configService.get<boolean>('app.redis.tls') ? {} : undefined,
        },
        defaultJobOptions: {
          removeOnComplete: 1000,
          removeOnFail: false,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.MPESA_CALLBACK },
      { name: QUEUE_NAMES.LOAN_GUARANTOR_REMINDER },
      { name: QUEUE_NAMES.AUDIT_LOG },
      { name: QUEUE_NAMES.LOAN_DISBURSE },
      { name: QUEUE_NAMES.EMAIL },
      // Phase 4
      { name: QUEUE_NAMES.INTEREST_ACCRUAL },
      { name: QUEUE_NAMES.REPAYMENT_SCHEDULE },
      { name: QUEUE_NAMES.MPESA_RECONCILIATION },
      { name: QUEUE_NAMES.LEDGER_INTEGRITY },
      { name: QUEUE_NAMES.OUTBOUND_WEBHOOK },
    ),
    MpesaModule,
    LoansModule,
    AuditModule,
    FinancialModule,
    WebhooksModule,
  ],
  providers: [
    // PlunkService is @Global but QueueModule is loaded before CommonServicesModule
    // resolves globally for processors — re-provide here to be explicit.
    PlunkService,
    MpesaCallbackProcessor,
    GuarantorReminderProcessor,
    AuditLogProcessor,
    LoanDisburseProcessor,
    EmailProcessor,
    // Phase 4
    InterestAccrualProcessor,
    MpesaReconciliationProcessor,
    LedgerIntegrityProcessor,
    RepaymentScheduleProcessor,
    OutboundWebhookProcessor,
  ],
  exports: [BullModule],
})
export class QueueModule {}
