/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, CanActivate, ExecutionContext } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { UserRole } from '@prisma/client';
import { RBACGuard } from '../src/common/guards/rbac.guard';

// ─── Mock RBACGuard for deterministic role-based testing ────────────────────

class TestRBACGuard implements CanActivate {
  private testRole: UserRole = UserRole.MEMBER;
  private testTenantId = 'test-tenant-id';

  setRole(role: UserRole) {
    this.testRole = role;
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    req.user = {
      id: 'test-user-id',
      role: this.testRole,
      tenantId: this.testTenantId,
      isActive: true,
    };
    req.tenant = { id: this.testTenantId };
    return true;
  }
}

// ─── E2E Test Suite ──────────────────────────────────────────────────────────

describe('🔐 RBAC Refactor E2E Tests', () => {
  let app: INestApplication;
  let testGuard: TestRBACGuard;

  beforeAll(async () => {
    testGuard = new TestRBACGuard();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(RBACGuard)
      .useValue(testGuard)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    testGuard.setRole(UserRole.MEMBER);
  });

  // ─── 1. Role Escalation Prevention ────────────────────────────────────────

  describe('Role Escalation Prevention (403)', () => {
    it('MANAGER cannot create TENANT_ADMIN → 403', async () => {
      testGuard.setRole(UserRole.MANAGER);
      const res = await request(app.getHttpServer())
        .post('/users')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({
          email: 'newadmin@example.com',
          password: 'TempPass123!',
          firstName: 'Test',
          lastName: 'Admin',
          role: UserRole.TENANT_ADMIN,
        });

      expect([403, 400]).toContain(res.status);
    });

    it('MANAGER cannot assign SUPER_ADMIN → 403', async () => {
      testGuard.setRole(UserRole.MANAGER);
      const res = await request(app.getHttpServer())
        .patch('/users/some-id')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({
          role: UserRole.SUPER_ADMIN,
        });

      expect([403, 400]).toContain(res.status);
    });

    it('TELLER cannot create any user → 403', async () => {
      testGuard.setRole(UserRole.TELLER);
      const res = await request(app.getHttpServer())
        .post('/users')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({
          email: 'newmember@example.com',
          password: 'TempPass123!',
          firstName: 'Test',
          lastName: 'Member',
          role: UserRole.MEMBER,
        });

      expect(res.status).toBe(403);
    });

    it('MEMBER cannot access admin dashboard → 403', async () => {
      testGuard.setRole(UserRole.MEMBER);
      const res = await request(app.getHttpServer())
        .get('/admin/dashboard/stats')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id');

      expect(res.status).toBe(403);
    });

    it('AUDITOR cannot POST to any endpoint → 403', async () => {
      testGuard.setRole(UserRole.AUDITOR);
      const res = await request(app.getHttpServer())
        .post('/users')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({
          email: 'test@example.com',
          password: 'TempPass123!',
          firstName: 'Test',
          lastName: 'User',
          role: UserRole.MEMBER,
        });

      expect(res.status).toBe(403);
    });
  });

  // ─── 2. CHAIRMAN Stage Access ─────────────────────────────────────────────

  describe('CHAIRMAN Stage Oversight Access', () => {
    it('CHAIRMAN can access stage members endpoint (inherits MEMBER + oversight)', async () => {
      testGuard.setRole(UserRole.CHAIRMAN);
      const res = await request(app.getHttpServer())
        .get('/admin/stages/some-stage-id/members')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id');

      // 404 is acceptable (stage not found), but must NOT be 403
      expect([200, 404]).toContain(res.status);
    });

    it('CHAIRMAN can access stage analytics endpoint', async () => {
      testGuard.setRole(UserRole.CHAIRMAN);
      const res = await request(app.getHttpServer())
        .get('/admin/stages/some-stage-id/analytics')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id');

      expect([200, 404]).toContain(res.status);
    });

    it('MEMBER cannot access stage members endpoint → 403', async () => {
      testGuard.setRole(UserRole.MEMBER);
      const res = await request(app.getHttpServer())
        .get('/admin/stages/some-stage-id/members')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id');

      expect(res.status).toBe(403);
    });

    it('MEMBER cannot access stage analytics endpoint → 403', async () => {
      testGuard.setRole(UserRole.MEMBER);
      const res = await request(app.getHttpServer())
        .get('/admin/stages/some-stage-id/analytics')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id');

      expect(res.status).toBe(403);
    });

    it('CHAIRMAN can access member portal (inherits MEMBER)', async () => {
      testGuard.setRole(UserRole.CHAIRMAN);
      const res = await request(app.getHttpServer())
        .get('/members/dashboard')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id');

      expect([200, 404]).toContain(res.status);
    });
  });

  // ─── 3. AUDITOR Read-Only Enforcement ─────────────────────────────────────

  describe('AUDITOR Read-Only Enforcement', () => {
    it('AUDITOR can GET /users → 200', async () => {
      testGuard.setRole(UserRole.AUDITOR);
      const res = await request(app.getHttpServer())
        .get('/users')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id');

      expect([200, 404]).toContain(res.status);
    });

    it('AUDITOR can GET /audit → 200', async () => {
      testGuard.setRole(UserRole.AUDITOR);
      const res = await request(app.getHttpServer())
        .get('/audit')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id');

      expect([200, 404]).toContain(res.status);
    });

    it('AUDITOR can GET /dashboard/stats → 200', async () => {
      testGuard.setRole(UserRole.AUDITOR);
      const res = await request(app.getHttpServer())
        .get('/admin/dashboard/stats')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id');

      expect([200, 404]).toContain(res.status);
    });

    it('AUDITOR cannot PATCH /users/:id → 403', async () => {
      testGuard.setRole(UserRole.AUDITOR);
      const res = await request(app.getHttpServer())
        .patch('/users/some-id')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({ firstName: 'Hacked' });

      expect(res.status).toBe(403);
    });

    it('AUDITOR cannot DELETE /admin/stages/:id → 403', async () => {
      testGuard.setRole(UserRole.AUDITOR);
      const res = await request(app.getHttpServer())
        .delete('/admin/stages/some-id')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id');

      expect(res.status).toBe(403);
    });

    it('AUDITOR cannot POST /admin/data-import/execute-financial → 403', async () => {
      testGuard.setRole(UserRole.AUDITOR);
      const res = await request(app.getHttpServer())
        .post('/admin/data-import/execute-financial')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id');

      expect(res.status).toBe(403);
    });

    it('AUDITOR cannot approve/reject loans → 403', async () => {
      testGuard.setRole(UserRole.AUDITOR);
      const res = await request(app.getHttpServer())
        .post('/loans/some-id/approve')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({ notes: 'Audit test' });

      expect(res.status).toBe(403);
    });
  });

  // ─── 4. Role Hierarchy Validation ─────────────────────────────────────────

  describe('Role Hierarchy & Creation Limits', () => {
    it('TENANT_ADMIN can create MANAGER → 201 or validation error (not 403)', async () => {
      testGuard.setRole(UserRole.TENANT_ADMIN);
      const res = await request(app.getHttpServer())
        .post('/users')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({
          email: 'manager@example.com',
          password: 'TempPass123!',
          firstName: 'Test',
          lastName: 'Manager',
          role: UserRole.MANAGER,
        });

      // 201 = created, 409 = already exists, 400 = validation error — all acceptable
      expect([201, 400, 409]).toContain(res.status);
    });

    it('MANAGER can create TELLER → 201 or validation error (not 403)', async () => {
      testGuard.setRole(UserRole.MANAGER);
      const res = await request(app.getHttpServer())
        .post('/users')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({
          email: 'teller@example.com',
          password: 'TempPass123!',
          firstName: 'Test',
          lastName: 'Teller',
          role: UserRole.TELLER,
        });

      expect([201, 400, 409]).toContain(res.status);
    });

    it('MANAGER can create CHAIRMAN → 201 or validation error (not 403)', async () => {
      testGuard.setRole(UserRole.MANAGER);
      const res = await request(app.getHttpServer())
        .post('/users')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({
          email: 'chairman@example.com',
          password: 'TempPass123!',
          firstName: 'Test',
          lastName: 'Chairman',
          role: UserRole.CHAIRMAN,
        });

      expect([201, 400, 409]).toContain(res.status);
    });

    it('MANAGER can create AUDITOR → 201 or validation error (not 403)', async () => {
      testGuard.setRole(UserRole.MANAGER);
      const res = await request(app.getHttpServer())
        .post('/users')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({
          email: 'auditor@example.com',
          password: 'TempPass123!',
          firstName: 'Test',
          lastName: 'Auditor',
          role: UserRole.AUDITOR,
        });

      expect([201, 400, 409]).toContain(res.status);
    });

    it('MANAGER cannot create TENANT_ADMIN → 403', async () => {
      testGuard.setRole(UserRole.MANAGER);
      const res = await request(app.getHttpServer())
        .post('/users')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({
          email: 'admin2@example.com',
          password: 'TempPass123!',
          firstName: 'Test',
          lastName: 'Admin',
          role: UserRole.TENANT_ADMIN,
        });

      expect(res.status).toBe(403);
    });

    it('TENANT_ADMIN can create LOAN_OFFICER → 201 or validation error (not 403)', async () => {
      testGuard.setRole(UserRole.TENANT_ADMIN);
      const res = await request(app.getHttpServer())
        .post('/users')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({
          email: 'loanofficer1@example.com',
          password: 'TempPass123!',
          firstName: 'Test',
          lastName: 'LoanOfficer',
          role: UserRole.LOAN_OFFICER,
        });

      expect([201, 400, 409]).toContain(res.status);
    });

    it('TENANT_ADMIN can create ACCOUNTANT → 201 or validation error (not 403)', async () => {
      testGuard.setRole(UserRole.TENANT_ADMIN);
      const res = await request(app.getHttpServer())
        .post('/users')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({
          email: 'accountant1@example.com',
          password: 'TempPass123!',
          firstName: 'Test',
          lastName: 'Accountant',
          role: UserRole.ACCOUNTANT,
        });

      expect([201, 400, 409]).toContain(res.status);
    });

    it('MANAGER can create LOAN_OFFICER → 201 or validation error (not 403)', async () => {
      testGuard.setRole(UserRole.MANAGER);
      const res = await request(app.getHttpServer())
        .post('/users')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({
          email: 'loanofficer2@example.com',
          password: 'TempPass123!',
          firstName: 'Test',
          lastName: 'LoanOfficer',
          role: UserRole.LOAN_OFFICER,
        });

      expect([201, 400, 409]).toContain(res.status);
    });

    it('MANAGER can create ACCOUNTANT → 201 or validation error (not 403)', async () => {
      testGuard.setRole(UserRole.MANAGER);
      const res = await request(app.getHttpServer())
        .post('/users')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({
          email: 'accountant2@example.com',
          password: 'TempPass123!',
          firstName: 'Test',
          lastName: 'Accountant',
          role: UserRole.ACCOUNTANT,
        });

      expect([201, 400, 409]).toContain(res.status);
    });

    it('MANAGER can PATCH a role to LOAN_OFFICER without a DTO validation 400 (UPDATABLE_ROLES gap fix)', async () => {
      testGuard.setRole(UserRole.MANAGER);
      const res = await request(app.getHttpServer())
        .patch('/users/00000000-0000-4000-8000-000000000000')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({ role: UserRole.LOAN_OFFICER });

      // The id doesn't exist, so 404 is the expected outcome here — the point of
      // this test is that it's NOT a 400, which is what UPDATABLE_ROLES previously
      // produced by rejecting LOAN_OFFICER before the request ever reached the service.
      expect(res.status).not.toBe(400);
      expect([403, 404]).toContain(res.status);
    });

    it('TENANT_ADMIN can PATCH a role to ACCOUNTANT without a DTO validation 400 (UPDATABLE_ROLES gap fix)', async () => {
      testGuard.setRole(UserRole.TENANT_ADMIN);
      const res = await request(app.getHttpServer())
        .patch('/users/00000000-0000-4000-8000-000000000000')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({ role: UserRole.ACCOUNTANT });

      expect(res.status).not.toBe(400);
      expect([403, 404]).toContain(res.status);
    });

    it('SUPER_ADMIN cannot be created via API → 403', async () => {
      testGuard.setRole(UserRole.TENANT_ADMIN);
      const res = await request(app.getHttpServer())
        .post('/users')
        .set('Authorization', 'Bearer test-token')
        .set('X-Tenant-ID', 'test-tenant-id')
        .send({
          email: 'super@example.com',
          password: 'TempPass123!',
          firstName: 'Test',
          lastName: 'Super',
          role: UserRole.SUPER_ADMIN,
        });

      expect(res.status).toBe(403);
    });
  });
});
