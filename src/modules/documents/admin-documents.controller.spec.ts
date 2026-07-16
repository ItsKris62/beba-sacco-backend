import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { AdminDocumentsController } from './admin-documents.controller';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';

/**
 * Regression coverage for the Phase 1 audit finding: GET /admin/kyc/documents,
 * GET /admin/kyc/documents/:id/download, and PATCH /admin/kyc/documents/:id/review
 * were gated with @Roles(UserRole.MEMBER) — a copy-paste artifact from a
 * member-facing controller — which locked every real admin/staff role out of the
 * KYC Queue's document review dialog while silently returning 403s.
 *
 * This reads the @Roles() metadata directly off the controller prototype (no Nest
 * TestingModule/DI needed — decorator metadata is attached at class-definition
 * time), so it fails fast and specifically if the wrong role set is ever
 * reintroduced on any of these handlers.
 */
const reflector = new Reflector();
const prototype = AdminDocumentsController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

function rolesFor(methodName: string): UserRole[] {
  return reflector.get<UserRole[]>(ROLES_KEY, prototype[methodName]) ?? [];
}

const STAFF_VIEW_ROLES = [
  UserRole.TENANT_ADMIN,
  UserRole.MANAGER,
  UserRole.CHAIRMAN,
  UserRole.LOAN_OFFICER,
  UserRole.AUDITOR,
];

const STAFF_REVIEW_ROLES = [UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.CHAIRMAN, UserRole.LOAN_OFFICER];

describe('AdminDocumentsController RBAC', () => {
  describe('GET /admin/kyc/documents (listDocuments)', () => {
    const roles = rolesFor('listDocuments');

    it('grants every staff role that reviews KYC documents', () => {
      expect(roles).toEqual(expect.arrayContaining(STAFF_VIEW_ROLES));
    });

    it('never grants MEMBER — the exact bug that broke the KYC Queue in Phase 1', () => {
      expect(roles).not.toContain(UserRole.MEMBER);
    });
  });

  describe('GET /admin/kyc/documents/:id/download (getDownloadUrl)', () => {
    const roles = rolesFor('getDownloadUrl');

    it('grants every staff role that reviews KYC documents', () => {
      expect(roles).toEqual(expect.arrayContaining(STAFF_VIEW_ROLES));
    });

    it('never grants MEMBER', () => {
      expect(roles).not.toContain(UserRole.MEMBER);
    });
  });

  describe('PATCH /admin/kyc/documents/:id/review (reviewDocument, synchronous)', () => {
    const roles = rolesFor('reviewDocument');

    it('grants every staff role that can review a KYC document', () => {
      expect(roles).toEqual(expect.arrayContaining(STAFF_REVIEW_ROLES));
    });

    it('never grants MEMBER', () => {
      expect(roles).not.toContain(UserRole.MEMBER);
    });
  });

  describe('POST /admin/kyc/documents/:id/review (enqueueReview, async — the endpoint the frontend actually calls)', () => {
    it('grants every staff role that can review a KYC document, matching the sync endpoint', () => {
      const roles = rolesFor('enqueueReview');
      expect(roles).toEqual(expect.arrayContaining(STAFF_REVIEW_ROLES));
    });

    it('never grants MEMBER', () => {
      expect(rolesFor('enqueueReview')).not.toContain(UserRole.MEMBER);
    });
  });

  it('keeps the sync and async review endpoints in lockstep (documents.service.ts#REVIEW_ROLES gates both)', () => {
    const sync = [...rolesFor('reviewDocument')].sort();
    const async_ = [...rolesFor('enqueueReview')].sort();
    expect(sync).toEqual(async_);
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
