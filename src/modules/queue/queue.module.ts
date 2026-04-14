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

// Service dependencies needed by processors
import { MpesaModule } from '../mpesa/mpesa.module';
import { LoansModule } from '../loans/loans.module';
import { AuditModule } from '../audit/audit.module';
import { PlunkService } from '../../common/services/plunk.service';

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
    ),
    MpesaModule,
    LoansModule,
    AuditModule,
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
  ],
  exports: [BullModule],
})
export class QueueModule {}
