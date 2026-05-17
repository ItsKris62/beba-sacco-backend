import { Module } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { SentryModule } from '@sentry/nestjs/setup';
import appConfig from './common/config/app.config';
import { validationSchema } from './common/config/validation.schema';
import { CommonServicesModule } from './common/services/common-services.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './modules/queue/queue.module';
import { MpesaModule } from './modules/mpesa/mpesa.module';

/**
 * WorkerModule boots the queue-processing dependency graph without creating an
 * HTTP server. Controllers may exist in imported domain modules, but no routes
 * are bound because the worker uses Nest's application context only.
 */
@Module({
  imports: [
    SentryModule.forRoot(),
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      validationSchema,
      validationOptions: {
        allowUnknown: true,
        abortEarly: true,
      },
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV !== 'production' ? 'debug' : 'info',
        ...(process.env.NODE_ENV === 'test' && { level: 'silent' }),
        transport:
          process.env.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { colorize: true, singleLine: false } }
            : undefined,
        customProps: (req: IncomingMessage) => ({
          requestId: (req.headers['x-request-id'] as string | undefined) ?? '',
        }),
        redact: [
          'req.headers.authorization',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.confirmPassword',
          'req.body.refreshToken',
          'req.body.token',
          'req.body.accessTokenJti',
        ],
      },
    }),
    PrismaModule,
    CommonServicesModule,
    QueueModule.forRoot({ mode: 'worker' }),
    MpesaModule,
  ],
})
export class WorkerModule {}
