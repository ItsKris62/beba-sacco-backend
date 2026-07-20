/**
 * Idempotency Service
 *
 * Prevents duplicate processing of mutation endpoints using Redis SET NX.
 * Key pattern: idempotency:{tenantId}:{key}
 *
 * Flow:
 *   1. Client generates idempotency key (e.g. UUID) per user action
 *   2. Client sends X-Idempotency-Key header
 *   3. Backend calls checkAndReserve() — if NEW, proceeds; if PROCESSING/COMPLETED, returns cached
 *   4. On success, backend calls complete() to store the response
 *   5. On failure, backend calls release() to allow retry
 *
 * TTL strategy:
 *   - loan:apply      → 24 hours (financial decision — long window)
 *   - guarantor:respond → 1 hour (quick decision)
 *   - deposit:stk     → 2 minutes (STK timeout)
 *   - default         → 1 hour
 *
 * SASRA compliance: all financial mutations must be idempotent.
 */
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';

export type IdempotencyStatus = 'NEW' | 'PROCESSING' | 'COMPLETED';

export interface IdempotencyResult<T = unknown> {
  status: IdempotencyStatus;
  result?: T;
}

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly PREFIX = 'idempotency';

  constructor(private readonly redis: RedisService) {}

  /**
   * Atomically reserve an idempotency key.
   *
   * @returns
   *   NEW       → caller should proceed with the operation
   *   PROCESSING→ another request is in-flight; caller should wait and retry
   *   COMPLETED → operation already finished; caller should return cached result
   */
  async checkAndReserve(
    key: string,
    tenantId: string,
    ttlSeconds = 3600,
  ): Promise<IdempotencyResult> {
    const redisKey = this.buildKey(key, tenantId);

    // Try to reserve with SET NX (only set if key does NOT exist)
    const reserved = await this.redis.set(
      redisKey,
      JSON.stringify({ status: 'PROCESSING' }),
      ttlSeconds,
      true,
    );

    if (reserved) {
      this.logger.debug(`Idempotency NEW: ${redisKey}`);
      return { status: 'NEW' };
    }

    // Key exists — read current status
    const raw = await this.redis.get(redisKey);
    if (!raw) {
      // Race: key expired between SET NX and GET — treat as NEW
      return { status: 'NEW' };
    }

    try {
      const parsed = JSON.parse(raw) as { status: string; result?: unknown };
      if (parsed.status === 'COMPLETED') {
        this.logger.log(`Idempotency COMPLETED hit: ${redisKey}`);
        return { status: 'COMPLETED', result: parsed.result };
      }
      this.logger.debug(`Idempotency PROCESSING hit: ${redisKey}`);
      return { status: 'PROCESSING' };
    } catch {
      // Corrupted data — overwrite and proceed
      await this.redis.set(redisKey, JSON.stringify({ status: 'PROCESSING' }), ttlSeconds);
      return { status: 'NEW' };
    }
  }

  async acquire(key: string, tenantId: string, ttlSeconds = 3600): Promise<boolean> {
    const redisKey = this.buildKey(key, tenantId);
    return this.redis.set(redisKey, JSON.stringify({ status: 'PROCESSING' }), ttlSeconds, true);
  }

  async getResult<T>(key: string, tenantId: string): Promise<T | null> {
    const raw = await this.redis.get(this.buildKey(key, tenantId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { status: string; result?: T };
      return parsed.status === 'COMPLETED' && parsed.result !== undefined ? parsed.result : null;
    } catch {
      return null;
    }
  }

  async storeResult<T>(key: string, tenantId: string, result: T, ttlSeconds = 3600): Promise<void> {
    await this.complete(key, tenantId, result, ttlSeconds);
  }

  /**
   * Store the final response for replay on duplicate requests.
   */
  async complete<T>(key: string, tenantId: string, result: T, ttlSeconds = 3600): Promise<void> {
    const redisKey = this.buildKey(key, tenantId);
    await this.redis.set(redisKey, JSON.stringify({ status: 'COMPLETED', result }), ttlSeconds);
    this.logger.debug(`Idempotency COMPLETED: ${redisKey}`);
  }

  /**
   * Release the lock on error so the client can retry.
   * Use with caution — only release on deterministic failures (validation errors),
   * NOT on transient errors (DB timeout) where retry might succeed.
   */
  async release(key: string, tenantId: string): Promise<void> {
    const redisKey = this.buildKey(key, tenantId);
    await this.redis.del(redisKey);
    this.logger.debug(`Idempotency RELEASED: ${redisKey}`);
  }

  /**
   * Check whether a key currently exists (PROCESSING or COMPLETED), without
   * consuming or modifying it. Added for incident 2026-07-20's one-time admin
   * cleanup endpoint, so it can report whether a release actually did
   * anything rather than always claiming success.
   */
  async exists(key: string, tenantId: string): Promise<boolean> {
    const raw = await this.redis.get(this.buildKey(key, tenantId));
    return raw !== null;
  }

  private buildKey(key: string, tenantId: string): string {
    return `${this.PREFIX}:${tenantId}:${key}`;
  }
}
