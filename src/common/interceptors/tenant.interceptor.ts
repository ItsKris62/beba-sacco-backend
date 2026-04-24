import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { TenantStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../modules/auth/strategies/jwt.strategy';

/**
 * Routes that do NOT require X-Tenant-ID.
 * Only infrastructure endpoints — auth routes still need tenant context.
 */
const TENANT_SKIP_PATTERNS = ['/health', '/docs', '/docs-json', '/favicon.ico'];

/**
 * Tenant Context Interceptor
 *
 * For every request (except infra routes above):
 * 1. Extracts X-Tenant-ID header (UUID).
 * 2. Validates tenant exists in public.Tenant and is ACTIVE.
 * 3. Attaches full Tenant object to req.tenant.
 * 4. (Phase 2) Will call prisma.setTenantContext(tenant.schemaName) — see NOTE below.
 *
 * NOTE on SET search_path:
 *   The current DATABASE_URL uses Neon's connection pooler (transaction mode).
 *   SET search_path is session-scoped and will NOT persist reliably across pooled
 *   connections. For Phase 2, switch DATABASE_URL to the direct (non-pooler) Neon
 *   URL and uncomment the setTenantContext call below.
 *   Direct URL example: ep-lively-brook-ab4j7brj.eu-west-2.aws.neon.tech (no "-pooler")
 *
 * TODO: Phase 1.5 – cache tenant lookups in Redis (TTL 5 min) to avoid per-request DB hits
 * TODO: Phase 2 – call prisma.setTenantContext(tenant.schemaName) after switching to direct URL
 * TODO: Phase 2 – per-tenant rate limiting
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<{
      url: string;
      headers: Record<string, string | string[] | undefined>;
      tenant: unknown;
      tenantId: string;
    }>();

    // Skip infra/swagger routes
    const shouldSkip = TENANT_SKIP_PATTERNS.some((pattern) =>
      request.url.includes(pattern),
    );
    if (shouldSkip) {
      return next.handle();
    }

    const rawHeader = request.headers['x-tenant-id'];
    const tenantId = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (!tenantId || typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw new BadRequestException('X-Tenant-ID header is required');
    }

    // Basic UUID format validation — prevents obviously malformed values
    const UUID_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(tenantId)) {
      throw new BadRequestException('X-Tenant-ID must be a valid UUID');
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

    // SUPER_ADMIN can access any tenant regardless of status (for management/recovery purposes).
    // All other roles are blocked from suspended or inactive tenants.
    const requestUser = (request as unknown as { user?: AuthenticatedUser }).user;
    const isSuperAdmin = requestUser?.role === UserRole.SUPER_ADMIN;

    if (!isSuperAdmin) {
      if (tenant.status === TenantStatus.SUSPENDED) {
        throw new UnauthorizedException('This SACCO account has been suspended. Contact support.');
      }

      if (tenant.status === TenantStatus.INACTIVE) {
        throw new UnauthorizedException('This SACCO account is inactive.');
      }
    }

    // Attach full tenant object for downstream use (@CurrentTenant() decorator)
    request.tenant = tenant;
    // Keep tenantId shorthand for legacy code still using req.tenantId
    request.tenantId = tenant.id;

    // TODO: Phase 2 – uncomment after switching to direct (non-pooler) DATABASE_URL
    // await this.prisma.setTenantContext(tenant.schemaName);

    this.logger.debug(`Tenant resolved: ${tenant.slug} (${tenant.id})`);

    return next.handle();
  }
}
