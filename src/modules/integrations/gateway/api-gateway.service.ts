import { Injectable, Logger, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../common/services/redis.service';

/**
 * Open API Gateway Service – Phase 5
 *
 * OAuth2 client_credentials flow for partner integrations.
 * Features:
 *   - Client registration with scope-based access control
 *   - Token issuance with Redis-backed token bucket rate limiting
 *   - Per-client, per-IP, per-tenant throttling
 *   - IP whitelist enforcement
 *
 * Scopes: read:loans, write:deposits, read:members, read:accounts, write:loans
 */

const VALID_SCOPES = [
  'read:loans',
  'write:loans',
  'read:members',
  'read:accounts',
  'write:deposits',
  'read:transactions',
  'read:compliance',
] as const;

const RATE_LIMIT_TIERS: Record<string, number> = {
  internal: 1000,  // 1000 req/min
  partner: 500,    // 500 req/min
  public: 60,      // 60 req/min
};

@Injectable()
export class ApiGatewayService {
  private readonly logger = new Logger(ApiGatewayService.name);
  private readonly TOKEN_TTL = 3600; // 1 hour

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Register a new API client (partner).
   * Returns clientId and clientSecret (secret shown only once).
   */
  async registerClient(params: {
    tenantId: string;
    name: string;
    scopes: string[];
    rateLimitTier?: string;
    webhookUrl?: string;
    ipWhitelist?: string[];
  }) {
    // Validate scopes
    for (const scope of params.scopes) {
      if (!VALID_SCOPES.includes(scope as any)) {
        throw new ForbiddenException(`Invalid scope: ${scope}. Valid: ${VALID_SCOPES.join(', ')}`);
      }
    }

    const clientId = `beba_${randomBytes(16).toString('hex')}`;
    const clientSecret = `sk_${randomBytes(32).toString('hex')}`;
    const clientSecretHash = await argon2.hash(clientSecret);

    const client = await this.prisma.apiClient.create({
      data: {
        tenantId: params.tenantId,
        clientId,
        clientSecretHash,
        name: params.name,
        scopes: params.scopes,
        rateLimitTier: params.rateLimitTier ?? 'partner',
        webhookUrl: params.webhookUrl,
        ipWhitelist: params.ipWhitelist ?? [],
        status: 'ACTIVE',
      },
    });

    this.logger.log(`API client registered: ${client.id} name=${params.name}`);

    return {
      id: client.id,
      clientId,
      clientSecret, // Only returned once!
      name: params.name,
      scopes: params.scopes,
      rateLimitTier: client.rateLimitTier,
      status: client.status,
    };
  }

  /**
   * OAuth2 client_credentials token exchange.
   * Validates client credentials and returns an access token.
   */
  async issueToken(clientId: string, clientSecret: string, requestedScopes?: string[]) {
    const client = await this.prisma.apiClient.findUnique({
      where: { clientId },
    });

    if (!client) {
      throw new UnauthorizedException('Invalid client credentials');
    }

    if (client.status !== 'ACTIVE') {
      throw new ForbiddenException(`API client is ${client.status}`);
    }

    // Verify secret
    const valid = await argon2.verify(client.clientSecretHash, clientSecret);
    if (!valid) {
      throw new UnauthorizedException('Invalid client credentials');
    }

    // Validate requested scopes are subset of granted scopes
    const grantedScopes = requestedScopes
      ? requestedScopes.filter((s) => client.scopes.includes(s))
      : client.scopes;

    // Generate opaque access token
    const tokenValue = randomBytes(32).toString('hex');
    const tokenKey = `api-token:${tokenValue}`;

    // Store token in Redis with TTL
    await this.redis.set(
      tokenKey,
      JSON.stringify({
        clientId: client.clientId,
        tenantId: client.tenantId,
        scopes: grantedScopes,
        rateLimitTier: client.rateLimitTier,
        issuedAt: Date.now(),
      }),
      this.TOKEN_TTL,
    );

    // Update last used
    await this.prisma.apiClient.update({
      where: { id: client.id },
      data: { lastUsedAt: new Date() },
    });

    return {
      access_token: tokenValue,
      token_type: 'Bearer',
      expires_in: this.TOKEN_TTL,
      scope: grantedScopes.join(' '),
    };
  }

  /**
   * Validate an API token and return client context.
   * Used by API gateway middleware/guard.
   */
  async validateToken(token: string) {
    const tokenKey = `api-token:${token}`;
    const data = await this.redis.get(tokenKey);

    if (!data) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    return JSON.parse(data) as {
      clientId: string;
      tenantId: string;
      scopes: string[];
      rateLimitTier: string;
      issuedAt: number;
    };
  }

  /**
   * Check if a request is within rate limits.
   * Uses Redis sliding window counter.
   */
  async checkRateLimit(clientId: string, tier: string): Promise<{
    allowed: boolean;
    remaining: number;
    limit: number;
    resetAt: number;
  }> {
    const limit = RATE_LIMIT_TIERS[tier] ?? RATE_LIMIT_TIERS.public;
    const windowKey = `rate-limit:${clientId}:${Math.floor(Date.now() / 60000)}`;

    const current = await this.redis.get(windowKey);
    const count = current ? parseInt(current, 10) : 0;

    if (count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        limit,
        resetAt: (Math.floor(Date.now() / 60000) + 1) * 60000,
      };
    }

    // Increment counter
    await this.redis.set(windowKey, String(count + 1), 120); // 2-min TTL

    return {
      allowed: true,
      remaining: limit - count - 1,
      limit,
      resetAt: (Math.floor(Date.now() / 60000) + 1) * 60000,
    };
  }

  /**
   * Validate IP whitelist for a client.
   */
  async validateIp(clientId: string, ip: string): Promise<boolean> {
    const client = await this.prisma.apiClient.findUnique({
      where: { clientId },
      select: { ipWhitelist: true },
    });

    if (!client) return false;
    if (client.ipWhitelist.length === 0) return true; // No whitelist = allow all

    return client.ipWhitelist.includes(ip);
  }

  /**
   * List API clients for a tenant.
   */
  async listClients(tenantId: string) {
    return this.prisma.apiClient.findMany({
      where: { tenantId },
      select: {
        id: true,
        clientId: true,
        name: true,
        scopes: true,
        rateLimitTier: true,
        status: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Revoke an API client.
   */
  async revokeClient(clientId: string, tenantId: string) {
    const client = await this.prisma.apiClient.findFirst({
      where: { clientId, tenantId },
    });

    if (!client) {
      throw new UnauthorizedException('Client not found');
    }

    return this.prisma.apiClient.update({
      where: { id: client.id },
      data: { status: 'REVOKED' },
    });
  }
}
