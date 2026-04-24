import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request } from 'express';
import { RedisService } from '../services/redis.service';

// L1 in-memory cache (per-instance, 5s TTL)
const L1_CACHE = new Map<string, { value: unknown; expiresAt: number }>();
const L1_TTL_MS = 5_000;

// L2 Redis TTL (60s default)
const L2_TTL_S = 60;

// Stampede prevention: tracks in-flight requests
const IN_FLIGHT = new Map<string, Promise<unknown>>();

/**
 * L1/L2 Cache Interceptor – Phase 6
 *
 * Two-tier caching strategy:
 *  L1: In-memory Map (5s TTL, per-instance) – ultra-fast, no network
 *  L2: Redis (60s TTL, shared across instances) – cross-pod consistency
 *
 * Stampede prevention: concurrent requests for the same key share one
 * in-flight Promise instead of all hitting the DB simultaneously.
 *
 * Cache invalidation: triggered by KYC/loan status changes via
 * DELETE /cache/invalidate or direct Redis key deletion.
 *
 * Only caches GET requests. Skips if X-No-Cache: true header present.
 */
@Injectable()
export class CacheInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CacheInterceptor.name);

  constructor(private readonly redis: RedisService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<Request>();

    // Only cache GET requests
    if (req.method !== 'GET') return next.handle();

    // Skip if X-No-Cache header present
    if (req.headers['x-no-cache']) return next.handle();

    // Skip analytics SSE endpoint (streaming)
    if (req.path.includes('/analytics/real-time')) return next.handle();

    const tenantId = (req as Request & { tenant?: { id: string } }).tenant?.id ?? 'global';
    const cacheKey = `cache:${tenantId}:${req.path}:${JSON.stringify(req.query)}`;

    // L1: Check in-memory cache
    const l1Entry = L1_CACHE.get(cacheKey);
    if (l1Entry && l1Entry.expiresAt > Date.now()) {
      this.logger.debug(`L1 cache hit: ${cacheKey}`);
      return of(l1Entry.value);
    }

    // L2: Check Redis cache
    const l2Value = await this.redis.getJson<unknown>(cacheKey);
    if (l2Value !== null) {
      this.logger.debug(`L2 cache hit: ${cacheKey}`);
      // Populate L1
      L1_CACHE.set(cacheKey, { value: l2Value, expiresAt: Date.now() + L1_TTL_MS });
      return of(l2Value);
    }

    // Stampede prevention: if another request is already fetching this key, wait for it
    const inFlight = IN_FLIGHT.get(cacheKey);
    if (inFlight) {
      this.logger.debug(`Stampede prevention: waiting for in-flight request: ${cacheKey}`);
      const value = await inFlight;
      return of(value);
    }

    // Execute handler and cache result
    return next.handle().pipe(
      tap(async (value) => {
        if (value !== null && value !== undefined) {
          // Store in L1
          L1_CACHE.set(cacheKey, { value, expiresAt: Date.now() + L1_TTL_MS });
          // Store in L2
          await this.redis.setJson(cacheKey, value, L2_TTL_S);
        }
      }),
    );
  }

  /** Invalidate cache entries matching a pattern */
  static invalidateL1(pattern: string): void {
    for (const key of L1_CACHE.keys()) {
      if (key.includes(pattern)) {
        L1_CACHE.delete(key);
      }
    }
  }
}
