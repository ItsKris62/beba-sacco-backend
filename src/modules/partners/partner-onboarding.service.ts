/**
 * Phase 7 – Partner Onboarding Workflow
 * KYB validation, contract signing stub, API key generation,
 * scope assignment, rate limit tier assignment.
 */
import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_NAMES } from '../queue/queue.constants';
import * as crypto from 'crypto';
import * as argon2 from 'argon2';

export interface PartnerOnboardRequest {
  tenantId: string;
  name: string;
  scopes: string[];
  slaConfig: {
    p95LatencyMs: number;
    uptimePct: number;
    errorRatePct: number;
  };
  contact: {
    name: string;
    email: string;
    phone?: string;
  };
  rateLimitTier?: 'basic' | 'standard' | 'premium' | 'enterprise';
  ipWhitelist?: string[];
}

export interface PartnerOnboardResult {
  partnerId: string;
  clientId: string;
  clientSecret: string; // Only returned once at creation
  apiKey: string;       // Only returned once at creation
  scopes: string[];
  rateLimitTier: string;
  slaConfig: Record<string, unknown>;
}

@Injectable()
export class PartnerOnboardingService {
  private readonly logger = new Logger(PartnerOnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.PARTNER_PROVISION) private readonly provisionQueue: Queue,
  ) {}

  /**
   * Onboard a new partner: KYB, key generation, scope assignment.
   */
  async onboard(req: PartnerOnboardRequest): Promise<PartnerOnboardResult> {
    // Check for duplicate partner name
    const existing = await this.prisma.partner.findFirst({
      where: { tenantId: req.tenantId, name: req.name },
    });
    if (existing) {
      throw new ConflictException(`Partner "${req.name}" already exists for this tenant`);
    }

    // Generate OAuth2 credentials
    const clientId = `beba_${crypto.randomBytes(12).toString('hex')}`;
    const clientSecret = crypto.randomBytes(32).toString('base64url');
    const apiKey = `beba_live_${crypto.randomBytes(24).toString('base64url')}`;

    // Hash secrets for storage
    const clientSecretHash = await argon2.hash(clientSecret);
    const apiKeyHash = await argon2.hash(apiKey);

    const tier = req.rateLimitTier ?? 'standard';

    // Create partner record
    const partner = await this.prisma.partner.create({
      data: {
        tenantId: req.tenantId,
        name: req.name,
        clientId,
        clientSecretHash,
        apiKeyHash,
        scopes: req.scopes,
        rateLimitTier: tier,
        slaConfig: req.slaConfig as unknown as Prisma.InputJsonValue,
        contactName: req.contact.name,
        contactEmail: req.contact.email,
        contactPhone: req.contact.phone,
        ipWhitelist: req.ipWhitelist ?? [],
        status: 'PENDING_KYB',
      },
    });

    // Queue provisioning job (KYB validation, portal setup, etc.)
    await this.provisionQueue.add(
      'provision-partner',
      {
        partnerId: partner.id,
        tenantId: req.tenantId,
        name: req.name,
        scopes: req.scopes,
        contactEmail: req.contact.email,
      },
      {
        jobId: `provision-${partner.id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );

    this.logger.log(`[Partner] Onboarded partner "${req.name}" (${partner.id}), tier=${tier}`);

    return {
      partnerId: partner.id,
      clientId,
      clientSecret, // Plaintext – only returned once
      apiKey,       // Plaintext – only returned once
      scopes: req.scopes,
      rateLimitTier: tier,
      slaConfig: req.slaConfig as unknown as Record<string, unknown>,
    };
  }

  /**
   * Activate a partner after KYB validation passes.
   */
  async activate(partnerId: string): Promise<void> {
    await this.prisma.partner.update({
      where: { id: partnerId },
      data: { status: 'ACTIVE', activatedAt: new Date() },
    });
    this.logger.log(`[Partner] Activated partner ${partnerId}`);
  }

  /**
   * Suspend a partner (e.g., SLA breach, non-payment).
   */
  async suspend(partnerId: string, reason: string): Promise<void> {
    await this.prisma.partner.update({
      where: { id: partnerId },
      data: { status: 'SUSPENDED', suspendedReason: reason },
    });
    this.logger.log(`[Partner] Suspended partner ${partnerId}: ${reason}`);
  }

  /**
   * Revoke a partner's API key and generate a new one.
   */
  async rotateApiKey(partnerId: string): Promise<{ apiKey: string }> {
    const newApiKey = `beba_live_${crypto.randomBytes(24).toString('base64url')}`;
    const apiKeyHash = await argon2.hash(newApiKey);

    await this.prisma.partner.update({
      where: { id: partnerId },
      data: { apiKeyHash, keyRotatedAt: new Date() },
    });

    this.logger.log(`[Partner] API key rotated for partner ${partnerId}`);
    return { apiKey: newApiKey };
  }

  /**
   * List all partners for a tenant.
   */
  async list(tenantId: string): Promise<unknown[]> {
    return this.prisma.partner.findMany({
      where: { tenantId },
      select: {
        id: true,
        name: true,
        clientId: true,
        scopes: true,
        rateLimitTier: true,
        status: true,
        slaConfig: true,
        contactEmail: true,
        createdAt: true,
        activatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
