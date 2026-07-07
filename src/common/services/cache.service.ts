import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(private readonly redis: RedisService) {}

  async invalidateTenantDashboard(tenantId: string): Promise<void> {
    await Promise.all([
      this.redis.del(`admin:stats:${tenantId}`),
      this.redis.delPattern(`cache:${tenantId}:*dashboard*`),
      this.redis.delPattern(`DASH:${tenantId}:*`),
    ]).catch((error: unknown) => {
      this.logger.warn(
        `Dashboard cache invalidation failed for tenant=${tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
}