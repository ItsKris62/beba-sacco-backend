import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { CommonServicesModule } from './common/services/common-services.module';
import { SentryModule, SentryGlobalFilter } from '@sentry/nestjs/setup';
import { createPinoHttpOptions } from './common/logging/pino.config';

// Config
import appConfig from './common/config/app.config';
import { validationSchema } from './common/config/validation.schema';

// Common
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { TenantMiddleware } from './common/middleware/tenant.middleware';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { MpesaExceptionFilter } from './modules/mpesa/filters/mpesa-exception.filter';
import { JwtAuthGuard } from './common/guards/jwt.guard';
import { RBACGuard } from './common/guards/rbac.guard';
import { TenantInterceptor } from './common/interceptors/tenant.interceptor';
import { GlobalAuditInterceptor } from './common/interceptors/global-audit.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { SentryInterceptor } from './common/sentry/sentry.interceptor';

// Feature Modules
import { AuthHttpModule } from './modules/auth/auth-http.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';
import { MembersModule } from './modules/members/members.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { LoansHttpModule } from './modules/loans/loans-http.module';
import { LoanApplicationModule } from './modules/loans/loan-application.module';
import { MpesaHttpModule } from './modules/mpesa/mpesa-http.module';
import { AuditHttpModule } from './modules/audit/audit-http.module';
import { QueueModule } from './modules/queue/queue.module';
import { BullBoardModule } from './modules/queue/bull-board.module';
import { StorageModule } from './modules/storage/storage.module';
import { DocumentsHttpModule } from './modules/documents/documents-http.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { HealthModule } from './modules/health/health.module';
import { AdminModule } from './modules/admin/admin.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { FinancialModule } from './modules/financial/financial.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { FraudModule } from './modules/fraud/fraud.module';
import { WebhooksHttpModule } from './modules/webhooks/webhooks-http.module';
// Phase 5
import { IntegrationsHttpModule } from './modules/integrations/integrations-http.module';
import { IdempotencyMiddleware } from './common/middleware/idempotency.middleware';
import { ApiVersionInterceptor } from './common/interceptors/api-version.interceptor';
// Phase 6
import { Phase6HttpModule } from './modules/admin/phase6/phase6-http.module';
// Phase 7
import { Phase7Module } from './modules/admin/phase7/phase7.module';
// Sprint 1
import { LocationsModule } from './modules/locations/locations.module';
import { ApplicationsModule } from './modules/applications/applications.module';
import { StagesModule } from './modules/stages/stages.module';
// Sprint 2
import { DataImportHttpModule } from './modules/data-import/data-import-http.module';
// Sprint 3 – domain modules
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { StatementsModule } from './modules/statements/statements.module';
import { ReportsHttpModule } from './modules/reports/reports-http.module';
// Tier 2 – Accounting
import { AccountingHttpModule } from './modules/accounting/accounting-http.module';
// KYC async processing
import { KycModule } from './modules/kyc/kyc.module';
import { SupportHttpModule } from './modules/support/support-http.module';
import { NotificationsHttpModule } from './modules/notifications/notifications-http.module';

// Prisma
import { PrismaModule } from './prisma/prisma.module';
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
    SentryModule.forRoot(),

    // ── Cron Jobs ──────────────────────────────────────────────
    ScheduleModule.forRoot(),

    // ── Configuration ──────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      validationSchema,
      validationOptions: {
        allowUnknown: true,
        abortEarly: true,
      },
    }),

    // ── Structured Logging (nestjs-pino) ───────────────────────
    LoggerModule.forRoot({
      pinoHttp: createPinoHttpOptions(),
    }),

    // ── Prisma (Global) ────────────────────────────────────────
    PrismaModule,

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
    AuthHttpModule,
    TenantsModule,
    UsersModule,
    MembersModule,
    AccountsModule,
    LoansHttpModule,
    LoanApplicationModule, // ✅ Registers LoanAdminController + exports LoanApplicationService
    MpesaHttpModule,
    AuditHttpModule,     // Must be imported so AuditService is resolvable by AuditInterceptor
    QueueModule,
    BullBoardModule,  // must come after QueueModule so the shared BullMQ root connection is ready
    StorageModule,
    DocumentsHttpModule,
    AnalyticsModule,
    HealthModule,
    AdminModule,
    MetricsModule,
    // Phase 4
    FinancialModule,
    ComplianceModule,
    FraudModule,
    WebhooksHttpModule,
    // Phase 5
    IntegrationsHttpModule,
    // Phase 6
    Phase6HttpModule,
    // Phase 7
    Phase7Module,
    // Sprint 1 – Onboarding, Locations, Stages
    LocationsModule,
    ApplicationsModule,
    StagesModule,
    // Sprint 2 – Legacy Data Import
    DataImportHttpModule,
    // Sprint 3 – Dashboard, Statements, Session & ODPC Compliance
    DashboardModule,
    StatementsModule,
    ReportsHttpModule,
    AccountingHttpModule,
    KycModule,
    SupportHttpModule,
    NotificationsHttpModule,
  ],

  providers: [
    PrismaService,
    AuditService, // Also register here so APP_INTERCEPTOR factory can inject it

    // ── Global Guards (order matters) ──────────────────────────
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RBACGuard },

    // ── Global Interceptors (order matters) ───────────────────
    { provide: APP_INTERCEPTOR, useClass: SentryInterceptor },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    { provide: APP_INTERCEPTOR, useClass: GlobalAuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ApiVersionInterceptor },

    // ── Global Filters ────────────────────────────────────────
    // Registration order matters for APP_FILTER: last entry = highest priority.
    // MpesaExceptionFilter is also more specific (@Catch(MpesaException) vs @Catch()),
    // so it wins over GlobalExceptionFilter for MpesaException subclasses on any route.
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_FILTER, useClass: MpesaExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware, TenantMiddleware, IdempotencyMiddleware).forRoutes('*');
    // Phase 4 – idempotency enforcement on mutating endpoints
  }
}
