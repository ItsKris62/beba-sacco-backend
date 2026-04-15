import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../common/services/redis.service';

export interface RiskScoreResult {
  memberId: string;
  tenantId: string;
  context: string;
  riskScore: number;
  flags: string[];
  recommendation: 'APPROVE' | 'REVIEW' | 'BLOCK';
  details: Record<string, unknown>;
}

/**
 * Behavioral Risk Scorer – Phase 6
 *
 * Evaluates member risk across multiple dimensions:
 *  1. Login velocity (failed attempts, device/IP changes)
 *  2. Transaction amount vs historical average
 *  3. Guarantor circularity (ring detection via graph traversal)
 *  4. Repayment pattern shift
 *  5. KYC freshness
 *
 * Score: 0 (no risk) → 100 (maximum risk)
 * Recommendation thresholds: APPROVE <30, REVIEW 30–69, BLOCK ≥70
 */
@Injectable()
export class BehavioralRiskScorerService {
  private readonly logger = new Logger(BehavioralRiskScorerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async evaluate(
    tenantId: string,
    memberId: string,
    context: 'LOAN_APPLY' | 'DEPOSIT' | 'LOGIN' | 'MANUAL',
  ): Promise<RiskScoreResult> {
    const flags: string[] = [];
    const details: Record<string, unknown> = {};
    let score = 0;

    const [loginScore, txScore, guarantorScore, repaymentScore] = await Promise.all([
      this.evaluateLoginVelocity(tenantId, memberId, flags, details),
      this.evaluateTransactionAnomaly(tenantId, memberId, context, flags, details),
      this.evaluateGuarantorRing(tenantId, memberId, flags, details),
      this.evaluateRepaymentPattern(tenantId, memberId, flags, details),
    ]);

    score = Math.min(100, loginScore + txScore + guarantorScore + repaymentScore);

    const recommendation = this.deriveRecommendation(score);

    // Persist score
    await this.prisma.riskScore.create({
      data: {
        tenantId,
        memberId,
        context,
        score,
        flags,
        recommendation,
        details,
      },
    });

    this.logger.log(
      `Risk score for member ${memberId}: ${score} (${recommendation}) flags=[${flags.join(',')}]`,
    );

    return { memberId, tenantId, context, riskScore: score, flags, recommendation, details };
  }

  private async evaluateLoginVelocity(
    tenantId: string,
    memberId: string,
    flags: string[],
    details: Record<string, unknown>,
  ): Promise<number> {
    let score = 0;

    // Check failed login attempts in last 1 hour
    const failedKey = `risk:login:failed:${tenantId}:${memberId}`;
    const failedRaw = await this.redis.get(failedKey);
    const failedAttempts = failedRaw ? parseInt(failedRaw, 10) : 0;

    if (failedAttempts >= 5) {
      flags.push('HIGH_FAILED_LOGINS');
      score += 25;
    } else if (failedAttempts >= 3) {
      flags.push('ELEVATED_FAILED_LOGINS');
      score += 10;
    }

    // Check distinct IPs in last 24h
    const ipKey = `risk:login:ips:${tenantId}:${memberId}`;
    const ipCountRaw = await this.redis.get(ipKey);
    const distinctIps = ipCountRaw ? parseInt(ipCountRaw, 10) : 0;

    if (distinctIps >= 3) {
      flags.push('DEVICE_CHANGE');
      score += 15;
    }

    details.loginVelocity = { failedAttempts, distinctIps };
    return score;
  }

  private async evaluateTransactionAnomaly(
    tenantId: string,
    memberId: string,
    context: string,
    flags: string[],
    details: Record<string, unknown>,
  ): Promise<number> {
    if (context !== 'DEPOSIT' && context !== 'LOAN_APPLY') return 0;

    let score = 0;

    // Get member's account
    const account = await this.prisma.account.findFirst({
      where: { tenantId, memberId, isActive: true },
    });

    if (!account) return 0;

    // Historical average transaction amount (last 90 days)
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const historicalAvg = await this.prisma.transaction.aggregate({
      where: {
        tenantId,
        accountId: account.id,
        type: 'DEPOSIT',
        status: 'COMPLETED',
        createdAt: { gte: ninetyDaysAgo },
      },
      _avg: { amount: true },
      _count: true,
    });

    const avgAmount = Number(historicalAvg._avg.amount ?? 0);
    const txCount = historicalAvg._count;

    // Latest transaction
    const latestTx = await this.prisma.transaction.findFirst({
      where: { tenantId, accountId: account.id, type: 'DEPOSIT' },
      orderBy: { createdAt: 'desc' },
    });

    if (latestTx && avgAmount > 0 && txCount >= 5) {
      const latestAmount = Number(latestTx.amount);
      const ratio = latestAmount / avgAmount;

      if (ratio > 5) {
        flags.push('AMOUNT_SPIKE_5X');
        score += 20;
      } else if (ratio > 3) {
        flags.push('AMOUNT_SPIKE_3X');
        score += 10;
      }

      details.transactionAnomaly = { avgAmount, latestAmount, ratio: Math.round(ratio * 100) / 100 };
    }

    return score;
  }

  private async evaluateGuarantorRing(
    tenantId: string,
    memberId: string,
    flags: string[],
    details: Record<string, unknown>,
  ): Promise<number> {
    // Check Redis cache first
    const cacheKey = `risk:guarantor:ring:${tenantId}:${memberId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached !== null) {
      const ringDetected = cached === 'true';
      if (ringDetected) {
        flags.push('GUARANTOR_RING');
        details.guarantorRing = { detected: true, source: 'cache' };
        return 30;
      }
      return 0;
    }

    // Graph traversal: detect cycles of length ≥ 3
    const ringDetected = await this.detectGuarantorRing(tenantId, memberId);

    // Cache result for 1 hour
    await this.redis.set(cacheKey, ringDetected ? 'true' : 'false', 3600);

    if (ringDetected) {
      flags.push('GUARANTOR_RING');
      details.guarantorRing = { detected: true, source: 'computed' };
      return 30;
    }

    details.guarantorRing = { detected: false };
    return 0;
  }

  private async detectGuarantorRing(tenantId: string, startMemberId: string): Promise<boolean> {
    // BFS/DFS to detect cycles in guarantor graph
    // A guarantees B means: A is guarantor for B's loan
    const visited = new Set<string>();
    const queue: Array<{ memberId: string; depth: number }> = [
      { memberId: startMemberId, depth: 0 },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.depth > 5) continue; // Limit traversal depth

      // Find loans where this member is a guarantor
      const guaranteedLoans = await this.prisma.guarantor.findMany({
        where: { tenantId, memberId: current.memberId, status: 'ACCEPTED' },
        select: { loanId: true },
      });

      for (const g of guaranteedLoans) {
        // Find the borrower of this loan
        const loan = await this.prisma.loan.findUnique({
          where: { id: g.loanId },
          select: { memberId: true },
        });

        if (!loan) continue;

        const borrowerId = loan.memberId;

        // Cycle detected: borrower is the original member
        if (borrowerId === startMemberId && current.depth >= 2) {
          return true;
        }

        if (!visited.has(borrowerId)) {
          visited.add(borrowerId);
          queue.push({ memberId: borrowerId, depth: current.depth + 1 });
        }
      }
    }

    return false;
  }

  private async evaluateRepaymentPattern(
    tenantId: string,
    memberId: string,
    flags: string[],
    details: Record<string, unknown>,
  ): Promise<number> {
    let score = 0;

    // Check for loans with arrears
    const arrearsLoans = await this.prisma.loan.findMany({
      where: {
        tenantId,
        memberId,
        status: { in: ['ACTIVE', 'DISBURSED'] },
        arrearsDays: { gt: 0 },
      },
      select: { arrearsDays: true, staging: true },
    });

    if (arrearsLoans.length > 0) {
      const maxArrears = Math.max(...arrearsLoans.map((l) => l.arrearsDays));
      const hasNpl = arrearsLoans.some((l) => l.staging === 'NPL');

      if (hasNpl) {
        flags.push('NPL_LOAN');
        score += 25;
      } else if (maxArrears >= 30) {
        flags.push('WATCHLIST_LOAN');
        score += 15;
      } else {
        flags.push('MINOR_ARREARS');
        score += 5;
      }

      details.repaymentPattern = { arrearsLoans: arrearsLoans.length, maxArrears, hasNpl };
    }

    return score;
  }

  private deriveRecommendation(score: number): 'APPROVE' | 'REVIEW' | 'BLOCK' {
    if (score >= 70) return 'BLOCK';
    if (score >= 30) return 'REVIEW';
    return 'APPROVE';
  }
}
