import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

/**
 * Roles Decorator
 * 
 * Usage:
 * @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
 * @Get('sensitive-data')
 * async getSensitiveData() { ... }
 * 
 * Works in conjunction with RolesGuard
 * 
 * TODO: Phase 1 - Implement RolesGuard to enforce this decorator
 */
export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

