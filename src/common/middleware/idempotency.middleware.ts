import { Injectable, NestMiddleware, HttpStatus } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { RedisService } from '../services/redis.service';

const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24 h
const IDEMPOTENCY_KEY_HEADER = 'x-idempotency-key';
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT']);

/**
 * IdempotencyMiddleware – Phase 4
 *
 * For all POST / PATCH / PUT requests that include an `X-Idempotency-Key` header:
 *   1. Check Redis for `idempotency:<tenantId>:<key>`.
 *   2. If found → return the cached response immediately (409 replay guard).
 *   3. If not found → attach a response-finish hook that stores the response
 *      body + status in Redis with a 24 h TTL.
 *
 * Key format: `idempotency:{tenantId}:{key}` – scoped per tenant to prevent
 * cross-tenant key collisions.
 *
 * Skipped for:
 *   - GET / DELETE / HEAD / OPTIONS (safe or non-idempotent by design)
 *   - Requests without the header (idempotency is opt-in)
 *   - /health and /api/metrics endpoints
 */
@Injectable()
export class IdempotencyMiddleware implements NestMiddleware {
  constructor(private readonly redis: RedisService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!MUTATING_METHODS.has(req.method)) return next();

    const idempotencyKey = req.headers[IDEMPOTENCY_KEY_HEADER] as string | undefined;
    if (!idempotencyKey) return next();

    // Skip health / metrics
    const path = req.path;
    if (path.includes('/health') || path.includes('/metrics')) return next();

    const tenantId = (req.headers['x-tenant-id'] as string | undefined) ?? 'global';
    const redisKey = `idempotency:${tenantId}:${idempotencyKey}`;

    // Check for cached response
    const cached = await this.redis.get(redisKey);
    if (cached) {
      let parsed: { status: number; body: unknown };
      try {
        parsed = JSON.parse(cached) as { status: number; body: unknown };
      } catch {
        return next();
      }
      res.setHeader('X-Idempotency-Replayed', 'true');
      res.status(parsed.status).json(parsed.body);
      return;
    }

    // Intercept response to cache it
    const originalJson = res.json.bind(res) as (body: unknown) => Response;
    res.json = (body: unknown): Response => {
      if (res.statusCode < 500) {
        // Only cache successful + 4xx responses; skip 5xx (transient failures)
        const payload = JSON.stringify({ status: res.statusCode, body });
        // Fire-and-forget; don't await
        void this.redis.set(redisKey, payload, IDEMPOTENCY_TTL_SECONDS);
      }
      return originalJson(body);
    };

    next();
  }
}
