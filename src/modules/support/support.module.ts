import { Module, forwardRef, OnModuleInit } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SupportService } from './support.service';
import { IncidentService } from './incident.service';
import { SupportRealtimeGateway } from './support-realtime.gateway';
import { SlaProcessor } from './processors/sla.processor';
import { AutoCloseTicketsProcessor } from './processors/auto-close-tickets.processor';
import { StorageModule } from '../storage/storage.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { isWorkerRuntime } from '../queue/worker-runtime';
import { SupportNotificationsProcessor } from './processors/support-notifications.processor';
import { AuthModule } from '../auth/auth.module';

const SUPPORT_WORKER_PROVIDERS = isWorkerRuntime() ? [SlaProcessor, AutoCloseTicketsProcessor, SupportNotificationsProcessor] : [];

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    AuthModule,
    forwardRef(() => NotificationsModule),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.SUPPORT_NOTIFICATIONS },
      { name: QUEUE_NAMES.SUPPORT_WORKFLOWS }
    ),
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
    @InjectQueue(QUEUE_NAMES.SUPPORT_WORKFLOWS) private readonly workflowQueue: Queue,
  ) {}

  async onModuleInit() {
    if (!isWorkerRuntime()) return;

    await this.workflowQueue.add('check-sla', {}, {
      jobId: 'check-sla:system:every-5-minutes',
      repeat: { pattern: '*/5 * * * *' }, // Every 5 mins
      removeOnComplete: true,
      removeOnFail: true,
    });

    await this.workflowQueue.add('auto-close', {}, {
      jobId: 'auto-close:system:hourly',
      repeat: { pattern: '0 * * * *' }, // Hourly
      removeOnComplete: true,
      removeOnFail: true,
    });
  }
}




