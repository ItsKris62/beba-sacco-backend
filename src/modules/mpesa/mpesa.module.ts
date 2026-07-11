import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MpesaService } from './mpesa.service';
import { AdminReconciliationService } from './admin-reconciliation.service';
import { DarajaClientService } from './daraja-client.service';
import { MpesaDisbursementProcessor } from './processors/mpesa-disbursement.processor';
import { MpesaB2cTimeoutProcessor } from './processors/mpesa-b2c-timeout.processor';
import { StkExpiryScheduler } from './jobs/stk-expiry.scheduler';
import { StkExpiryProcessor } from './jobs/stk-expiry.processor';
import { WithdrawalReconciliationScheduler } from './jobs/withdrawal-recon.scheduler';
import { WithdrawalReconciliationProcessor } from './jobs/withdrawal-recon.processor';
import { MpesaStkTimeoutService } from './mpesa-stk-timeout.service';
import { MpesaTenantResolverService } from './mpesa-tenant-resolver.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { AccountingModule } from '../accounting/accounting.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { isWorkerRuntime } from '../queue/worker-runtime';
import { LoansModule } from '../loans/loans.module';
import { MetricsModule } from '../metrics/metrics.module';

const MPESA_WORKER_PROVIDERS = isWorkerRuntime()
  ? [
      MpesaDisbursementProcessor,
      MpesaB2cTimeoutProcessor,
      StkExpiryProcessor,
      StkExpiryScheduler,
      WithdrawalReconciliationProcessor,
      WithdrawalReconciliationScheduler,
      MpesaStkTimeoutService,
    ]
  : [];

/**
 * MpesaModule wires all Daraja / M-Pesa concerns:
 *
 *  Controllers:
 *   - MpesaController        POST /mpesa/members/deposit
 *                            POST /mpesa/loans/:id/disburse
 *                            POST /mpesa/callback (unified Daraja callback)
 *   - MpesaWebhookController POST /mpesa/webhooks/stk-callback (legacy)
 *                            POST /mpesa/webhooks/b2c-result
 *                            POST /mpesa/webhooks/b2c-timeout
 *
 *  Services:
 *   - DarajaClientService  — raw HTTP client (OAuth + STK Push + B2C)
 *   - MpesaService         — orchestration (rate-limit, DB, queue)
 *
 *  Queue workers (registered in this module):
 *   - MpesaDisbursementProcessor — QUEUE_NAMES.MPESA_DISBURSEMENT
 *
 *  Note: MpesaCallbackProcessor lives in QueueModule to avoid a circular
 *  dependency (QueueModule → MpesaModule → QueueModule). It accesses
 *  PrismaService directly (global) and uses QUEUE_NAMES.MPESA_CALLBACK_DLQ.
 *
 *  Redis / BullMQ root connection is configured in QueueModule which is
 *  imported by AppModule before MpesaModule; BullModule.registerQueue()
 *  here merely registers individual queue instances on that connection.
 */
@Module({
  imports: [
    AuditModule,
    LoansModule,
    MetricsModule,
    AccountingModule, // Makes LedgerService available to WithdrawalReconciliationProcessor
    // Queue registrations (connection inherited from BullModule.forRootAsync in QueueModule)
    BullModule.registerQueue(
      { name: QUEUE_NAMES.MPESA_CALLBACK },
      { name: QUEUE_NAMES.MPESA_DISBURSEMENT },
      { name: QUEUE_NAMES.MPESA_STK_EXPIRY },
      { name: QUEUE_NAMES.MPESA_B2C_TIMEOUT },
      { name: QUEUE_NAMES.MPESA_WITHDRAWAL_RECON },
      // DLQ queues — jobs are moved here after all retries are exhausted
      { name: QUEUE_NAMES.MPESA_DISBURSEMENT_DLQ },
      { name: QUEUE_NAMES.MPESA_CALLBACK_DLQ },
    ),
  ],
  providers: [
    DarajaClientService,
    MpesaService,
    AdminReconciliationService,
    MpesaTenantResolverService,
    ...MPESA_WORKER_PROVIDERS,
    // PrismaService is @Global via PrismaModule, but listed explicitly so
    // this module is self-documenting about its dependencies.
    PrismaService,
  ],
  exports: [MpesaService, AdminReconciliationService, DarajaClientService, MpesaTenantResolverService],
})
export class MpesaModule {}

