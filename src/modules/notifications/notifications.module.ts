import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SupportModule } from '../support/support.module';
import { InAppNotificationService } from './in-app-notification.service';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => SupportModule),
  ],
  providers: [InAppNotificationService],
  exports: [InAppNotificationService],
})
export class NotificationsModule {}
