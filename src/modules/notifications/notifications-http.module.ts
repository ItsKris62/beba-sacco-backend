import { Module } from '@nestjs/common';
import { NotificationsModule } from './notifications.module';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [NotificationsModule],
  controllers: [NotificationsController],
})
export class NotificationsHttpModule {}