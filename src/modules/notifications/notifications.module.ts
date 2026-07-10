import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SupportModule } from '../support/support.module';
import { InAppNotificationService } from './in-app-notification.service';
import { NotificationsQueueModule } from './notifications-queue.module';
import { ProvidersModule } from './providers/providers.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => SupportModule),
    NotificationsQueueModule,
    ProvidersModule,
  ],
  providers: [InAppNotificationService],
  exports: [InAppNotificationService, NotificationsQueueModule, ProvidersModule],
})
export class NotificationsModule {}
