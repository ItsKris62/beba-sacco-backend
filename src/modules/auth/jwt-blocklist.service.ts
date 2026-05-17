/**
 * JWT Blocklist Service
 *
 * Immediate token revocation using Redis.
 * When a user changes password, is force-logged-out, or deactivated,
 * their current access token JTI is added to this blocklist.
 * The JwtStrategy checks the blocklist on EVERY request.
 *
 * Key design:
 *  - Redis key: blocklist:access:{jti}
 *  - TTL: 15 minutes (aligned with access token expiry)
 *  - Memory: Redis auto-expires keys — no manual cleanup needed
 *  - Degraded mode: if Redis is down, blocklist returns false (fail open)
 *    to avoid locking out all users. Audit logs still capture the event.
 *
 * SASRA compliance: token revocation must be effective within seconds.
 * Redis SET is sub-millisecond, so revocation is immediate.
 */
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from '../../common/services/redis.service';

@Injectable()
export class JwtBlocklistService {
  private readonly logger = new Logger(JwtBlocklistService.name);

  /** Redis key prefix for blocked access tokens */
  private readonly PREFIX = 'blocklist:access';

  /** Default TTL = 15 minutes (must match access token expiry) */
  private readonly DEFAULT_TTL_SECONDS = 15 * 60;

  constructor(private readonly redis: RedisService) {}

  /**
   * Add a token JTI to the blocklist.
   * Called on: password change, force logout, user deactivation, password reset.
   *
   * @param jti      The JWT ID (unique per token)
   * @param ttlSec   How long to keep the blocklist entry (default: 15 min)
   */
  async add(jti: string, ttlSec = this.DEFAULT_TTL_SECONDS): Promise<void> {
    const key = this.key(jti);
    const ok = await this.redis.set(key, '1', ttlSec);
    if (!ok) {
      this.logger.error(`Failed to blocklist token ${jti.slice(0, 8)}… — Redis unavailable`);
      // Fail closed: a failed revocation write must not silently succeed.
      // The caller (logout, password-change) should surface this to the client.
      throw new ServiceUnavailableException(
        'Token revocation temporarily unavailable — please try again',
      );
    }
    await this.redis.set(`blocklist:${jti}`, '1', ttlSec);
    this.logger.log(`Token ${jti.slice(0, 8)}… added to blocklist (TTL ${ttlSec}s)`);
  }

  /**
   * Check if a token JTI is blocked.
   * Called by JwtStrategy.validate() on every protected request.
   *
   * @returns true if blocked, false otherwise (or on Redis error — fail open)
   */
  async isBlocked(jti: string): Promise<boolean> {
    const key = this.key(jti);
    try {
      const exists = await this.redis.exists(key);
      return exists;
    } catch (err) {
      this.logger.warn(`Blocklist check failed for ${jti.slice(0, 8)}… — assuming NOT blocked (fail open)`);
      return false;
    }
  }

  /**
   * Batch-add multiple JTIs (e.g. invalidate all user sessions).
   */
  async addMany(jtis: string[], ttlSec = this.DEFAULT_TTL_SECONDS): Promise<void> {
    await Promise.all(jtis.map((jti) => this.add(jti, ttlSec)));
  }

  /**
   * Cleanup: remove expired keys is handled by Redis TTL automatically.
   * This method is provided for manual purging (e.g. GDPR right-to-be-forgotten).
   */
  async cleanup(jti: string): Promise<void> {
    await this.redis.del(this.key(jti));
  }

  private key(jti: string): string {
    return `${this.PREFIX}:${jti}`;
  }
}
