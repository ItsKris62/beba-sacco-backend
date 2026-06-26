import { Module, forwardRef, OnModuleInit } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SupportController } from './support.controller';
import { IncidentsController } from './incidents.controller';
import { TicketAttachmentsController } from './ticket-attachments.controller';
import { SupportService } from './support.service';
import { IncidentService } from './incident.service';
import { SupportRealtimeGateway } from './support-realtime.gateway';
import { SlaProcessor } from './processors/sla.processor';
import { AutoCloseTicketsProcessor } from './processors/auto-close-tickets.processor';
import { StorageModule } from '../storage/storage.module';
import { AuthModule } from '../auth/auth.module';
import { isWorkerRuntime } from '../queue/worker-runtime';

const SUPPORT_WORKER_PROVIDERS = isWorkerRuntime() ? [SlaProcessor, AutoCloseTicketsProcessor] : [];

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    AuthModule,
    forwardRef(() => NotificationsModule),
    BullModule.registerQueue(
      { name: 'support-sla' },
      { name: 'support-auto-close' }
    ),
  ],
  controllers: [
    SupportController,
    IncidentsController,
    TicketAttachmentsController
  ],
  providers: [
    SupportService,
    IncidentService,
    SupportRealtimeGateway,
    ...SUPPORT_WORKER_PROVIDERS,
  ],
  exports: [SupportService, IncidentService, SupportRealtimeGateway],
})
export class SupportModule implements OnModuleInit {
  constructor(
    @InjectQueue('support-sla') private readonly slaQueue: Queue,
    @InjectQueue('support-auto-close') private readonly autoCloseQueue: Queue,
  ) {}

  async onModuleInit() {
    if (!isWorkerRuntime()) return;

    await this.slaQueue.add('check-sla', {}, {
      jobId: 'check-sla:system:every-5-minutes',
      repeat: { pattern: '*/5 * * * *' }, // Every 5 mins
      removeOnComplete: true,
      removeOnFail: true,
    });

    await this.autoCloseQueue.add('auto-close', {}, {
      jobId: 'auto-close:system:hourly',
      repeat: { pattern: '0 * * * *' }, // Hourly
      removeOnComplete: true,
      removeOnFail: true,
    });
  }
}


