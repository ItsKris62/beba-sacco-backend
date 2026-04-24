import { Injectable, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerStorage, ThrottlerModuleOptions } from '@nestjs/throttler';
import { RATE_LIMIT_TIER_KEY, RateLimitTierValue } from '../decorators/rate-limit-tier.decorator';
import type { Request } from 'express';

const TIER_LIMITS: Record<RateLimitTierValue, { limit: number; ttl: number }> = {
  internal: { limit: 1000, ttl: 60_000 },
  partner:  { limit: 500,  ttl: 60_000 },
  public:   { limit: 60,   ttl: 60_000 },
};

/**
 * RateLimitTierGuard – Phase 4
 *
 * Extends ThrottlerGuard to honour the `@RateLimitTier()` decorator and
 * the `X-Rate-Limit-Tier` request header for partner tier overrides.
 *
 * Falls back to the global ThrottlerModule config when no tier is set.
 */
@Injectable()
export class RateLimitTierGuard extends ThrottlerGuard {
  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as Request & { user?: { id?: string } };
    return request.user?.id ?? request.ip ?? 'anonymous';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const classRef = context.getClass();

    // Resolve tier from decorator or header
    const decoratorTier =
      this.reflector.get<RateLimitTierValue>(RATE_LIMIT_TIER_KEY, handler) ??
      this.reflector.get<RateLimitTierValue>(RATE_LIMIT_TIER_KEY, classRef);

    const req = context.switchToHttp().getRequest<Request>();
    const headerTier = req.headers['x-rate-limit-tier'] as RateLimitTierValue | undefined;
    const effectiveTier = headerTier ?? decoratorTier;

    if (effectiveTier && TIER_LIMITS[effectiveTier]) {
      // Temporarily override the throttler options for this request
      const { limit, ttl } = TIER_LIMITS[effectiveTier];
      // Store on request so handleRequest can read it
      (req as Request & { _rateLimitOverride?: { limit: number; ttl: number } })._rateLimitOverride =
        { limit, ttl };
    }

    return super.canActivate(context);
  }
}
