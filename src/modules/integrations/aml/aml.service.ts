import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../outbox/outbox.service';
import { QUEUE_NAMES, AmlScreenJobPayload } from '../../queue/queue.constants';

/**
 * AML/CFT Screening Service – Phase 5
 *
 * Screens members against UN/EU/OFAC sanctions lists and PEP databases.
 * Triggered on:
 *   - New KYC registration
 *   - Large deposits (>KES 1,000,000)
 *   - Manual compliance officer request
 *
 * Returns riskScore (0–100), status (CLEAR/FLAGGED/BLOCKED), and watchlistMatches.
 *
 * Production: Replace mock screening with actual sanctions API integration
 * (e.g., ComplyAdvantage, Refinitiv World-Check, or local KRA/FRC databases).
 */

// ── Mock sanctions/PEP data (production: external API) ──────────────────────
const MOCK_SANCTIONS_LIST = [
  { name: 'John Doe Sanctioned', nationalId: 'SANCTIONED001', source: 'UN', type: 'SANCTIONS' },
  { name: 'Jane PEP Example', nationalId: 'PEP001', source: 'LOCAL_PEP', type: 'PEP' },
];

const MOCK_PEP_LIST = [
  { name: 'Political Figure A', nationalId: 'PEP002', source: 'KENYA_PEP', type: 'PEP', role: 'Governor' },
];

@Injectable()
export class AmlService {
  private readonly logger = new Logger(AmlService.name);

  /** Threshold for large deposit screening (KES) */
  private readonly LARGE_DEPOSIT_THRESHOLD = 1_000_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    @InjectQueue(QUEUE_NAMES.AML_SCREEN)
    private readonly amlQueue: Queue<AmlScreenJobPayload>,
  ) {}

  /**
   * POST /integrations/aml/screen
   * Initiates an AML/CFT screening for a member.
   */
  async initiateScreening(params: {
    tenantId: string;
    memberId: string;
    trigger: 'KYC' | 'DEPOSIT' | 'MANUAL';
    triggerRef?: string;
  }) {
    const { tenantId, memberId, trigger, triggerRef } = params;

    // Verify member exists
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, tenantId },
      select: { id: true, memberNumber: true, nationalId: true },
    });

    if (!member) {
      throw new NotFoundException('Member not found');
    }

    // Create screening record
    const screening = await this.prisma.amlScreening.create({
      data: {
        tenantId,
        memberId,
        trigger,
        triggerRef,
        status: 'PENDING',
      },
    });

    // Create outbox entry for guaranteed processing
    const outboxEntry = await this.outbox.createEntry({
      tenantId,
      idempotencyKey: `aml-screen-${screening.id}`,
      integrationType: 'AML_SCREEN',
      payload: {
        screeningId: screening.id,
        memberId,
        trigger,
        triggerRef,
      },
      maxAttempts: 3,
    });

    await this.prisma.amlScreening.update({
      where: { id: screening.id },
      data: { outboxId: outboxEntry.id },
    });

    this.logger.log(`AML screening initiated: ${screening.id} for member ${memberId} trigger=${trigger}`);

    return {
      screeningId: screening.id,
      memberId,
      trigger,
      status: 'PENDING',
    };
  }

  /**
   * Process an AML screening job (called by queue processor).
   * Screens member against sanctions/PEP lists and computes risk score.
   */
  async processScreening(screeningId: string): Promise<{
    riskScore: number;
    status: string;
    watchlistMatches: Array<Record<string, unknown>>;
  }> {
    const screening = await this.prisma.amlScreening.findUnique({
      where: { id: screeningId },
    });

    if (!screening) {
      throw new NotFoundException(`AML screening ${screeningId} not found`);
    }

    // Fetch member details for screening
    const member = await this.prisma.member.findUnique({
      where: { id: screening.memberId },
      include: {
        user: { select: { firstName: true, lastName: true } },
      },
    });

    if (!member) {
      throw new NotFoundException(`Member ${screening.memberId} not found`);
    }

    // ── MOCK: Screen against sanctions/PEP lists ─────────────────
    // Production: Call external API (ComplyAdvantage, World-Check, etc.)
    const matches = this.mockScreenMember({
      nationalId: member.nationalId,
      firstName: member.user.firstName,
      lastName: member.user.lastName,
    });

    // Calculate risk score
    const riskScore = this.calculateRiskScore(matches, screening.trigger);

    // Determine status based on risk score
    let status: 'CLEAR' | 'FLAGGED' | 'BLOCKED';
    if (riskScore >= 80) {
      status = 'BLOCKED';
    } else if (riskScore >= 40) {
      status = 'FLAGGED';
    } else {
      status = 'CLEAR';
    }

    // Update screening record
    await this.prisma.amlScreening.update({
      where: { id: screeningId },
      data: {
        riskScore,
        status,
        watchlistMatches: matches as unknown as Prisma.InputJsonValue,
        screenedAt: new Date(),
      },
    });

    this.logger.log(
      `AML screening ${screeningId} completed: score=${riskScore} status=${status} matches=${matches.length}`,
    );

    return { riskScore, status, watchlistMatches: matches };
  }

  /**
   * Get screening results for a member.
   */
  async getScreenings(tenantId: string, memberId?: string) {
    return this.prisma.amlScreening.findMany({
      where: {
        tenantId,
        ...(memberId && { memberId }),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /**
   * Get a single screening result.
   */
  async getScreening(screeningId: string, tenantId: string) {
    const screening = await this.prisma.amlScreening.findFirst({
      where: { id: screeningId, tenantId },
    });

    if (!screening) {
      throw new NotFoundException('AML screening not found');
    }

    return screening;
  }

  /**
   * Check if a deposit amount triggers AML screening.
   */
  shouldScreenDeposit(amount: number): boolean {
    return amount >= this.LARGE_DEPOSIT_THRESHOLD;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private mockScreenMember(params: {
    nationalId: string | null;
    firstName: string;
    lastName: string;
  }): Array<Record<string, unknown>> {
    const matches: Array<Record<string, unknown>> = [];
    const fullName = `${params.firstName} ${params.lastName}`.toLowerCase();

    // Check sanctions list
    for (const entry of MOCK_SANCTIONS_LIST) {
      if (
        (params.nationalId && entry.nationalId === params.nationalId) ||
        entry.name.toLowerCase().includes(fullName)
      ) {
        matches.push({
          matchType: entry.type,
          source: entry.source,
          matchedName: entry.name,
          matchedId: entry.nationalId,
          confidence: 0.95,
        });
      }
    }

    // Check PEP list
    for (const entry of MOCK_PEP_LIST) {
      if (
        (params.nationalId && entry.nationalId === params.nationalId) ||
        entry.name.toLowerCase().includes(fullName)
      ) {
        matches.push({
          matchType: entry.type,
          source: entry.source,
          matchedName: entry.name,
          matchedId: entry.nationalId,
          role: entry.role,
          confidence: 0.85,
        });
      }
    }

    return matches;
  }

  private calculateRiskScore(
    matches: Array<Record<string, unknown>>,
    trigger: string,
  ): number {
    if (matches.length === 0) return 0;

    let score = 0;

    for (const match of matches) {
      const confidence = (match.confidence as number) ?? 0.5;
      if (match.matchType === 'SANCTIONS') {
        score += 50 * confidence;
      } else if (match.matchType === 'PEP') {
        score += 30 * confidence;
      }
    }

    // Boost score for deposit triggers (higher risk context)
    if (trigger === 'DEPOSIT') {
      score *= 1.2;
    }

    return Math.min(Math.round(score), 100);
  }
}
