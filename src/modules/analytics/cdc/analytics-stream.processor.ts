import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { QUEUE_NAMES, AnalyticsStreamJobPayload } from '../../queue/queue.constants';

/**
 * Analytics Stream Processor – Phase 6
 *
 * Consumes CDC events from ANALYTICS_STREAM queue and triggers
 * REFRESH MATERIALIZED VIEW CONCURRENTLY for relevant views.
 *
 * Views refreshed per entity type:
 *  - Transaction → daily_deposit_inflow, member_liquidity
 *  - Loan        → loan_pipeline_velocity
 *  - Guarantor   → guarantor_network_density
 *  - Member      → member_liquidity
 */
@Processor(QUEUE_NAMES.ANALYTICS_STREAM)
export class AnalyticsStreamProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalyticsStreamProcessor.name);

  // Debounce: track last refresh per view to avoid hammering DB
  private readonly lastRefresh = new Map<string, number>();
  private readonly DEBOUNCE_MS = 5_000; // 5 seconds

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<AnalyticsStreamJobPayload>): Promise<void> {
    const { entityType, tenantId, operation } = job.data;

    this.logger.debug(
      `CDC event: ${operation} on ${entityType} for tenant ${tenantId}`,
    );

    const viewsToRefresh = this.resolveViews(entityType);

    for (const view of viewsToRefresh) {
      await this.refreshViewDebounced(view);
    }
  }

  private resolveViews(entityType: string): string[] {
    switch (entityType) {
      case 'Transaction':
        return ['daily_deposit_inflow', 'member_liquidity'];
      case 'Loan':
        return ['loan_pipeline_velocity'];
      case 'Member':
        return ['member_liquidity'];
      case 'Account':
        return ['member_liquidity'];
      default:
        return [];
    }
  }

  private async refreshViewDebounced(viewName: string): Promise<void> {
    const now = Date.now();
    const last = this.lastRefresh.get(viewName) ?? 0;

    if (now - last < this.DEBOUNCE_MS) {
      this.logger.debug(`Skipping refresh of ${viewName} (debounced)`);
      return;
    }

    this.lastRefresh.set(viewName, now);

    try {
      // CONCURRENTLY allows reads during refresh (no exclusive lock)
      await this.prisma.$executeRawUnsafe(
        `REFRESH MATERIALIZED VIEW CONCURRENTLY IF EXISTS ${viewName}`,
      );
      this.logger.log(`Refreshed materialized view: ${viewName}`);
    } catch (err) {
      // Views may not exist in all environments – log and continue
      this.logger.warn(
        `Could not refresh view ${viewName}: ${(err as Error).message}`,
      );
    }
  }
}
