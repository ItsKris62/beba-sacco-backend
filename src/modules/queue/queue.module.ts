import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QUEUE_NAMES } from './queue.constants';
import { isWorkerRuntime } from './worker-runtime';

// Processors
import { MpesaCallbackProcessor } from './processors/mpesa-callback.processor';
import { GuarantorReminderProcessor } from './processors/guarantor-reminder.processor';
import { GuarantorProcessor } from './processors/guarantor.processor';
import { GuarantorExpiryConsumer } from './processors/guarantor-expiry.consumer';
import { AuditLogProcessor } from './processors/audit-log.processor';
import { AuditQueueProcessor } from './processors/audit-queue.processor';
import { LoanDisburseProcessor } from './processors/loan-disburse.processor';
import { EmailProcessor } from './processors/email.processor';
// Phase 4 processors
import { InterestAccrualProcessor } from './processors/interest-accrual.processor';
import { MpesaReconciliationProcessor } from './processors/mpesa-reconciliation.processor';
import { LedgerIntegrityProcessor } from './processors/ledger-integrity.processor';
import { RepaymentScheduleProcessor } from './processors/repayment-schedule.processor';
import { OutboundWebhookProcessor } from './processors/outbound-webhook.processor';
import { ReportProcessor } from './processors/report.processor';
import { DeadLetterAlertProcessor } from './dead-letter.processor';
// Sprint 4 – cron-scheduled STK repayment
import { MpesaRepaymentScheduler } from './processors/mpesa-repayment.scheduler';
import { MpesaRepaymentProcessor } from './processors/mpesa-repayment.processor';
import { DailyReconProcessor } from './processors/daily-recon.processor';
import { DailyReconScheduler } from './daily-recon.scheduler';

// Service dependencies needed by processors
import { MpesaModule } from '../mpesa/mpesa.module';
import { LoansModule } from '../loans/loans.module';
import { AuditModule } from '../audit/audit.module';
import { PlunkService } from '../../common/services/plunk.service';
import { FinancialModule } from '../financial/financial.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { ReportsModule } from '../reports/reports.module';
import { StorageModule } from '../storage/storage.module';
import { GuarantorValidationService } from '../loans/guarantor-validation.service';
import { AlertsService } from '../alerts/alerts.service';
import { SmsModule } from '../sms/sms.module';
import { SmsProcessor } from '../sms/sms.processor';
import { RepaymentReminderProcessor } from '../notifications/processors/repayment-reminder.processor';
import { GuarantorRecoveryProcessor } from '../notifications/processors/guarantor-recovery.processor';

export type QueueModuleMode = 'web' | 'worker';

export interface QueueModuleOptions {
  mode?: QueueModuleMode;
}

export const QUEUE_PROCESSOR_PROVIDERS: Type<unknown>[] = [
  MpesaCallbackProcessor,
  GuarantorReminderProcessor,
  GuarantorProcessor,
  GuarantorExpiryConsumer,
  AuditLogProcessor,
  AuditQueueProcessor,
  LoanDisburseProcessor,
  EmailProcessor,
  SmsProcessor,
  OutboundWebhookProcessor,
  ReportProcessor,
  MpesaRepaymentScheduler,
  MpesaRepaymentProcessor,
  DailyReconProcessor,
  DailyReconScheduler,
  DeadLetterAlertProcessor,
  RepaymentReminderProcessor,
  GuarantorRecoveryProcessor,
];

export const ADVANCED_FINANCIAL_QUEUE_PROCESSOR_PROVIDERS: Type<unknown>[] = [
  InterestAccrualProcessor,
  MpesaReconciliationProcessor,
  LedgerIntegrityProcessor,
  RepaymentScheduleProcessor,
];

export function shouldRegisterQueueProcessors(options: QueueModuleOptions = {}): boolean {
  if (options.mode === 'worker') {
    return true;
  }

  // Render/Docker deployment: run the HTTP service with WORKER_MODE unset/false,
  // and create a separate worker service with WORKER_MODE=true. Web instances can
  // enqueue jobs, but only worker instances register @Processor classes.
  return isWorkerRuntime();
}

export function getQueueProcessorProviders(options: QueueModuleOptions = {}): Type<unknown>[] {
  if (!shouldRegisterQueueProcessors(options)) {
    return [];
  }

  const providers = [...QUEUE_PROCESSOR_PROVIDERS];
  const advancedEnabled =
    process.env.FEATURE_ADVANCED_FINANCIAL_JOBS === 'true' ||
    process.env.PHASE_4_ENABLED === 'true';

  if (advancedEnabled) {
    providers.push(...ADVANCED_FINANCIAL_QUEUE_PROCESSOR_PROVIDERS);
  }

  return providers;
}

/**
 * Queue Module – BullMQ + dedicated Redis
 *
 * BullMQ uses a separate Redis connection (BULL_REDIS_URL) so that its
 * continuous polling never touches the Upstash command quota.
 *
 * Connection strategy:
 *   Production  → BULL_REDIS_URL (Render Redis / Railway / any connection-based provider)
 *   Development → falls back to the Upstash config (single Redis is fine for low load)
 *
 * Why two Redis instances?
 *   Upstash bills per command. BullMQ's internal polling across 20+ queues
 *   generates thousands of commands/minute even with zero jobs — far beyond
 *   Upstash's free tier and expensive on paid tiers. Connection-based providers
 *   have no per-command cost, making them the correct home for a job queue.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const bullRedisUrl = configService.get<string>('app.bullRedis.url');
        const rawBullHost = configService.get<string>('app.bullRedis.host');
        const bullPassword = configService.get<string>('app.bullRedis.password');
        const bullTls = configService.get<boolean>('app.bullRedis.tls');

        const defaultJobOptions = {
          removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
          removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
          attempts: 5,
          backoff: { type: 'exponential' as const, delay: 5000 },
        };

        if (bullRedisUrl) {
          const parsed = new URL(bullRedisUrl);
          const tls = parsed.protocol === 'rediss:' ? { rejectUnauthorized: false } : undefined;

          return {
            connection: {
              host: parsed.hostname,
              port: parseInt(parsed.port || '6379', 10),
              password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
              tls,
              maxRetriesPerRequest: null,
              enableAutoPipelining: true,
              connectTimeout: 5000,
              keepAlive: 10000,
              retryStrategy: (times: number) => Math.min(times * 500, 10_000),
              reconnectOnError: (err: Error) => err.message.includes('READONLY'),
            },
            defaultJobOptions,
          };
        }

        if (rawBullHost) {
          const host = rawBullHost.replace(/^https?:\/\//, '');

          return {
            connection: {
              host,
              port: configService.get<number>('app.bullRedis.port', 6379),
              password: bullPassword || undefined,
              tls: bullTls ? { rejectUnauthorized: false } : undefined,
              maxRetriesPerRequest: null,
              enableAutoPipelining: true,
              connectTimeout: 5000,
              keepAlive: 10000,
              retryStrategy: (times: number) => Math.min(times * 500, 10_000),
              reconnectOnError: (err: Error) => err.message.includes('READONLY'),
            },
            defaultJobOptions,
          };
        }

        const password = configService.get<string>('app.redis.password');
        const tls = configService.get<boolean>('app.redis.tls');
        const rawHost = configService.get<string>('app.redis.host', 'localhost');
        const host = rawHost.replace(/^https?:\/\//, '');
        let bullGaveUp = false;

        return {
          connection: {
            host,
            port: configService.get<number>('app.redis.port'),
            password: password || undefined,
            tls: tls ? { rejectUnauthorized: false } : undefined,
            maxRetriesPerRequest: null,
            enableAutoPipelining: true,
            connectTimeout: 5000,
            keepAlive: 10000,
            retryStrategy: (times: number) => {
              if (times > 1) {
                if (!bullGaveUp) {
                  bullGaveUp = true;
                  console.warn('[BullMQ] Dedicated Bull Redis is not configured; using app Redis fallback in degraded mode');
                }
                return null;
              }
              return Math.min(times * 1000, 5000);
            },
            reconnectOnError: (err: Error) => err.message.includes('READONLY'),
          },
          defaultJobOptions,
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
      { name: QUEUE_NAMES.LOAN_GUARANTOR_EXPIRY },
      { name: QUEUE_NAMES.REPAYMENT_REMINDER },
      { name: QUEUE_NAMES.GUARANTOR_RECOVERY },
      { name: QUEUE_NAMES.GUARANTOR_VALIDATION },
      { name: QUEUE_NAMES.GUARANTOR_VALIDATION_DLQ },
      { name: QUEUE_NAMES.AUDIT_LOG },
      { name: QUEUE_NAMES.AUDIT_PERSIST },
      { name: QUEUE_NAMES.AUDIT_PERSIST_DLQ },
      { name: QUEUE_NAMES.LOAN_DISBURSE },
      { name: QUEUE_NAMES.EMAIL },
      { name: QUEUE_NAMES.SMS },
      // Phase 4
      { name: QUEUE_NAMES.INTEREST_ACCRUAL },
      { name: QUEUE_NAMES.REPAYMENT_SCHEDULE },
      { name: QUEUE_NAMES.MPESA_RECONCILIATION },
      { name: QUEUE_NAMES.LEDGER_INTEGRITY },
      { name: QUEUE_NAMES.OUTBOUND_WEBHOOK },
      { name: QUEUE_NAMES.MPESA_STK_REPAYMENT },
      { name: QUEUE_NAMES.REPORT_GENERATION },
      { name: QUEUE_NAMES.REPORT_GENERATION_DLQ },
      // Phase 1 – KYC async review pipeline
      { name: QUEUE_NAMES.KYC_REVIEW },
      { name: QUEUE_NAMES.KYC_REVIEW_DLQ },
    ),
    MpesaModule,
    LoansModule,
    AuditModule,
    FinancialModule,
    WebhooksModule,
    ReportsModule,
    StorageModule,
    SmsModule,
  ],
  providers: [
    // PlunkService is @Global but QueueModule is loaded before CommonServicesModule
    // resolves globally for processors — re-provide here to be explicit.
    PlunkService,
    AlertsService,
    GuarantorValidationService,
    ...getQueueProcessorProviders({ mode: 'web' }),
  ],
  exports: [BullModule, ...getQueueProcessorProviders({ mode: 'web' })],
})
export class QueueModule {
  static forRoot(options: QueueModuleOptions = {}): DynamicModule {
    const providers: Provider[] = getQueueProcessorProviders(options);

    return {
      module: QueueModule,
      providers,
      exports: [BullModule, ...providers],
    };
  }
}
