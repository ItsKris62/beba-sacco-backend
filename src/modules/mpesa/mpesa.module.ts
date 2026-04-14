import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MpesaController } from './mpesa.controller';
import { MpesaWebhookController } from './mpesa-webhook.controller';
import { MpesaService } from './mpesa.service';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_NAMES } from '../queue/queue.constants';

// RedisService is provided globally via CommonServicesModule (@Global)
// BullModule root config is registered in QueueModule; we just register the queue here.

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_NAMES.MPESA_CALLBACK }),
  ],
  controllers: [MpesaController, MpesaWebhookController],
  providers: [MpesaService, PrismaService],
  exports: [MpesaService],
})
export class MpesaModule {}
