import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { RedisService } from '../../common/services/redis.service';

/**
 * VelocityService – Phase 4
 *
 * Redis-backed velocity counters that enforce per-user rate rules:
 *   - Deposits:         > 3 in 5 min    → block
 *   - Loan apps:        > 2 in 24 h     → block
 *   - Guarantor invites:> 5 in 10 min   → block
 *   - Login attempts:   > 10 in 15 min  → block (brute-force)
 *
 * Keys use `ipHash` (SHA-256 of IP) instead of raw IP to avoid storing PII.
 * Each key has a TTL matching the window, so it self-expires.
 */

export enum VelocityAction {
  DEPOSIT = 'deposit',
  LOAN_APP = 'loan_app',
  GUARANTOR_INVITE = 'guarantor_invite',
  LOGIN = 'login',
}

interface VelocityRule {
  windowSeconds: number;
  maxCount: number;
}

const RULES: Record<VelocityAction, VelocityRule> = {
  [VelocityAction.DEPOSIT]:          { windowSeconds: 300,   maxCount: 3 },
  [VelocityAction.LOAN_APP]:         { windowSeconds: 86400, maxCount: 2 },
  [VelocityAction.GUARANTOR_INVITE]: { windowSeconds: 600,   maxCount: 5 },
  [VelocityAction.LOGIN]:            { windowSeconds: 900,   maxCount: 10 },
};

export interface VelocityCheckResult {
  allowed: boolean;
  action: VelocityAction;
  current: number;
  limit: number;
  windowSeconds: number;
  resetInSeconds?: number;
}

@Injectable()
export class VelocityService {
  private readonly logger = new Logger(VelocityService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Increment the counter for (userId, action) and check if within limit.
   * @param userId  User performing the action
   * @param action  One of VelocityAction
   * @param ipRaw   Raw IP string (will be hashed before storage)
   * @returns VelocityCheckResult – call `.allowed` to gate the request
   */
  async check(
    userId: string,
    action: VelocityAction,
    ipRaw?: string,
  ): Promise<VelocityCheckResult> {
    const rule = RULES[action];
    const ipHash = ipRaw ? createHash('sha256').update(ipRaw).digest('hex').slice(0, 16) : 'unknown';
    const key = `velocity:${action}:${userId}:${ipHash}`;

    // Atomic increment + set TTL on first write
    const current = await this.redis.incr(key, rule.windowSeconds);

    const allowed = current <= rule.maxCount;

    if (!allowed) {
      this.logger.warn(
        `Velocity breach: userId=${userId} action=${action} count=${current} limit=${rule.maxCount} ip=${ipHash}`,
      );
    }

    return {
      allowed,
      action,
      current,
      limit: rule.maxCount,
      windowSeconds: rule.windowSeconds,
    };
  }

  /**
   * Reset velocity counter (e.g., after an admin override).
   */
  async reset(userId: string, action: VelocityAction, ipRaw?: string): Promise<void> {
    const ipHash = ipRaw ? createHash('sha256').update(ipRaw).digest('hex').slice(0, 16) : 'unknown';
    const key = `velocity:${action}:${userId}:${ipHash}`;
    await this.redis.del(key);
  }
}
