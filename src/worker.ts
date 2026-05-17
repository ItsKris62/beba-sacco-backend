import './instrument';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { PrismaService } from './prisma/prisma.service';

async function bootstrapWorker(): Promise<void> {
  process.env.WORKER_MODE = process.env.WORKER_MODE ?? 'true';
  const { WorkerModule } = await import('./worker.module');

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));

  const logger = app.get(Logger);
  const prismaService = app.get(PrismaService);
  await prismaService.enableShutdownHooks(app as never);

  logger.log('Worker initialized - BullMQ processors are ready', 'WorkerBootstrap');

  const shutdown = async (signal: string) => {
    logger.log(
      `${signal} received - closing BullMQ workers and shared services`,
      'WorkerBootstrap',
    );
    await app.close();
    logger.log('Worker graceful shutdown complete', 'WorkerBootstrap');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrapWorker().catch((err) => {
  console.error('Fatal worker bootstrap error:', err);
  process.exit(1);
});
