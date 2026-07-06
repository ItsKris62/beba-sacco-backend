import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { AuditModule } from '../audit/audit.module';
import { StorageModule } from '../storage/storage.module';
import { ReportsService } from './reports.service';

@Module({
  imports: [
    AuditModule,
    StorageModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.REPORT_GENERATION }),
  ],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
