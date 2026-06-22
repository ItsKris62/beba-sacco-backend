import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { Prisma, TenantStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FeatureFlags } from '../../config/feature-flags';
import { RedisService } from '../services/redis.service';

const TENANT_SKIP_PATTERNS = [
  '/health',
  '/docs',
  '/docs-json',
  '/favicon.ico',
  '/api/metrics',
  '/metrics',
  '/api/mpesa/callback',
  '/api/v1/mpesa/callback',
];
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_CACHE_TTL_SECONDS = 300;

type TenantRequestConfig = {
  id: string;
  name: string;
  slug: string;
  schemaName: string;
  status: TenantStatus;
  settings: Prisma.JsonValue | null;
  contactEmail: string;
  contactPhone: string;
  address: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type CachedTenantConfig = Omit<TenantRequestConfig, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
};

interface JwtTenantClaim {
  sub?: string;
  tenantId?: string;
  role?: string;
}

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantMiddleware.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async use(
    req: Request & { tenant?: unknown; tenantId?: string },
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (TENANT_SKIP_PATTERNS.some((pattern) => req.path.includes(pattern))) {
      next();
      return;
    }

    const rawTenant = req.headers['x-tenant-id'];
    const tenantId = Array.isArray(rawTenant) ? rawTenant[0] : rawTenant;

    if (!tenantId || typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw new BadRequestException('X-Tenant-ID header is required');
    }

    if (!UUID_REGEX.test(tenantId)) {
      throw new BadRequestException('X-Tenant-ID must be a valid UUID');
    }

    const jwtClaim = this.decodeBearerTenant(req.headers.authorization);
    if (
      jwtClaim?.tenantId &&
      jwtClaim.tenantId !== tenantId &&
      jwtClaim.role !== UserRole.SUPER_ADMIN
    ) {
      throw new ForbiddenException('Token tenant does not match X-Tenant-ID');
    }

    const tenant = await this.getTenantConfig(tenantId);

    if (!tenant) {
      throw new BadRequestException('Unknown tenant');
    }

    if (tenant.status === TenantStatus.SUSPENDED && jwtClaim?.role !== UserRole.SUPER_ADMIN) {
      throw new UnauthorizedException('This SACCO account has been suspended. Contact support.');
    }

    if (tenant.status === TenantStatus.INACTIVE && jwtClaim?.role !== UserRole.SUPER_ADMIN) {
      throw new UnauthorizedException('This SACCO account is inactive.');
    }

    req.tenant = tenant;
    req.tenantId = tenant.id;
    await this.setRlsSessionContext(tenant.id, jwtClaim);
    next();
  }

  private async getTenantConfig(tenantId: string): Promise<TenantRequestConfig | null> {
    const cacheKey = this.tenantCacheKey(tenantId);
    const cached = await this.redis.getJson<CachedTenantConfig>(cacheKey);
    if (cached) {
      this.logger.debug(`Tenant config cache hit tenant=${tenantId}`);
      return {
        ...cached,
        createdAt: new Date(cached.createdAt),
        updatedAt: new Date(cached.updatedAt),
      };
    }

    this.logger.debug(`Tenant config cache miss tenant=${tenantId}`);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        schemaName: true,
        status: true,
        settings: true,
        contactEmail: true,
        contactPhone: true,
        address: true,
        logoUrl: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (tenant) {
      await this.redis.setJson(cacheKey, tenant, TENANT_CACHE_TTL_SECONDS);
    }

    return tenant;
  }

  private tenantCacheKey(tenantId: string): string {
    return `tenant:config:${tenantId}`;
  }

  private async setRlsSessionContext(
    tenantId: string,
    jwtClaim: JwtTenantClaim | null,
  ): Promise<void> {
    const rlsEnabled = FeatureFlags.isEnabled('RLS_ENFORCEMENT', tenantId);
    const bypassRls = jwtClaim?.role === UserRole.SUPER_ADMIN;

    await this.prisma.$executeRaw`
      SELECT
        set_config('app.current_tenant_id', ${tenantId}, false),
        set_config('app.current_user_id', ${jwtClaim?.sub ?? ''}, false),
        set_config('app.current_user_role', ${jwtClaim?.role ?? ''}, false),
        set_config('app.rls_enabled', ${rlsEnabled ? 'true' : 'false'}, false),
        set_config('app.bypass_rls', ${bypassRls ? 'true' : 'false'}, false)
    `;
  }

  private decodeBearerTenant(authorization?: string): JwtTenantClaim | null {
    if (!authorization?.startsWith('Bearer ')) return null;
    const token = authorization.slice('Bearer '.length);
    const [, payload] = token.split('.');
    if (!payload) return null;

    try {
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(normalized, 'base64').toString('utf8');
      return JSON.parse(decoded) as JwtTenantClaim;
    } catch {
      return null;
    }
  }
}
