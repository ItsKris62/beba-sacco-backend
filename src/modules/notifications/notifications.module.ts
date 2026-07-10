import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { isWorkerRuntime } from '../queue/worker-runtime';
import { SupportModule } from '../support/support.module';
import { InAppNotificationService } from './in-app-notification.service';
import { NotificationEventListener } from './listeners/notification-event.listener';
import { NotificationsQueueModule } from './notifications-queue.module';
import { EmailQueueProcessor } from './processors/email-queue.processor';
import { InAppQueueProcessor } from './processors/in-app-queue.processor';
import { SmsQueueProcessor } from './processors/sms-queue.processor';
import { ProvidersModule } from './providers/providers.module';
import { AdminNotificationsService } from './services/admin-notifications.service';

const notificationProcessors =
  isWorkerRuntime() || process.env.HAS_DEDICATED_WORKER !== 'true'
    ? [EmailQueueProcessor, SmsQueueProcessor, InAppQueueProcessor]
    : [];

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => SupportModule),
    NotificationsQueueModule,
    ProvidersModule,
  ],
  providers: [
    InAppNotificationService,
    AdminNotificationsService,
    NotificationEventListener,
    ...notificationProcessors,
  ],
  exports: [
    InAppNotificationService,
    AdminNotificationsService,
    NotificationsQueueModule,
    ProvidersModule,
    NotificationEventListener,
  ],
})
export class NotificationsModule {}
