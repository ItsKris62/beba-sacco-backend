import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

/**
 * Redis Service – ioredis wrapper optimised for Upstash Redis
 *
 * Connection strategy:
 *  - Uses ioredis TCP over TLS (required by Upstash)
 *  - enableAutoPipelining: true  → batches concurrent commands automatically
 *  - maxRetriesPerRequest: null  → required by BullMQ-compatible connections
 *  - Custom retry strategy with exponential back-off (capped at 10 s)
 *
 * Used by:
 *  - IdempotencyMiddleware   (24 h dedup keys)
 *  - MpesaService            (Daraja OAuth token cache, ~50 min TTL)
 *  - VelocityService         (velocity counters, distributed locks)
 *  - FinancialService        (accrual / recon distributed locks)
 *  - AnalyticsService        (PubSub cross-instance sync)
 *  - FeatureFlagService      (hot-reload PubSub)
 *  - DynamicRuleEngineService(hot-reload PubSub)
 *  - SloTrackerService       (SLO metrics)
 *  - FinOpsService           (cost tracking counters)
 *
 * Connection errors are logged but do NOT crash the app — all callers must
 * handle `null` / `false` returns gracefully (degraded mode).
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly client: Redis;
  private readonly logger = new Logger(RedisService.name);

  constructor(private readonly config: ConfigService) {
    const host = config.get<string>('app.redis.host', 'localhost');
    const port = config.get<number>('app.redis.port', 6379);
    const password = config.get<string>('app.redis.password');
    const tls = config.get<boolean>('app.redis.tls', false);

    // Track whether we've already given up on Redis to suppress repeated logs
    let redisGaveUp = false;

    const redisOptions: RedisOptions = {
      host,
      port,
      password: password || undefined,
      // Upstash requires TLS; local dev uses plain TCP
      tls: tls ? { rejectUnauthorized: false } : undefined,
      // Lazy connect — don't block module init if Redis is temporarily unavailable
      lazyConnect: true,
      // Auto-pipeline: batches multiple concurrent commands into a single round-trip
      enableAutoPipelining: true,
      // Keep-alive prevents Upstash from closing idle connections
      keepAlive: 10000,
      // Connection timeout
      connectTimeout: 5000,
      // Command timeout — fail fast rather than hang
      commandTimeout: 3000,
      // Exponential back-off retry strategy (capped at 30 s, max 3 attempts for dev)
      retryStrategy: (times: number) => {
        if (times > 3) {
          if (!redisGaveUp) {
            redisGaveUp = true;
            this.logger.warn(
              `Redis: max reconnect attempts reached — running in degraded mode (no cache/queue)`,
            );
          }
          return null; // stop retrying — do NOT throw, just degrade gracefully
        }
        const delay = Math.min(times * 1000, 5_000);
        this.logger.warn(`Redis: reconnect attempt ${times}, next try in ${delay}ms`);
        return delay;
      },
      // Only reconnect on READONLY (Upstash failover), NOT on ECONNREFUSED
      reconnectOnError: (err: Error) => {
        return err.message.includes('READONLY');
      },
    };

    this.client = new Redis(redisOptions);

    // Attach error handler IMMEDIATELY to prevent "Unhandled error event" crashes
    this.client.on('error', (err: Error) => {
      if (!redisGaveUp) {
        this.logger.warn(`Redis error (non-fatal): ${err.message}`);
      }
    });
    this.client.on('connect', () =>
      this.logger.log(`Redis connected → ${host}:${port} (TLS: ${tls})`),
    );
    this.client.on('ready', () => this.logger.log('Redis client ready'));
    this.client.on('close', () => {
      if (!redisGaveUp) this.logger.warn('Redis connection closed');
    });
    this.client.on('reconnecting', () => {
      if (!redisGaveUp) this.logger.warn('Redis reconnecting…');
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
      this.logger.log('Redis: explicit connect() succeeded');
    } catch (err) {
      // Non-fatal — app continues in degraded mode
      this.logger.error(`Redis: initial connect() failed — ${(err as Error).message}`);
    }
  }

  // ─── Core Commands ────────────────────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (err) {
      this.logger.warn(`Redis GET failed for key "${key}": ${(err as Error).message}`);
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
      this.logger.warn(`Redis SET failed for key "${key}": ${(err as Error).message}`);
      return false;
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      this.logger.warn(`Redis DEL failed for key "${key}": ${(err as Error).message}`);
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
   *
   * NOTE: The EXPIRE is NOT atomic with the INCR here. Use `incrWithExpireAt`
   * for strict atomicity when expiry correctness is critical (e.g. rate limits).
   */
  async incr(key: string, ttlSeconds?: number): Promise<number> {
    try {
      const value = await this.client.incr(key);
      if (value === 1 && ttlSeconds) {
        await this.client.expire(key, ttlSeconds);
      }
      return value;
    } catch (err) {
      this.logger.warn(`Redis INCR failed for key "${key}": ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * Atomic INCR + EXPIREAT in a single pipeline round-trip.
   *
   * Unlike `incr()`, this method sets the TTL on EVERY call, not just when
   * value === 1. This prevents a race where the process crashes between INCR
   * and EXPIRE leaving a key with no TTL (leaked counter).
   *
   * @param key          Redis key to increment
   * @param expiresAtMs  Unix timestamp in milliseconds when the key should expire
   * @returns            New counter value, or 0 on error (fail open)
   */
  async incrWithExpireAt(key: string, expiresAtMs: number): Promise<number> {
    try {
      const pipeline = this.client.pipeline();
      pipeline.incr(key);
      pipeline.pexpireat(key, expiresAtMs);
      const results = await pipeline.exec();
      // results[0] = [error, incrValue]
      const incrResult = results?.[0];
      if (incrResult && !incrResult[0]) {
        return incrResult[1] as number;
      }
      return 0;
    } catch (err) {
      this.logger.warn(`Redis INCR+EXPIREAT failed for key "${key}": ${(err as Error).message}`);
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
    } catch (err) {
      this.logger.warn(`Redis INCRBY failed for key "${key}": ${(err as Error).message}`);
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
      this.logger.warn(`Redis EXPIRE failed for key "${key}": ${(err as Error).message}`);
    }
  }

  /**
   * Get the remaining TTL of a key in seconds.
   * Returns -2 if key does not exist, -1 if key has no TTL.
   */
  async ttl(key: string): Promise<number> {
    try {
      return await this.client.ttl(key);
    } catch {
      return -2;
    }
  }

  /**
   * Delete multiple keys matching a pattern using SCAN (non-blocking).
   * Returns the number of keys deleted.
   */
  async delPattern(pattern: string): Promise<number> {
    const keys = await this.scanKeys(pattern);
    if (keys.length === 0) return 0;
    try {
      await this.client.del(...keys);
      return keys.length;
    } catch (err) {
      this.logger.warn(`Redis DEL pattern "${pattern}" failed: ${(err as Error).message}`);
      return 0;
    }
  }

  // ─── PubSub helpers ───────────────────────────────────────────────────────

  /**
   * Publish a message to a Redis channel.
   * Used for cross-instance analytics sync and feature flag hot-reload.
   */
  async publish(channel: string, message: string): Promise<void> {
    try {
      await this.client.publish(channel, message);
    } catch (err) {
      this.logger.warn(`Redis PUBLISH failed on channel "${channel}": ${(err as Error).message}`);
    }
  }

  /**
   * Create a dedicated subscriber connection.
   *
   * Redis requires a separate connection for subscribe mode — a subscribed
   * client cannot issue regular commands.  The duplicate inherits all
   * connection options (host, port, password, TLS) from the primary client.
   *
   * NOTE: Upstash free-tier limits concurrent connections to 100.
   * Callers should reuse the subscriber instance rather than calling this
   * repeatedly.
   */
  createSubscriber(): Redis {
    const subscriber = this.client.duplicate();
    subscriber.on('error', (err: Error) =>
      this.logger.error(`Redis subscriber error: ${err.message}`),
    );
    return subscriber;
  }

  // ─── JSON helpers ─────────────────────────────────────────────────────────

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.logger.warn(`Redis getJson: failed to parse JSON for key "${key}"`);
      return null;
    }
  }

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
    return this.set(key, JSON.stringify(value), ttlSeconds);
  }

  // ─── Scan helpers ─────────────────────────────────────────────────────────

  /**
   * Scan keys matching a pattern (non-blocking cursor-based SCAN).
   *
   * Upstash note: SCAN is supported but each call counts as a command.
   * Use sparingly in hot paths; prefer structured key naming to avoid scans.
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

  // ─── Health ───────────────────────────────────────────────────────────────

  /**
   * Ping the Redis server. Returns true if the server responds with PONG.
   */
  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Expose the underlying ioredis client for advanced use-cases
   * (e.g. BullMQ connection sharing, Lua scripts).
   */
  getClient(): Redis {
    return this.client;
  }

  onModuleDestroy(): void {
    this.client.disconnect();
    this.logger.log('Redis client disconnected (module destroy)');
  }
}
