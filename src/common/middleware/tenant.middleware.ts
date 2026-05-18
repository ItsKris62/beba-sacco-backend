import { BadRequestException, ForbiddenException, Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { TenantStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

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

interface JwtTenantClaim {
  tenantId?: string;
  role?: string;
}

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly prisma: PrismaService) {}

  async use(req: Request & { tenant?: unknown; tenantId?: string }, _res: Response, next: NextFunction): Promise<void> {
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
    next();
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
