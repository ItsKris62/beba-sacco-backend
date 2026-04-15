import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { CommonServicesModule } from './common/services/common-services.module';

// Config
import appConfig from './common/config/app.config';
import { validationSchema } from './common/config/validation.schema';

// Common
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { JwtAuthGuard } from './common/guards/jwt.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { TenantInterceptor } from './common/interceptors/tenant.interceptor';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

// Feature Modules
import { AuthModule } from './modules/auth/auth.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';
import { MembersModule } from './modules/members/members.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { LoansModule } from './modules/loans/loans.module';
import { MpesaModule } from './modules/mpesa/mpesa.module';
import { AuditModule } from './modules/audit/audit.module';
import { QueueModule } from './modules/queue/queue.module';
import { StorageModule } from './modules/storage/storage.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { HealthModule } from './modules/health/health.module';
import { AdminModule } from './modules/admin/admin.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { FinancialModule } from './modules/financial/financial.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { FraudModule } from './modules/fraud/fraud.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
// Phase 5
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { IdempotencyMiddleware } from './common/middleware/idempotency.middleware';
import { ApiVersionInterceptor } from './common/interceptors/api-version.interceptor';
// Phase 6
import { Phase6Module } from './modules/admin/phase6/phase6.module';
// Phase 7
import { Phase7Module } from './modules/admin/phase7/phase7.module';

// Prisma
import { PrismaService } from './prisma/prisma.service';
import { AuditService } from './modules/audit/audit.service';

/**
 * Application Root Module
 *
 * Guard execution order (NestJS respects registration order):
 *   ThrottlerGuard → JwtAuthGuard → RolesGuard
 *
 * Interceptor execution order:
 *   LoggingInterceptor → TenantInterceptor → AuditInterceptor
 *
 * TenantInterceptor runs before AuditInterceptor so req.tenant is populated
 * when the audit write happens.
 */
@Module({
  imports: [
    // ── Configuration ──────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      validationSchema,
      validationOptions: {
        allowUnknown: false,
        abortEarly: true,
      },
    }),

    // ── Structured Logging (nestjs-pino) ───────────────────────
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV !== 'production' ? 'debug' : 'info',
        // Silent in test to prevent noise during jest runs
        ...(process.env.NODE_ENV === 'test' && { level: 'silent' }),
        // Pretty-print in dev; JSON in production (consumed by log aggregators)
        transport:
          process.env.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { colorize: true, singleLine: false } }
            : undefined,
        // Attach X-Request-ID from our middleware to every log line
        customProps: (req: IncomingMessage) => ({
          requestId: (req.headers['x-request-id'] as string | undefined) ?? '',
        }),
        redact: ['req.headers.authorization', 'req.body.password', 'req.body.refreshToken'],
      },
    }),

    // ── Shared Infrastructure (Redis, Idempotency) ────────────
    CommonServicesModule,

    // ── Rate Limiting ──────────────────────────────────────────
    ThrottlerModule.forRoot([
      {
        name: 'global',
        ttl: 60_000,  // 1 minute window
        limit: 100,   // 100 requests per minute per IP
      },
    ]),

    // ── Feature Modules ────────────────────────────────────────
    AuthModule,
    TenantsModule,
    UsersModule,
    MembersModule,
    AccountsModule,
    LoansModule,
    MpesaModule,
    AuditModule,     // Must be imported so AuditService is resolvable by AuditInterceptor
    QueueModule,
    StorageModule,
    AnalyticsModule,
    HealthModule,
    AdminModule,
    MetricsModule,
    // Phase 4
    FinancialModule,
    ComplianceModule,
    FraudModule,
    WebhooksModule,
    // Phase 5
    IntegrationsModule,
    // Phase 6
    Phase6Module,
    // Phase 7
    Phase7Module,
  ],

  providers: [
    PrismaService,
    AuditService, // Also register here so APP_INTERCEPTOR factory can inject it

    // ── Global Guards (order matters) ──────────────────────────
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },

    // ── Global Interceptors (order matters) ───────────────────
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ApiVersionInterceptor },

    // ── Global Filters ────────────────────────────────────────
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
    // Phase 4 – idempotency enforcement on mutating endpoints
    consumer.apply(IdempotencyMiddleware).forRoutes('*');
  }
}
