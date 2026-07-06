import { Module } from '@nestjs/common';
import { WebhooksModule } from './webhooks.module';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [WebhooksModule],
  controllers: [WebhooksController],
})
export class WebhooksHttpModule {}