import { CallHandler, CanActivate, ExecutionContext, ForbiddenException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import { of } from 'rxjs';
import type { NextFunction, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { AuditInterceptor } from '../../../common/interceptors/audit.interceptor';
import { AdminAuditController } from '../audit.controller';
import { AuditService, type CreateAuditLogDto } from '../audit.service';

type AuditServiceMock = {
  create: jest.Mock<Promise<void>, [CreateAuditLogDto]>;
  findAll: jest.Mock<Promise<{ data: Array<{ id: string; action: string }>; total: number }>, [object]>;
};

class AuditRoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const requestContext = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const role = requestContext.headers['x-test-role'] ?? 'SUPER_ADMIN';
    if (role !== 'SUPER_ADMIN' && role !== 'TENANT_ADMIN') {
      throw new ForbiddenException('Admin audit logs require SUPER_ADMIN or TENANT_ADMIN');
    }
    return true;
  }
}

function executionContext(req: object): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

describe('AuditInterceptor loan action capture', () => {
  it('captures loan application actions with sanitized payload metadata', async () => {
    const auditService: AuditServiceMock = {
      create: jest.fn().mockResolvedValue(undefined),
      findAll: jest.fn(),
    };
    const interceptor = new AuditInterceptor(auditService as unknown as AuditService);
    const req = {
      method: 'POST',
      url: '/api/v1/members/loans/apply',
      ip: '197.248.10.20',
      headers: { 'user-agent': 'jest', 'x-request-id': 'req-123' },
      tenant: { id: 'tenant-1' },
      user: { id: 'user-1' },
      body: {
        loanProductId: 'product-1',
        principalAmount: 50000,
        password: 'should-not-be-stored',
      },
    };
    const next: CallHandler = { handle: () => of({ id: 'loan-1' }) };

    interceptor.intercept(executionContext(req), next).subscribe();
    await new Promise((resolve) => setImmediate(resolve));

    expect(auditService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'LOAN.APPLY',
        entityType: 'Loan',
        ipAddress: '197.248.10.20',
        metadata: expect.objectContaining({
          payload: expect.objectContaining({
            loanProductId: 'product-1',
            principalAmount: 50000,
          }),
        }),
      }),
    );
    const payload = auditService.create.mock.calls[0][0].metadata?.payload as Record<string, unknown>;
    expect(payload.password).toBeUndefined();
  });
});

describe('AdminAuditController', () => {
  let app: INestApplication;
  const auditService: AuditServiceMock = {
    create: jest.fn().mockResolvedValue(undefined),
    findAll: jest.fn().mockResolvedValue({
      data: [{ id: 'audit-1', action: 'LOAN.APPLY' }],
      total: 1,
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAuditController],
      providers: [
        { provide: AuditService, useValue: auditService },
        { provide: APP_GUARD, useClass: AuditRoleGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use((req: ExpressRequest & { tenant?: { id: string }; user?: { id: string; role: string } }, _res: ExpressResponse, next: NextFunction) => {
      req.tenant = { id: 'tenant-1' };
      req.user = { id: 'admin-1', role: 'SUPER_ADMIN' };
      next();
    });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns paginated admin audit logs with filters', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/audit-logs?page=1&limit=20&action=LOAN.APPLY')
      .set('x-test-role', 'SUPER_ADMIN')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toEqual([{ id: 'audit-1', action: 'LOAN.APPLY' }]);
        expect(body.meta).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
      });

    expect(auditService.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'LOAN.APPLY',
        limit: 20,
        offset: 0,
      }),
    );
  });

  it('rejects non-admin roles through the guard', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/audit-logs')
      .set('x-test-role', 'MEMBER')
      .expect(403);
  });
});
