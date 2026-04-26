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
// Sprint 4 – cron-scheduled STK repayment
import { MpesaRepaymentScheduler } from './processors/mpesa-repayment.scheduler';
import { MpesaRepaymentProcessor } from './processors/mpesa-repayment.processor';

// Service dependencies needed by processors
import { MpesaModule } from '../mpesa/mpesa.module';
import { LoansModule } from '../loans/loans.module';
import { AuditModule } from '../audit/audit.module';
import { PlunkService } from '../../common/services/plunk.service';
import { FinancialModule } from '../financial/financial.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

/**
 * Queue Module – BullMQ + Redis
 *
 * When Redis is unavailable (local dev without Redis), BullMQ will retry
 * up to 3 times then stop — the app continues in degraded mode without queues.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const password = configService.get<string>('app.redis.password');
        const tls = configService.get<boolean>('app.redis.tls');
        // Strip any accidental protocol prefix (ioredis expects a bare hostname)
        const rawHost = configService.get<string>('app.redis.host', 'localhost');
        const host = rawHost.replace(/^https?:\/\//, '');
        let bullGaveUp = false;

        return {
          connection: {
            host,
            port: configService.get<number>('app.redis.port'),
            password: password || undefined,
            // Upstash requires TLS; local dev uses plain TCP
            tls: tls ? { rejectUnauthorized: false } : undefined,
            // Required by BullMQ — do not set a per-request retry limit
            maxRetriesPerRequest: null,
            // Auto-pipeline batches concurrent BullMQ commands into fewer round-trips
            enableAutoPipelining: true,
            connectTimeout: 5000,
            keepAlive: 10000,
            // Stop retrying after 3 attempts to avoid infinite ECONNREFUSED spam
            retryStrategy: (times: number) => {
              if (times > 3) {
                if (!bullGaveUp) {
                  bullGaveUp = true;
                  console.warn('[BullMQ] Redis unavailable — queue workers disabled (degraded mode)');
                }
                return null;
              }
              return Math.min(times * 1000, 5000);
            },
            // Only reconnect on READONLY (Upstash failover), not ECONNREFUSED
            reconnectOnError: (err: Error) => err.message.includes('READONLY'),
          },
          defaultJobOptions: {
            removeOnComplete: 1000,
            removeOnFail: false,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
          },
        };
      },
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.MPESA_CALLBACK },
      // DLQ queues – jobs move here after all retries are exhausted
      { name: QUEUE_NAMES.MPESA_CALLBACK_DLQ },
      { name: QUEUE_NAMES.MPESA_DISBURSEMENT },
      { name: QUEUE_NAMES.MPESA_DISBURSEMENT_DLQ },
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
      { name: QUEUE_NAMES.MPESA_STK_REPAYMENT },
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
    // Sprint 4
    MpesaRepaymentScheduler,
    MpesaRepaymentProcessor,
  ],
  exports: [BullModule],
})
export class QueueModule {}
