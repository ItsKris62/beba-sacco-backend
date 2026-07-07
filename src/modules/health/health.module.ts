import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageModule } from '../storage/storage.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
// RedisService is @Global via CommonServicesModule — no explicit import needed

@Module({
  imports: [
    TerminusModule,
    StorageModule,
    BullModule.registerQueue(
      { name: QUEUE_NAMES.MPESA_CALLBACK },
      { name: QUEUE_NAMES.MPESA_DISBURSEMENT },
      { name: QUEUE_NAMES.LOAN_DISBURSE },
      { name: QUEUE_NAMES.REPORT_GENERATION },
    ),
  ],
  controllers: [HealthController],
  providers: [PrismaService],
})
export class HealthModule {}

