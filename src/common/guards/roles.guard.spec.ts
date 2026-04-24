import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';

const mockExecutionContext = (user: unknown, requiredRoles?: UserRole[]) => {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(requiredRoles);
  const context = {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
  return { context, reflector };
};

describe('RolesGuard', () => {
  it('allows access when no roles are required', () => {
    const { context, reflector } = mockExecutionContext({ role: UserRole.MEMBER }, undefined);
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows access when user has required role', () => {
    const { context, reflector } = mockExecutionContext(
      { role: UserRole.TENANT_ADMIN },
      [UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN],
    );
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('denies access when user does not have required role', () => {
    const { context, reflector } = mockExecutionContext(
      { role: UserRole.MEMBER },
      [UserRole.TENANT_ADMIN],
    );
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('denies access when user is absent from request', () => {
    const { context, reflector } = mockExecutionContext(null, [UserRole.MEMBER]);
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  // TODO: Phase 2 – test SUPER_ADMIN inherits all roles
  it.todo('SUPER_ADMIN should pass any role check');
});
