import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { CommonServicesModule } from '../../common/services/common-services.module';

@Module({
  imports: [
    CommonServicesModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.OUTBOUND_WEBHOOK }),
  ],
  providers: [PrismaService, WebhooksService],
  controllers: [WebhooksController],
  exports: [WebhooksService],
})
export class WebhooksModule {}
