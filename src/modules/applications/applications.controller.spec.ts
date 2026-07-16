import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ApplicationsController } from './applications.controller';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';

/**
 * RBAC regression coverage for the Member Applications review/approval endpoints —
 * same pattern as admin-documents.controller.spec.ts and admin.controller.spec.ts.
 * Reads @Roles() metadata directly off the controller prototype; no TestingModule/DI
 * needed since decorator metadata is attached at class-definition time.
 */
const reflector = new Reflector();
const prototype = ApplicationsController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

function rolesFor(methodName: string): UserRole[] {
  return reflector.get<UserRole[]>(ROLES_KEY, prototype[methodName]) ?? [];
}

const VIEW_ROLES = [UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER, UserRole.AUDITOR];
const APPROVE_REJECT_ROLES = [UserRole.TENANT_ADMIN, UserRole.MANAGER];

describe('ApplicationsController RBAC', () => {
  describe('POST /admin/applications (create/submit)', () => {
    const roles = rolesFor('create');

    it('grants staff who submit applications on a prospective member’s behalf', () => {
      expect(roles).toEqual(
        expect.arrayContaining([UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER]),
      );
    });

    it('never grants MEMBER — there is no self-registration path', () => {
      expect(roles).not.toContain(UserRole.MEMBER);
    });

    it('does not grant AUDITOR (read-only role) submission rights', () => {
      expect(roles).not.toContain(UserRole.AUDITOR);
    });
  });

  describe('GET /admin/applications/pending (findPending) and GET /admin/applications/:id (findOne)', () => {
    it('both grant the same read roles, including AUDITOR', () => {
      const pending = [...rolesFor('findPending')].sort();
      const one = [...rolesFor('findOne')].sort();
      expect(pending).toEqual(one);
      expect(pending).toEqual(expect.arrayContaining(VIEW_ROLES));
    });

    it('never grant MEMBER', () => {
      expect(rolesFor('findPending')).not.toContain(UserRole.MEMBER);
      expect(rolesFor('findOne')).not.toContain(UserRole.MEMBER);
    });
  });

  describe('POST /admin/applications/:id/approve and /:id/reject', () => {
    it('both restrict to TENANT_ADMIN and MANAGER only — matches the frontend page guard', () => {
      expect([...rolesFor('approve')].sort()).toEqual([...APPROVE_REJECT_ROLES].sort());
      expect([...rolesFor('reject')].sort()).toEqual([...APPROVE_REJECT_ROLES].sort());
    });

    it('excludes TELLER and AUDITOR — they can view/submit but not decide', () => {
      for (const method of ['approve', 'reject']) {
        expect(rolesFor(method)).not.toContain(UserRole.TELLER);
        expect(rolesFor(method)).not.toContain(UserRole.AUDITOR);
        expect(rolesFor(method)).not.toContain(UserRole.MEMBER);
      }
    });
  });

  it('never gates any endpoint on this controller to MEMBER-only', () => {
    const methodNames = Object.getOwnPropertyNames(prototype).filter((name) => name !== 'constructor');

    for (const methodName of methodNames) {
      const roles = rolesFor(methodName);
      const isMemberOnly = roles.length === 1 && roles[0] === UserRole.MEMBER;
      expect({ methodName, roles, isMemberOnly }).toEqual(
        expect.objectContaining({ isMemberOnly: false }),
      );
    }
  });
});
