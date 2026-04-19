import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedUser } from '../../modules/auth/strategies/jwt.strategy';

/**
 * Role-Based Access Control Guard
 *
 * Applied globally via APP_GUARD (runs after JwtAuthGuard, so req.user is always
 * populated by the time this executes).
 *
 * Role hierarchy:
 *   SUPER_ADMIN bypasses all role checks — it is the platform god-mode role used
 *   only by Beba staff and should never be assigned within a tenant context.
 *   All other roles are checked by exact match against @Roles(...) declarations.
 *
 * Phase 2 hook: replace with a permission-based (PBAC) system where roles map to
 *   fine-grained permission sets stored in Redis/config, allowing runtime changes
 *   without redeployment.
 * Phase 3 hook: add resource-level permission checks (e.g. can a MANAGER approve
 *   loans above a certain amount threshold?).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles() decorator → route is accessible to any authenticated user
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user) {
      // JwtAuthGuard should have caught this first, but be defensive
      throw new ForbiddenException('User not authenticated');
    }

    // SUPER_ADMIN bypasses all role restrictions — platform-level omnipotence.
    // This means SUPER_ADMIN can call any endpoint in any module, including
    // tenant-scoped ones. Tenant isolation is still enforced separately by
    // TenantInterceptor and Prisma tenantId scoping.
    if (user.role === UserRole.SUPER_ADMIN) return true;

    const hasRole = requiredRoles.includes(user.role);

    if (!hasRole) {
      throw new ForbiddenException(
        `Access denied. Required: [${requiredRoles.join(', ')}], your role: ${user.role}`,
      );
    }

    return true;
  }
}
