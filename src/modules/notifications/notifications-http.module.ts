import { Module } from '@nestjs/common';
import { NotificationsModule } from './notifications.module';
import { NotificationsController } from './notifications.controller';
import { AdminNotificationsController } from './controllers/admin-notifications.controller';

@Module({
  imports: [NotificationsModule],
  controllers: [NotificationsController, AdminNotificationsController],
})
export class NotificationsHttpModule {}
