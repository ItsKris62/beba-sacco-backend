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
    const redisUrl = config.get<string>('app.redis.url');
    const parsedRedisUrl = redisUrl ? new URL(redisUrl) : undefined;
    const rawHost = parsedRedisUrl?.hostname ?? config.get<string>('app.redis.host', 'localhost');
    // Strip any accidental protocol prefix — ioredis expects a bare hostname.
    // e.g. "https://foo.upstash.io" → "foo.upstash.io"
    const host = rawHost.replace(/^https?:\/\//, '');
    if (rawHost !== host) {
      this.logger.warn(
        `Redis: REDIS_HOST had a protocol prefix — stripped to "${host}". ` +
          `Fix REDIS_HOST in your env vars to remove the "https://" prefix.`,
      );
    }

    const port = parsedRedisUrl
      ? parseInt(parsedRedisUrl.port || '6379', 10)
      : config.get<number>('app.redis.port', 6379);
    const password = parsedRedisUrl?.password
      ? decodeURIComponent(parsedRedisUrl.password)
      : config.get<string>('app.redis.password');
    const tls = parsedRedisUrl
      ? parsedRedisUrl.protocol === 'rediss:'
      : config.get<boolean>('app.redis.tls', false);

    this.logger.log(
      `Redis: initialising connection → host="${host}" port=${port} tls=${tls} ` +
        `password=${password ? '[SET]' : '[NOT SET]'}`,
    );

    // Set to true on WRONGPASS — stops retryStrategy immediately so we don't
    // burn Upstash command quota retrying a credential that will never work.
    let redisAuthFailed = false;

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
      // Retry forever with exponential back-off (capped at 30 s).
      // Never return null for transient failures — on Render's free tier the service
      // hibernates and kills the TCP connection; ioredis must keep retrying until the
      // network stabilises after wake-up rather than permanently giving up.
      retryStrategy: (times: number) => {
        if (redisAuthFailed) return null; // credential is wrong — retrying wastes quota
        const delay = Math.min(times * 500, 30_000);
        this.logger.warn(`Redis: reconnect attempt ${times}, next try in ${delay}ms`);
        return delay;
      },
      // Reconnect on READONLY (Upstash failover) and ECONNRESET (hibernation wake-up)
      reconnectOnError: (err: Error) => {
        return err.message.includes('READONLY') || err.message.includes('ECONNRESET');
      },
    };

    this.client = new Redis(redisOptions);

    // Attach error handler IMMEDIATELY to prevent "Unhandled error event" crashes
    this.client.on('error', (err: Error) => {
      if (err.message.includes('WRONGPASS') || err.message.includes('NOAUTH')) {
        if (!redisAuthFailed) {
          redisAuthFailed = true;
          this.logger.error(
            `Redis: authentication failed (WRONGPASS) — stopping all retries. ` +
              `Fix REDIS_PASSWORD in your env vars (get it from console.upstash.com → database → Connect).`,
          );
          this.client.disconnect();
        }
        return;
      }
      this.logger.warn(`Redis error (non-fatal): ${err.message}`);
    });
    this.client.on('connect', () =>
      this.logger.log(`Redis connected → ${host}:${port} (TLS: ${tls})`),
    );
    this.client.on('ready', () => this.logger.log('Redis client ready'));
    this.client.on('close', () => this.logger.warn('Redis connection closed'));
    this.client.on('reconnecting', () => this.logger.warn('Redis reconnecting…'));
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

  /**
   * Atomically delete a key only when its current value matches the expected value.
   * Used for one-time feature-flagged upload tokens.
   */
  async consumeIfValue(
    key: string,
    expectedValue: string,
  ): Promise<'consumed' | 'missing' | 'mismatch'> {
    const script = [
      'local v = redis.call("GET", KEYS[1])',
      'if not v then return 0 end',
      'if v ~= ARGV[1] then return -1 end',
      'redis.call("DEL", KEYS[1])',
      'return 1',
    ].join('\n');

    try {
      const result: unknown = await this.client.eval(script, 1, key, expectedValue);
      if (result === 1) return 'consumed';
      if (result === -1) return 'mismatch';
      return 'missing';
    } catch (err) {
      this.logger.warn(`Redis consumeIfValue failed for key "${key}": ${(err as Error).message}`);
      return 'missing';
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
   * Atomically decrements a counter only if its current value is > 0.
   *
   * A single Lua script makes the GET → conditional DECR sequence atomic:
   * no other Redis command can interleave between the read and the write,
   * so the counter can never go negative regardless of concurrent callers.
   *
   * The existing TTL (set by incrWithExpireAt) is preserved — DECR does not
   * touch the key's expiry.
   *
   * Use case: returning a rate-limit slot when a request fails transiently
   * so the member can retry without burning their daily allowance.
   *
   * Returns the new counter value after decrement, or the unchanged value if
   * already 0, or 0 if the key does not exist.
   * Returns 0 on Redis error (fail-open: the counter stays as-is rather than
   * crashing the caller — the member may see a false rate-limit for the rest
   * of the day, which is the safer failure mode).
   */
  async decrIfPositive(key: string): Promise<number> {
    const script = [
      'local v = redis.call("GET", KEYS[1])',
      'if not v then return 0 end',
      'local n = tonumber(v)',
      'if n and n > 0 then return redis.call("DECR", KEYS[1]) end',
      'return n or 0',
    ].join('\n');
    try {
      const result: unknown = await this.client.eval(script, 1, key);
      return typeof result === 'number' ? result : 0;
    } catch (err) {
      this.logger.warn(`Redis decrIfPositive failed for key "${key}": ${(err as Error).message}`);
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
