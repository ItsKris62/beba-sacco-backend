import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Tenant } from '@prisma/client';

/**
 * @CurrentTenant() – extracts the validated Tenant from the request.
 *
 * Populated by TenantInterceptor after validating X-Tenant-ID against the DB.
 *
 * Usage:
 *   @Get('data')
 *   getData(@CurrentTenant() tenant: Tenant) { ... }
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Tenant => {
    const request = ctx.switchToHttp().getRequest<{ tenant: Tenant }>();
    return request.tenant;
  },
);
