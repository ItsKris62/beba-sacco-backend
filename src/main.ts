import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import * as Sentry from '@sentry/node';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';

/**
 * Bootstrap NestJS Application
 *
 * Boot order:
 * 1. Create app with buffered logs (nestjs-pino takes over after useLogger)
 * 2. Apply security middleware (helmet, CORS, x-powered-by removal)
 * 3. Register global pipes
 * 4. Configure Swagger
 * 5. Wire Prisma graceful shutdown
 * 6. Start listening
 *
 * IMPORTANT – Multi-tenant connection:
 * Ensure DATABASE_URL points to the DIRECT (non-pooler) Neon connection string
 * for Phase 2 SET search_path support. The pooler URL will work for Phase 0/1
 * (public schema only) but will silently break per-tenant schema switching.
 */
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Buffer logs until nestjs-pino Logger is wired up
    bufferLogs: true,
    // Preserve raw body bytes so the M-Pesa webhook controller can compute HMAC
    rawBody: true,
  });

  // ── Sentry ─────────────────────────────────────────────────────
  // @sentry/node v7 auto-instruments HTTP/Express — no explicit integrations array needed.
  const sentryDsn = process.env.SENTRY_DSN;
  if (sentryDsn) {
    Sentry.init({
      dsn: sentryDsn,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
      tracesSampleRate: 0.1,
    });
  }

  // ── Structured Logging ─────────────────────────────────────────
  app.useLogger(app.get(Logger));

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port', 3000);
  const apiPrefix = configService.get<string>('app.apiPrefix', 'api');
  const nodeEnv = configService.get<string>('app.nodeEnv', 'development');

  // ── Security ───────────────────────────────────────────────────
  // Disable Express's default "X-Powered-By: Express" fingerprinting header
  app.disable('x-powered-by');

  app.use(
    helmet({
      // Relax CSP in dev so Swagger UI assets load; enforce in production
      contentSecurityPolicy: nodeEnv === 'production' ? undefined : false,
      // Prevent browsers from MIME-sniffing responses
      noSniff: true,
      // Deny framing on all pages
      frameguard: { action: 'deny' },
      // HSTS – only effective over HTTPS
      hsts: nodeEnv === 'production'
        ? { maxAge: 31536000, includeSubDomains: true, preload: true }
        : false,
    }),
  );

  // CORS: only the configured frontend origin(s) are allowed
  app.enableCors({
    origin: configService.get<string[]>('app.cors.origin', ['http://localhost:3001']),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Tenant-ID', 'X-Request-ID', 'X-Idempotency-Key'],
    exposedHeaders: ['X-Request-ID'],
  });

  // ── Global Prefix ─────────────────────────────────────────────
  app.setGlobalPrefix(apiPrefix);

  // ── Global Validation Pipe ────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,              // Strip undeclared properties
      forbidNonWhitelisted: true,   // Throw 400 on undeclared properties
      transform: true,              // Auto-transform to DTO class instances
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // ── Swagger ───────────────────────────────────────────────────
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Beba SACCO API')
    .setDescription(
      '**Production-ready REST API for Beba SACCO**\n\n' +
      'All endpoints (except health) require the **X-Tenant-ID** header.\n' +
      'Protected endpoints also require **Authorization: Bearer <access_token>**.',
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'Authorization',
        description: 'JWT access token obtained from POST /auth/login',
        in: 'header',
      },
      'bearer',
    )
    .addApiKey(
      {
        type: 'apiKey',
        name: 'X-Tenant-ID',
        in: 'header',
        description: 'SACCO tenant UUID (required on all non-health routes)',
      },
      'X-Tenant-ID',
    )
    .addTag('Authentication', 'Login, register, token refresh, logout')
    .addTag('Tenants', 'Multi-tenant SACCO management (SUPER_ADMIN only)')
    .addTag('Users', 'User management and profiles')
    .addTag('Members', 'SACCO member management – Phase 2')
    .addTag('Accounts', 'BOSA/FOSA account management – Phase 2')
    .addTag('Loans', 'Loan products, applications, repayments – Phase 2')
    .addTag('M-Pesa', 'M-Pesa STK push and webhooks – Phase 2')
    .addTag('Health', 'Liveness and readiness probes')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
  });

  // ── Prisma Graceful Shutdown ──────────────────────────────────
  const prismaService = app.get(PrismaService);
  await prismaService.enableShutdownHooks(app);

  // ── Graceful SIGTERM/SIGINT shutdown ──────────────────────────
  // Order: stop accepting HTTP → drain BullMQ workers → close Prisma/Redis
  const shutdown = async (signal: string) => {
    const shutdownLogger = app.get(Logger);
    shutdownLogger.log(`${signal} received — starting graceful shutdown`, 'Bootstrap');
    await app.close();        // Closes HTTP server + triggers NestJS lifecycle hooks
    shutdownLogger.log('Graceful shutdown complete', 'Bootstrap');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // ── Start ─────────────────────────────────────────────────────
  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`🚀 Server: http://localhost:${port}/${apiPrefix}`, 'Bootstrap');
  logger.log(`📚 Swagger: http://localhost:${port}/${apiPrefix}/docs`, 'Bootstrap');
  logger.log(`🏥 Health:  http://localhost:${port}/${apiPrefix}/health/ping`, 'Bootstrap');
  logger.log(`🌍 Env: ${nodeEnv}`, 'Bootstrap');
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
