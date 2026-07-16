import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { AdminController } from './admin.controller';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';

/**
 * RBAC regression coverage for the member-level KYC endpoints on AdminController —
 * the counterpart to admin-documents.controller.spec.ts (document-level endpoints).
 * Reads @Roles() metadata directly off the controller prototype; no TestingModule/DI
 * needed since decorator metadata is attached at class-definition time.
 */
const reflector = new Reflector();
const prototype = AdminController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

function rolesFor(methodName: string): UserRole[] {
  return reflector.get<UserRole[]>(ROLES_KEY, prototype[methodName]) ?? [];
}

const KYC_STAFF_ROLES = [UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER];

describe('AdminController RBAC', () => {
  describe('GET /admin/members/pending (getPendingMembers)', () => {
    const roles = rolesFor('getPendingMembers');

    it('grants the staff roles that work the KYC Queue', () => {
      expect(roles).toEqual(expect.arrayContaining(KYC_STAFF_ROLES));
    });

    it('never grants MEMBER', () => {
      expect(roles).not.toContain(UserRole.MEMBER);
    });
  });

  describe('PATCH /admin/members/:id/kyc (updateKyc)', () => {
    const roles = rolesFor('updateKyc');

    it('grants the staff roles that can approve/reject member KYC', () => {
      expect(roles).toEqual(expect.arrayContaining(KYC_STAFF_ROLES));
    });

    it('never grants MEMBER', () => {
      expect(roles).not.toContain(UserRole.MEMBER);
    });
  });

  it('getPendingMembers and updateKyc stay in lockstep — same staff can list and act on the queue', () => {
    expect([...rolesFor('getPendingMembers')].sort()).toEqual([...rolesFor('updateKyc')].sort());
  });

  it('the deprecated PATCH /admin/members/:id/review endpoint stays removed', () => {
    expect(prototype.reviewMember).toBeUndefined();
  });

  it('never gates any endpoint on this admin controller to MEMBER-only', () => {
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
