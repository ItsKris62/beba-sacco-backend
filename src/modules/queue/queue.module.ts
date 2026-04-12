import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

/**
 * Queue Module
 * 
 * BullMQ + Upstash Redis for background jobs
 * 
 * Queues:
 * - email: Send emails (verification, notifications)
 * - sms: Send SMS notifications
 * - mpesa: M-Pesa transaction status checks
 * - analytics: Send events to Tinybird
 * - reports: Generate reports (PDFs, Excel)
 * 
 * TODO: Phase 2 - Implement queue processors
 * TODO: Phase 3 - Add job scheduling (cron jobs)
 * TODO: Phase 4 - Add queue monitoring dashboard
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('app.redis.host'),
          port: configService.get<number>('app.redis.port'),
          password: configService.get<string>('app.redis.password'),
          tls: configService.get<boolean>('app.redis.tls') ? {} : undefined,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: 'email' },
      { name: 'sms' },
      { name: 'mpesa' },
      { name: 'analytics' },
      { name: 'reports' },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}

