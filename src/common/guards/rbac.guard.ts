import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthenticatedUser } from '../../modules/auth/strategies/jwt.strategy';

/**
 * Role hierarchy (higher = more permissions):
 *   SUPER_ADMIN > TENANT_ADMIN > MANAGER > TELLER > CHAIRMAN > MEMBER > AUDITOR
 *
 * Hierarchical enforcement:
 *   - A role can always access endpoints requiring its own level OR lower levels.
 *   - @Roles() lists the MINIMUM required role; higher roles are implicitly allowed.
 *   - SUPER_ADMIN bypasses all checks (platform omnipotence).
 *
 * CHAIRMAN inherits MEMBER permissions automatically via rank (CHAIRMAN > MEMBER).
 * AUDITOR is read-only: POST/PATCH/DELETE are blocked regardless of @Roles().
 *
 * Creation limits (enforced at service layer, not here):
 *   SUPER_ADMIN   → can create all roles including other super_admins
 *   TENANT_ADMIN  → can create all roles EXCEPT super_admin
 *   MANAGER       → can create TELLER, MEMBER, CHAIRMAN, AUDITOR
 *   TELLER        → none
 *   MEMBER        → none (self-registration only)
 *   CHAIRMAN      → none (stage oversight + full member rights)
 *   AUDITOR       → none (read-only)
 */
const ROLE_RANK: Record<UserRole, number> = {
  [UserRole.SUPER_ADMIN]: 100,
  [UserRole.TENANT_ADMIN]: 80,
  [UserRole.MANAGER]: 60,
  [UserRole.TELLER]: 40,
  [UserRole.CHAIRMAN]: 30,
  [UserRole.MEMBER]: 20,
  [UserRole.AUDITOR]: 10,
};

/** HTTP methods considered mutating (blocked for AUDITOR) */
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * RBAC Guard – Hierarchical Role-Based Access Control
 *
 * Replaces the flat RolesGuard with hierarchy-aware enforcement.
 * Applied globally via APP_GUARD (runs after JwtAuthGuard).
 *
 * Usage:
 *   @Roles(UserRole.MANAGER)  // MANAGER, TENANT_ADMIN, SUPER_ADMIN allowed
 *   @Get('admin-only')
 *   async getAdminData() { ... }
 */
@Injectable()
export class RBACGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Public routes bypass JWT entirely — request.user is never set for them.
    // Without this check, RBACGuard throws 403 on every @Public() route (login, register, etc.).
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser; method?: string }>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    // AUDITOR: zero mutating permissions, regardless of route decorators
    if (user.role === UserRole.AUDITOR && request.method && MUTATING_METHODS.has(request.method)) {
      throw new ForbiddenException('AUDITOR role is read-only. Mutating operations are prohibited.');
    }

    // No @Roles() decorator → accessible to any authenticated user (subject to AUDITOR block above)
    if (!requiredRoles || requiredRoles.length === 0) return true;

    // SUPER_ADMIN bypasses all role restrictions
    if (user.role === UserRole.SUPER_ADMIN) return true;

    const userRank = ROLE_RANK[user.role] ?? 0;
    const minRequiredRank = Math.min(...requiredRoles.map((r) => ROLE_RANK[r] ?? 999));

    if (userRank < minRequiredRank) {
      throw new ForbiddenException(
        `Access denied. Required role level: [${requiredRoles.join(', ')}], your role: ${user.role}`,
      );
    }

    return true;
  }
}

/**
 * Strict role hierarchy for creation/management.
 *
 * | Actor          | Can Create/Manage                          |
 * |----------------|--------------------------------------------|
 * | SUPER_ADMIN    | All roles, system config, tenants          |
 * | TENANT_ADMIN   | All roles EXCEPT SUPER_ADMIN               |
 * | MANAGER        | TELLER, MEMBER, CHAIRMAN, AUDITOR          |
 * | TELLER         | None                                       |
 * | MEMBER         | None (self-registration only if enabled)   |
 * | CHAIRMAN       | None (stage oversight + full member rights)|
 * | AUDITOR        | None (read-only)                           |
 */
export function canManageRole(actorRole: UserRole, targetRole: UserRole): boolean {
  if (actorRole === UserRole.SUPER_ADMIN) return true;
  if (actorRole === UserRole.TENANT_ADMIN) return targetRole !== UserRole.SUPER_ADMIN;
  if (actorRole === UserRole.MANAGER) {
    return (
      targetRole === UserRole.TELLER ||
      targetRole === UserRole.MEMBER ||
      targetRole === UserRole.CHAIRMAN ||
      targetRole === UserRole.AUDITOR
    );
  }
  // TELLER, MEMBER, CHAIRMAN, AUDITOR have no creation rights
  return false;
}

/**
 * Helper: checks if `actorRole` can create users with `targetRole`.
 * Used by UsersService and AuthService for user creation validation.
 */
export function canCreateUserWithRole(actorRole: UserRole, targetRole: UserRole): boolean {
  return canManageRole(actorRole, targetRole);
}

/**
 * Helper: returns true if the role is a member-facing role (MEMBER or CHAIRMAN).
 * Used by member-portal and stage endpoints that should be accessible to both.
 */
export function isMemberRole(role: UserRole): boolean {
  return role === UserRole.MEMBER || role === UserRole.CHAIRMAN;
}
