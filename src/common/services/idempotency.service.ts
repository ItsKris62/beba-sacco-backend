import { Injectable, ConflictException } from '@nestjs/common';
import { RedisService } from './redis.service';

const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24 hours
const KEY_PREFIX = 'idempotency:';

export interface IdempotencyResult<T = unknown> {
  isDuplicate: boolean;
  cachedResponse?: T;
}

/**
 * Idempotency Service
 *
 * Implements the X-Idempotency-Key pattern:
 *   1. Client sends X-Idempotency-Key: <uuid> on mutating requests.
 *   2. Before processing, call check() — returns cached response on replay.
 *   3. After successful processing, call store() with the response.
 *   4. Key expires after 24 h (configurable).
 *
 * Critical paths: loan applications, M-Pesa STK push, account deposits.
 *
 * If Redis is unavailable the service degrades gracefully (no dedup) rather
 * than blocking the request — financial operations should still proceed.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly redis: RedisService) {}

  async check<T>(key: string): Promise<IdempotencyResult<T>> {
    const raw = await this.redis.get(`${KEY_PREFIX}${key}`);
    if (!raw) return { isDuplicate: false };

    try {
      return { isDuplicate: true, cachedResponse: JSON.parse(raw) as T };
    } catch {
      return { isDuplicate: false };
    }
  }

  async store(key: string, response: unknown): Promise<void> {
    await this.redis.set(
      `${KEY_PREFIX}${key}`,
      JSON.stringify(response),
      IDEMPOTENCY_TTL_SECONDS,
    );
  }

  /**
   * Guard helper — throws ConflictException if the key is already used.
   * Returns the cached response so callers can return it directly.
   */
  async guardOrThrow<T>(key: string): Promise<T | null> {
    const { isDuplicate, cachedResponse } = await this.check<T>(key);
    if (isDuplicate) {
      throw new ConflictException({
        message: 'Duplicate request — this operation was already processed.',
        cachedResponse,
      });
    }
    return null;
  }
}
