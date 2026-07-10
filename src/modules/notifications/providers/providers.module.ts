import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../../prisma/prisma.module';
import { NotificationDispatcherService } from '../services/notification-dispatcher.service';
import { AfricasTalkingProvider } from './africas-talking.provider';
import { InAppProvider } from './in-app.provider';
import { SendGridProvider } from './sendgrid.provider';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [
    AfricasTalkingProvider,
    SendGridProvider,
    InAppProvider,
    NotificationDispatcherService,
  ],
  exports: [AfricasTalkingProvider, SendGridProvider, InAppProvider, NotificationDispatcherService],
})
export class ProvidersModule {}
