import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis Service – ioredis wrapper
 *
 * Used by:
 * - IdempotencyMiddleware (24h dedup keys)
 * - MpesaService (Daraja OAuth token cache, ~50 min TTL)
 * - Phase 4: velocity counters, distributed locks for accrual/recon jobs
 * - Phase 6: PubSub for cross-instance analytics sync, feature flag hot-reload
 *
 * Connection errors are logged but do NOT crash the app — all callers must
 * handle `null` / `false` returns gracefully (degraded mode).
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

  /**
   * SET key value [EX ttl] [NX]
   *
   * @param key
   * @param value
   * @param ttlSeconds  Optional TTL in seconds
   * @param nx          If true, uses SET NX (only set if key does NOT exist).
   *                    Returns true when the key was set, false when it already existed.
   *                    When false (default), always sets and returns true.
   */
  async set(key: string, value: string, ttlSeconds?: number, nx?: boolean): Promise<boolean> {
    try {
      if (nx && ttlSeconds) {
        const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
        return result === 'OK';
      }
      if (ttlSeconds) {
        await this.client.setex(key, ttlSeconds, value);
      } else {
        await this.client.set(key, value);
      }
      return true;
    } catch (err) {
      this.logger.warn(`Redis set failed for key ${key}`, err);
      return false;
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

  /**
   * Atomic INCR + set TTL on first write (for velocity counters).
   * Returns the new counter value.  Returns 0 on Redis error (fail open).
   */
  async incr(key: string, ttlSeconds?: number): Promise<number> {
    try {
      const value = await this.client.incr(key);
      if (value === 1 && ttlSeconds) {
        await this.client.expire(key, ttlSeconds);
      }
      return value;
    } catch {
      return 0;
    }
  }

  /**
   * Atomic INCRBY – increment by a specific amount.
   * Returns the new counter value. Returns 0 on Redis error (fail open).
   */
  async incrBy(key: string, amount: number, ttlSeconds?: number): Promise<number> {
    try {
      const value = await this.client.incrby(key, amount);
      if (value === amount && ttlSeconds) {
        await this.client.expire(key, ttlSeconds);
      }
      return value;
    } catch {
      return 0;
    }
  }

  /**
   * Set TTL on an existing key.
   */
  async expire(key: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.expire(key, ttlSeconds);
    } catch (err) {
      this.logger.warn(`Redis expire failed for key ${key}`, err);
    }
  }

  // ─── Phase 6: PubSub helpers ──────────────────────────────────────────────

  /**
   * Publish a message to a Redis channel.
   * Used for cross-instance analytics sync and feature flag hot-reload.
   */
  async publish(channel: string, message: string): Promise<void> {
    try {
      await this.client.publish(channel, message);
    } catch (err) {
      this.logger.warn(`Redis publish failed on channel ${channel}`, err);
    }
  }

  /**
   * Create a dedicated subscriber connection (Redis requires a separate
   * connection for subscribe mode).
   */
  createSubscriber(): Redis {
    return this.client.duplicate();
  }

  /**
   * Get/set JSON values with optional TTL.
   */
  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
    return this.set(key, JSON.stringify(value), ttlSeconds);
  }

  /**
   * Scan keys matching a pattern (non-blocking, uses SCAN cursor).
   */
  async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
