import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedUser } from '../../modules/auth/strategies/jwt.strategy';

/**
 * Role hierarchy (higher = more permissions):
 *   SUPER_ADMIN > TENANT_ADMIN > MANAGER > LOAN_OFFICER > TELLER > MEMBER > AUDITOR
 *
 * Hierarchical enforcement:
 *   - A role can always access endpoints requiring its own level OR lower levels.
 *   - @Roles() lists the MINIMUM required role; higher roles are implicitly allowed.
 *   - SUPER_ADMIN bypasses all checks (platform omnipotence).
 *
 * Creation limits (enforced at service layer, not here):
 *   SUPER_ADMIN   → can create all roles including other super_admins
 *   TENANT_ADMIN  → can create all roles EXCEPT super_admin
 *   MANAGER       → can create LOAN_OFFICER, MEMBER
 *   LOAN_OFFICER  → can view/review MEMBER only
 *   MEMBER        → cannot create/manage any roles
 */
const ROLE_RANK: Record<UserRole, number> = {
  [UserRole.SUPER_ADMIN]: 100,
  [UserRole.TENANT_ADMIN]: 80,
  [UserRole.MANAGER]: 60,
  [UserRole.LOAN_OFFICER]: 50,
  [UserRole.TELLER]: 40,
  [UserRole.MEMBER]: 20,
  [UserRole.AUDITOR]: 10,
};

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
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles() decorator → accessible to any authenticated user
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

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
 * | MANAGER        | LOAN_OFFICER, MEMBER                       |
 * | LOAN_OFFICER   | None (view/review members only)            |
 * | MEMBER         | None (self-registration only if enabled)   |
 */
export function canManageRole(actorRole: UserRole, targetRole: UserRole): boolean {
  if (actorRole === UserRole.SUPER_ADMIN) return true;
  if (actorRole === UserRole.TENANT_ADMIN) return targetRole !== UserRole.SUPER_ADMIN;
  if (actorRole === UserRole.MANAGER) {
    return targetRole === UserRole.LOAN_OFFICER || targetRole === UserRole.MEMBER;
  }
  // LOAN_OFFICER, TELLER, AUDITOR, MEMBER have no creation rights
  return false;
}

/**
 * Helper: checks if `actorRole` can create users with `targetRole`.
 * Used by UsersService and AuthService for user creation validation.
 */
export function canCreateUserWithRole(actorRole: UserRole, targetRole: UserRole): boolean {
  return canManageRole(actorRole, targetRole);
}
