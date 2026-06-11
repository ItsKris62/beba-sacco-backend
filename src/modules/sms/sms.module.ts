import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { SmsService } from './sms.service';

@Module({
  imports: [ConfigModule, BullModule.registerQueue({ name: QUEUE_NAMES.SMS })],
  providers: [SmsService],
  exports: [SmsService],
})
export class SmsModule {}
