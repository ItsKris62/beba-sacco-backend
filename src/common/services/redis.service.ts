import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis Service – ioredis wrapper
 *
 * Used by:
 * - IdempotencyService (24h dedup keys)
 * - MpesaService (Daraja OAuth token cache, ~50 min TTL)
 * - Phase 3+: auth JTI blocklist, tenant lookup cache
 *
 * Connection errors are logged but do NOT crash the app — all callers must
 * handle `null` returns gracefully (degraded mode: bypass cache/idempotency).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;
  private readonly logger = new Logger(RedisService.name);

  constructor(private readonly config: ConfigService) {
    this.client = new Redis({
      host: config.get<string>('app.redis.host', 'localhost'),
      port: config.get<number>('app.redis.port', 6379),
      password: config.get<string>('app.redis.password'),
      tls: config.get<boolean>('app.redis.tls') ? {} : undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      connectTimeout: 5000,
    });

    this.client.on('error', (err: Error) =>
      this.logger.error('Redis connection error (non-fatal)', err.message),
    );
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      if (ttlSeconds) {
        await this.client.setex(key, ttlSeconds, value);
      } else {
        await this.client.set(key, value);
      }
    } catch (err) {
      this.logger.warn(`Redis set failed for key ${key}`, err);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      this.logger.warn(`Redis del failed for key ${key}`, err);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const n = await this.client.exists(key);
      return n > 0;
    } catch {
      return false;
    }
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
