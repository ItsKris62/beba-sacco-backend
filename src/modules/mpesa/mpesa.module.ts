import { Module } from '@nestjs/common';
import { MpesaController } from './mpesa.controller';
import { MpesaWebhookController } from './mpesa-webhook.controller';
import { MpesaService } from './mpesa.service';
import { PrismaService } from '../../prisma/prisma.service';

// RedisService is provided globally via CommonServicesModule (@Global)
// so it does not need to be imported here.

@Module({
  controllers: [MpesaController, MpesaWebhookController],
  providers: [MpesaService, PrismaService],
  exports: [MpesaService],
})
export class MpesaModule {}
