import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthenticatedUser } from '../../modules/auth/strategies/jwt.strategy';

/**
 * RBAC Guard - Strict Role-Based Access Control
 *
 * Route access is exact-match only:
 *   - A user must have one of the exact roles declared by @Roles().
 *   - SUPER_ADMIN bypasses all role checks.
 *   - Routes without @Roles() are available to any authenticated user.
 *
 * Creation limits remain enforced at the service layer via canManageRole().
 */
@Injectable()
export class RBACGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Public routes bypass JWT entirely - request.user is never set for them.
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

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    // SUPER_ADMIN bypasses all role restrictions.
    if (user.role === UserRole.SUPER_ADMIN) return true;

    // No @Roles() decorator means any authenticated user is allowed.
    if (!requiredRoles || requiredRoles.length === 0) return true;

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        `Access denied. Required role: [${requiredRoles.join(', ')}], your role: ${user.role}`,
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
 * | MANAGER        | LOAN_OFFICER, TELLER, MEMBER, CHAIRMAN, AUDITOR |
 * | LOAN_OFFICER   | None                                       |
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
      targetRole === UserRole.LOAN_OFFICER ||
      targetRole === UserRole.ACCOUNTANT ||
      targetRole === UserRole.TELLER ||
      targetRole === UserRole.MEMBER ||
      targetRole === UserRole.CHAIRMAN ||
      targetRole === UserRole.AUDITOR
    );
  }
  // LOAN_OFFICER, TELLER, MEMBER, CHAIRMAN, AUDITOR have no creation rights
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
