import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MpesaController } from './mpesa.controller';
import { MpesaWebhookController } from './mpesa-webhook.controller';
import { MpesaService } from './mpesa.service';
import { DarajaClientService } from './daraja-client.service';
import { MpesaIpGuard } from './guards/mpesa-ip.guard';
import { MpesaDisbursementProcessor } from './processors/mpesa-disbursement.processor';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_NAMES } from '../queue/queue.constants';

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
    // Queue registrations (connection inherited from BullModule.forRootAsync in QueueModule)
    BullModule.registerQueue(
      { name: QUEUE_NAMES.MPESA_CALLBACK },
      { name: QUEUE_NAMES.MPESA_DISBURSEMENT },
      // DLQ queues — jobs are moved here after all retries are exhausted
      { name: QUEUE_NAMES.MPESA_DISBURSEMENT_DLQ },
      { name: QUEUE_NAMES.MPESA_CALLBACK_DLQ },
    ),
  ],
  controllers: [MpesaController, MpesaWebhookController],
  providers: [
    DarajaClientService,
    MpesaService,
    MpesaIpGuard,
    // B2C disbursement processor lives here (not in QueueModule) because it
    // needs MpesaService and there is no circular dependency in this direction.
    MpesaDisbursementProcessor,
    // PrismaService is @Global via PrismaModule, but listed explicitly so
    // this module is self-documenting about its dependencies.
    PrismaService,
  ],
  exports: [MpesaService, DarajaClientService],
})
export class MpesaModule {}
