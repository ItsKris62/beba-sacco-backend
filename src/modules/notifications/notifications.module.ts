import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SupportModule } from '../support/support.module';
import { InAppNotificationService } from './in-app-notification.service';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => SupportModule),
  ],
  controllers: [NotificationsController],
  providers: [InAppNotificationService],
  exports: [InAppNotificationService],
})
export class NotificationsModule {}
