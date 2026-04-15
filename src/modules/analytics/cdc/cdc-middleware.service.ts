import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { QUEUE_NAMES, AnalyticsStreamJobPayload } from '../../queue/queue.constants';

/**
 * CDC Middleware Service – Phase 6
 *
 * Attaches a Prisma middleware that intercepts INSERT/UPDATE/DELETE operations
 * and emits events to the ANALYTICS_STREAM BullMQ queue.
 *
 * Deduplication: jobId = `${entityType}:${entityId}:${timestamp}` prevents
 * duplicate processing when the same event is emitted multiple times.
 *
 * Tracked entities: Transaction, Loan, Member, Account
 */
@Injectable()
export class CdcMiddlewareService implements OnModuleInit {
  private readonly logger = new Logger(CdcMiddlewareService.name);

  private static readonly TRACKED_MODELS = new Set([
    'Transaction',
    'Loan',
    'Member',
    'Account',
  ]);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.ANALYTICS_STREAM)
    private readonly analyticsQueue: Queue<AnalyticsStreamJobPayload>,
  ) {}

  onModuleInit() {
    this.prisma.$use(async (params, next) => {
      const result = await next(params);

      if (
        params.model &&
        CdcMiddlewareService.TRACKED_MODELS.has(params.model) &&
        params.action &&
        ['create', 'update', 'delete', 'upsert'].includes(params.action)
      ) {
        const operation = this.mapOperation(params.action);
        const entityId = this.extractEntityId(result, params);
        const tenantId = this.extractTenantId(result, params);

        if (entityId && tenantId) {
          const timestamp = new Date().toISOString();
          const jobId = `${params.model}:${entityId}:${timestamp}`;

          const payload: AnalyticsStreamJobPayload = {
            tenantId,
            entityType: params.model,
            entityId,
            operation,
            payload: result as Record<string, unknown>,
            timestamp,
          };

          await this.analyticsQueue
            .add('cdc-event', payload, {
              jobId,
              removeOnComplete: 500,
              removeOnFail: 100,
              attempts: 3,
              backoff: { type: 'exponential', delay: 1000 },
            })
            .catch((err: Error) =>
              this.logger.warn(`CDC queue emit failed: ${err.message}`, { jobId }),
            );
        }
      }

      return result;
    });

    this.logger.log('CDC middleware registered for analytics stream');
  }

  private mapOperation(action: string): 'INSERT' | 'UPDATE' | 'DELETE' {
    if (action === 'create' || action === 'createMany') return 'INSERT';
    if (action === 'delete' || action === 'deleteMany') return 'DELETE';
    return 'UPDATE';
  }

  private extractEntityId(result: unknown, params: { args?: { where?: { id?: string } } }): string | null {
    if (result && typeof result === 'object' && 'id' in result) {
      return (result as { id: string }).id;
    }
    if (params.args?.where?.id) {
      return params.args.where.id;
    }
    return null;
  }

  private extractTenantId(result: unknown, params: { args?: { data?: { tenantId?: string }; where?: { tenantId?: string } } }): string | null {
    if (result && typeof result === 'object' && 'tenantId' in result) {
      return (result as { tenantId: string }).tenantId;
    }
    if (params.args?.data && typeof params.args.data === 'object' && 'tenantId' in params.args.data) {
      return (params.args.data as { tenantId: string }).tenantId;
    }
    return null;
  }
}
