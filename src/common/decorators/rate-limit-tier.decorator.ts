import { SetMetadata } from '@nestjs/common';

/**
 * Rate-limit tiers for API governance (Phase 4).
 *
 * Applied per-route to override the global ThrottlerGuard limit.
 * The `RateLimitTierGuard` reads this metadata and enforces the right bucket.
 *
 * Tiers:
 *   internal: 1000 req/min  – server-to-server integrations
 *   partner:   500 req/min  – verified partner organisations
 *   public:     60 req/min  – unauthenticated / public callers (default)
 *
 * Usage:
 *   @RateLimitTier('partner')
 *   @Get('data')
 *   getData() { ... }
 */
export type RateLimitTierValue = 'internal' | 'partner' | 'public';

export const RATE_LIMIT_TIER_KEY = 'rateLimitTier';

export const RateLimitTier = (tier: RateLimitTierValue) =>
  SetMetadata(RATE_LIMIT_TIER_KEY, tier);
