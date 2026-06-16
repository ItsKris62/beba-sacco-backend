/**
 * BullMQ Worker Entry Point
 *
 * Dedicated worker process for background job processing.
 * Runs the same NestJS application but without the HTTP server,
 * processing jobs from BullMQ queues only.
 *
 * Usage:
 *   WORKER_MODE=true node dist/main-worker.js
 *
 * Docker:
 *   command: ["node", "dist/main-worker.js"]
 */

import './instrument';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';
import { PrismaService } from './prisma/prisma.service';

async function bootstrapWorker() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));

  const logger = app.get(Logger);
  logger.log('🐂 BullMQ Worker started', 'WorkerBootstrap');

  // Wire Prisma graceful shutdown
  const prismaService = app.get(PrismaService);
  await prismaService.enableShutdownHooks(app as any);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.log(`${signal} received — starting worker graceful shutdown`, 'WorkerBootstrap');
    await app.close();
    logger.log('Worker graceful shutdown complete', 'WorkerBootstrap');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrapWorker().catch((err) => {
  console.error('Fatal worker bootstrap error:', err);
  process.exit(1);
});
