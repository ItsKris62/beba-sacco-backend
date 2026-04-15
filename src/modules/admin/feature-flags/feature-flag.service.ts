import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../common/services/redis.service';

export interface FeatureFlagConfig {
  key: string;
  status: 'ACTIVE' | 'INACTIVE';
  rolloutPct: number;
  tenantIds: string[];
  roles: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Feature Flag Service – Phase 6
 *
 * Redis-backed, hot-reloadable feature toggles.
 * Rules: tenantId, role, percentageRollout.
 *
 * Hot-reload: subscribes to `flags:reload` Redis channel.
 * Cache: flags stored in Redis with 5-minute TTL, DB as source of truth.
 *
 * Usage: @Flag('loan_jipange_v2') decorator guards routes.
 */
@Injectable()
export class FeatureFlagService implements OnModuleInit {
  private readonly logger = new Logger(FeatureFlagService.name);
  private readonly CACHE_PREFIX = 'feature:flag:';
  private readonly CACHE_TTL = 300; // 5 minutes
  private readonly RELOAD_CHANNEL = 'flags:reload';

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.warmCache();
    this.subscribeToReload();
  }

  private async warmCache(): Promise<void> {
    const flags = await this.prisma.featureFlag.findMany({
      where: { status: 'ACTIVE' },
    });

    for (const flag of flags) {
      const config: FeatureFlagConfig = {
        key: flag.key,
        status: flag.status,
        rolloutPct: flag.rolloutPct,
        tenantIds: flag.tenantIds,
        roles: flag.roles,
        metadata: flag.metadata as Record<string, unknown> | undefined,
      };
      await this.redis.setJson(`${this.CACHE_PREFIX}${flag.key}`, config, this.CACHE_TTL);
    }

    this.logger.log(`Warmed feature flag cache: ${flags.length} flags`);
  }

  private subscribeToReload(): void {
    const subscriber = this.redis.createSubscriber();
    subscriber.subscribe(this.RELOAD_CHANNEL, (err) => {
      if (err) this.logger.error(`Feature flag reload subscribe error: ${err.message}`);
    });

    subscriber.on('message', async (_channel: string, message: string) => {
      try {
        const msg = JSON.parse(message) as { type: string; key?: string };
        if (msg.type === 'RELOAD_FLAG' && msg.key) {
          await this.reloadFlag(msg.key);
        } else if (msg.type === 'RELOAD_ALL') {
          await this.warmCache();
        }
      } catch (err) {
        this.logger.warn(`Feature flag reload parse error: ${(err as Error).message}`);
      }
    });
  }

  private async reloadFlag(key: string): Promise<void> {
    const flag = await this.prisma.featureFlag.findUnique({ where: { key } });
    if (flag) {
      const config: FeatureFlagConfig = {
        key: flag.key,
        status: flag.status,
        rolloutPct: flag.rolloutPct,
        tenantIds: flag.tenantIds,
        roles: flag.roles,
        metadata: flag.metadata as Record<string, unknown> | undefined,
      };
      await this.redis.setJson(`${this.CACHE_PREFIX}${key}`, config, this.CACHE_TTL);
      this.logger.log(`Reloaded feature flag: ${key}`);
    } else {
      await this.redis.del(`${this.CACHE_PREFIX}${key}`);
    }
  }

  async isEnabled(
    key: string,
    context: { tenantId?: string; role?: string; userId?: string },
  ): Promise<boolean> {
    const config = await this.getFlag(key);
    if (!config || config.status !== 'ACTIVE') return false;

    // Tenant filter
    if (config.tenantIds.length > 0 && context.tenantId) {
      if (!config.tenantIds.includes(context.tenantId)) return false;
    }

    // Role filter
    if (config.roles.length > 0 && context.role) {
      if (!config.roles.includes(context.role)) return false;
    }

    // Percentage rollout (deterministic by userId hash)
    if (config.rolloutPct < 100 && context.userId) {
      const hash = this.hashUserId(context.userId);
      const bucket = hash % 100;
      if (bucket >= config.rolloutPct) return false;
    }

    return true;
  }

  private async getFlag(key: string): Promise<FeatureFlagConfig | null> {
    // L1: Redis cache
    const cached = await this.redis.getJson<FeatureFlagConfig>(`${this.CACHE_PREFIX}${key}`);
    if (cached) return cached;

    // L2: Database
    const flag = await this.prisma.featureFlag.findUnique({ where: { key } });
    if (!flag) return null;

    const config: FeatureFlagConfig = {
      key: flag.key,
      status: flag.status,
      rolloutPct: flag.rolloutPct,
      tenantIds: flag.tenantIds,
      roles: flag.roles,
      metadata: flag.metadata as Record<string, unknown> | undefined,
    };

    await this.redis.setJson(`${this.CACHE_PREFIX}${key}`, config, this.CACHE_TTL);
    return config;
  }

  async upsertFlag(dto: {
    key: string;
    rollout: number;
    tenantIds?: string[];
    roles?: string[];
    description?: string;
  }): Promise<FeatureFlagConfig> {
    const flag = await this.prisma.featureFlag.upsert({
      where: { key: dto.key },
      create: {
        key: dto.key,
        status: 'ACTIVE',
        rolloutPct: dto.rollout,
        tenantIds: dto.tenantIds ?? [],
        roles: dto.roles ?? [],
        description: dto.description,
      },
      update: {
        rolloutPct: dto.rollout,
        tenantIds: dto.tenantIds ?? [],
        roles: dto.roles ?? [],
        status: 'ACTIVE',
      },
    });

    const config: FeatureFlagConfig = {
      key: flag.key,
      status: flag.status,
      rolloutPct: flag.rolloutPct,
      tenantIds: flag.tenantIds,
      roles: flag.roles,
    };

    // Update cache and broadcast reload
    await this.redis.setJson(`${this.CACHE_PREFIX}${flag.key}`, config, this.CACHE_TTL);
    await this.redis.publish(this.RELOAD_CHANNEL, JSON.stringify({ type: 'RELOAD_FLAG', key: flag.key }));

    return config;
  }

  async listFlags(): Promise<FeatureFlagConfig[]> {
    const flags = await this.prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
    return flags.map((f) => ({
      key: f.key,
      status: f.status,
      rolloutPct: f.rolloutPct,
      tenantIds: f.tenantIds,
      roles: f.roles,
      metadata: f.metadata as Record<string, unknown> | undefined,
    }));
  }

  private hashUserId(userId: string): number {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
    }
    return hash;
  }
}
