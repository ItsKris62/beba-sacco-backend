import {
  DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleInit,
  Optional,
  Provider,
  Type,
} from '@nestjs/common';
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
import { MpesaReconcileProcessor } from './processors/mpesa-reconcile.processor';
import { LoanPenaltyProcessor } from './processors/loan-penalty.processor';
import { GuarantorDefaultOffsetProcessor } from './processors/guarantor-default-offset.processor';
import { DailyReconScheduler } from './daily-recon.scheduler';
import { DailyJobsScheduler } from '../../queues/schedulers/daily-jobs.scheduler';
import { CronOrchestratorService } from './cron-orchestrator.service';

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
import { MetricsModule } from '../metrics/metrics.module';
import { SmsProcessor } from '../sms/sms.processor';
import { RepaymentReminderProcessor } from '../notifications/processors/repayment-reminder.processor';
import { GuarantorRecoveryProcessor } from '../notifications/processors/guarantor-recovery.processor';

export type QueueModuleMode = 'web' | 'worker';

const QUEUE_MODULE_MODE = 'QUEUE_MODULE_MODE';

export interface QueueModuleOptions {
  mode?: QueueModuleMode;
}

const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: true,
  removeOnFail: { age: 86_400, count: 50 },
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5000 },
};

export const LOW_TIER_WORKER_DEFAULTS = {
  lockDuration: 30_000,
  stalledInterval: 60_000,
  maxStalledCount: 1,
  removeOnComplete: { age: 7_200, count: 100 },
  removeOnFail: { age: 86_400, count: 50 },
};

const STREAM_OPTIONS = {
  events: { maxLen: 1000 },
};

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
  DailyJobsScheduler,
  MpesaReconcileProcessor,
  LoanPenaltyProcessor,
  GuarantorDefaultOffsetProcessor,
  RepaymentReminderProcessor,
  GuarantorRecoveryProcessor,
];

export const ADVANCED_FINANCIAL_QUEUE_PROCESSOR_PROVIDERS: Type<unknown>[] = [
  InterestAccrualProcessor,
  MpesaReconciliationProcessor,
  LedgerIntegrityProcessor,
  RepaymentScheduleProcessor,
  // Fans out per-tenant INTEREST_ACCRUAL jobs — only useful (and only registered)
  // alongside InterestAccrualProcessor, which actually consumes them.
  CronOrchestratorService,
];

export function shouldRegisterQueueProcessors(options: QueueModuleOptions = {}): boolean {
  if (options.mode === 'worker') {
    return true;
  }

  // Web-mode processor providers are a local fallback only, for setups with no
  // separate worker process (e.g. local dev). When a dedicated worker service
  // is deployed (render.yaml sets HAS_DEDICATED_WORKER=true on the web service),
  // the web process must NOT also register BullMQ Workers — each one opens its
  // own blocking Redis connection, and doubling up on every queue against a
  // connection-limited Redis instance is what caused web-service ECONNRESET
  // storms / deploy timeouts when a dedicated worker was already running them.
  if (process.env.HAS_DEDICATED_WORKER === 'true') {
    return false;
  }

  return !isWorkerRuntime();
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
function redisEndpointFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '6379'}`;
  } catch {
    return undefined;
  }
}

function normalizeHost(host?: string): string | undefined {
  return host?.replace(/^https?:\/\//, '');
}

@Injectable()
class QueueStartupDiagnostics implements OnModuleInit {
  private readonly logger = new Logger(QueueStartupDiagnostics.name);

  constructor(
    private readonly configService: ConfigService,
    @Optional() @Inject(QUEUE_MODULE_MODE) private readonly mode?: QueueModuleMode,
  ) {}

  onModuleInit(): void {
    // ENABLE_PHASE3_DAILY_JOBS turns on CronOrchestratorService's daily accrual
    // fan-out, but that service is only registered as a provider when the
    // advanced-financial-jobs flag is also set (see getQueueProcessorProviders
    // below) — otherwise InterestAccrualProcessor never exists to consume the
    // jobs it enqueues. Checked here (always instantiated, regardless of mode)
    // rather than inside CronOrchestratorService itself, which in the broken
    // configuration is never constructed and so could never assert on its own.
    const advancedFinancialJobsEnabled =
      process.env.FEATURE_ADVANCED_FINANCIAL_JOBS === 'true' ||
      process.env.PHASE_4_ENABLED === 'true';
    if (process.env.ENABLE_PHASE3_DAILY_JOBS === 'true' && !advancedFinancialJobsEnabled) {
      throw new Error(
        'Invalid configuration: ENABLE_PHASE3_DAILY_JOBS=true requires FEATURE_ADVANCED_FINANCIAL_JOBS=true ' +
          '(or PHASE_4_ENABLED=true). Without it, CronOrchestratorService is never registered, so the daily ' +
          'interest-accrual fan-out (and DEFAULTED classification that depends on it) silently never runs. ' +
          'Set both flags together, or leave both unset.',
      );
    }

    const moduleMode = this.mode ?? 'web';
    const runtimeMode = moduleMode === 'worker' || isWorkerRuntime() ? 'worker' : 'web';
    const processorCount = getQueueProcessorProviders({ mode: moduleMode }).length;
    const bullHost = normalizeHost(this.configService.get<string>('app.bullRedis.host'));
    const appHost = normalizeHost(this.configService.get<string>('app.redis.host'));
    const bullEndpoint =
      redisEndpointFromUrl(this.configService.get<string>('app.bullRedis.url')) ??
      (bullHost
        ? `${bullHost}:${this.configService.get<number>('app.bullRedis.port', 6379)}`
        : undefined);
    const appEndpoint =
      redisEndpointFromUrl(this.configService.get<string>('app.redis.url')) ??
      (appHost
        ? `${appHost}:${this.configService.get<number>('app.redis.port', 6379)}`
        : undefined);

    this.logger.log(
      `BullMQ startup: runtime=${runtimeMode} moduleMode=${moduleMode} ` +
        `bullRedis=${bullEndpoint ?? '[not configured]'} appRedis=${appEndpoint ?? '[not configured]'} ` +
        `sameRedis=${Boolean(bullEndpoint && appEndpoint && bullEndpoint === appEndpoint)} ` +
        `registeredProcessors=${processorCount}`,
    );
  }
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
        if (process.env.NODE_ENV === 'test') {
          return {
            connection: {
              host: process.env.TEST_BULL_REDIS_HOST || '127.0.0.1',
              port: Number(process.env.TEST_BULL_REDIS_PORT || 1),
              maxRetriesPerRequest: null,
              enableOfflineQueue: false,
              connectTimeout: 50,
              retryStrategy: () => null,
            },
            defaultJobOptions: DEFAULT_JOB_OPTIONS,
            streams: STREAM_OPTIONS,
          };
        }

        const bullRedisUrl = configService.get<string>('app.bullRedis.url');
        const rawBullHost = configService.get<string>('app.bullRedis.host');
        const bullPassword = configService.get<string>('app.bullRedis.password');
        const bullTls = configService.get<boolean>('app.bullRedis.tls');
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
            defaultJobOptions: DEFAULT_JOB_OPTIONS,
            streams: STREAM_OPTIONS,
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
            defaultJobOptions: DEFAULT_JOB_OPTIONS,
            streams: STREAM_OPTIONS,
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
                  console.warn(
                    '[BullMQ] Dedicated Bull Redis is not configured; using app Redis fallback in degraded mode',
                  );
                }
                return null;
              }
              return Math.min(times * 1000, 5000);
            },
            reconnectOnError: (err: Error) => err.message.includes('READONLY'),
          },
          defaultJobOptions: DEFAULT_JOB_OPTIONS,
          streams: STREAM_OPTIONS,
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
      { name: QUEUE_NAMES.LOAN_DAILY_PENALTIES },
      { name: QUEUE_NAMES.LOAN_GUARANTOR_FORFEITURE },
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
      { name: QUEUE_NAMES.MPESA_RECONCILE_QUEUE },
      { name: QUEUE_NAMES.LEDGER_INTEGRITY },
      { name: QUEUE_NAMES.OUTBOUND_WEBHOOK },
      { name: QUEUE_NAMES.MPESA_STK_REPAYMENT },
      { name: QUEUE_NAMES.REPORT_GENERATION },
      { name: QUEUE_NAMES.REPORT_GENERATION_DLQ },
      // Phase 1 – KYC async review pipeline
      { name: QUEUE_NAMES.KYC_REVIEW },
      { name: QUEUE_NAMES.KYC_REVIEW_DLQ },
      // Support async processing
      { name: QUEUE_NAMES.SUPPORT_NOTIFICATIONS },
      { name: QUEUE_NAMES.SUPPORT_WORKFLOWS },
    ),
    MpesaModule,
    LoansModule,
    AuditModule,
    FinancialModule,
    WebhooksModule,
    ReportsModule,
    StorageModule,
    SmsModule,
    MetricsModule,
  ],
  providers: [
    { provide: QUEUE_MODULE_MODE, useValue: 'web' },
    QueueStartupDiagnostics,
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
      providers: [{ provide: QUEUE_MODULE_MODE, useValue: options.mode ?? 'web' }, ...providers],
      exports: [BullModule, ...providers],
    };
  }
}

