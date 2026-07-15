import { CallHandler, CanActivate, ExecutionContext, INestApplication, NestInterceptor } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Observable } from 'rxjs';
import { UserRole } from '@prisma/client';
import { TenantsController } from '../tenants.controller';
import { TenantsService } from '../tenants.service';
import { RBACGuard } from '../../../common/guards/rbac.guard';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';

class StubTenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ tenant: { id: string } }>();
    req.tenant = { id: tenantId };
    return next.handle();
  }
}

class StubAuthGuard implements CanActivate {
  constructor(private readonly role: UserRole | null) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.role) return true;
    const req = context.switchToHttp().getRequest<{ user: { id: string; role: UserRole } }>();
    req.user = { id: actorId, role: this.role };
    return true;
  }
}

async function buildApp(authGuard: StubAuthGuard, tenantsService: Partial<TenantsService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [TenantsController],
    providers: [
      Reflector,
      { provide: TenantsService, useValue: tenantsService },
      { provide: APP_GUARD, useValue: authGuard },
      { provide: APP_GUARD, useClass: RBACGuard },
      { provide: APP_INTERCEPTOR, useClass: StubTenantInterceptor },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('TenantsController - GET /tenants/public-info', () => {
  let app: INestApplication;
  const tenantsService = {
    getPublicInfo: jest.fn().mockResolvedValue({
      name: 'KC Boda Sacco',
      contactEmail: 'info@kcboda.co.ke',
      contactPhone: '0700000000',
      address: 'Kisumu, Kenya',
      logoUrl: null,
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    app = await buildApp(new StubAuthGuard(null), tenantsService);
  });

  afterEach(async () => {
    await app.close();
  });

  it('is reachable without an Authorization header or user role', async () => {
    const res = await request(app.getHttpServer()).get('/tenants/public-info').expect(200);

    expect(tenantsService.getPublicInfo).toHaveBeenCalledWith(tenantId);
    expect(res.body).toEqual({
      name: 'KC Boda Sacco',
      contactEmail: 'info@kcboda.co.ke',
      contactPhone: '0700000000',
      address: 'Kisumu, Kenya',
      logoUrl: null,
    });
  });
});

describe('TenantsController - PATCH /tenants/settings', () => {
  let app: INestApplication;
  const tenantsService = {
    updateSettings: jest.fn().mockResolvedValue({
      maxConcurrentGuarantees: 3,
      name: 'Updated Name',
      contactEmail: 'new@kcboda.co.ke',
      contactPhone: '0700000000',
      address: 'Kisumu, Kenya',
      logoUrl: null,
    }),
  };

  afterEach(async () => {
    await app.close();
  });

  it('rejects requests from a MEMBER role', async () => {
    app = await buildApp(new StubAuthGuard(UserRole.MEMBER), tenantsService);

    await request(app.getHttpServer())
      .patch('/tenants/settings')
      .send({ name: 'Updated Name' })
      .expect(403);

    expect(tenantsService.updateSettings).not.toHaveBeenCalled();
  });

  it('allows TENANT_ADMIN to update org profile fields and passes actor/tenant context', async () => {
    app = await buildApp(new StubAuthGuard(UserRole.TENANT_ADMIN), tenantsService);

    await request(app.getHttpServer())
      .patch('/tenants/settings')
      .send({ name: 'Updated Name', contactEmail: 'new@kcboda.co.ke' })
      .expect(200);

    expect(tenantsService.updateSettings).toHaveBeenCalledWith(
      tenantId,
      { name: 'Updated Name', contactEmail: 'new@kcboda.co.ke' },
      actorId,
      expect.anything(),
    );
  });
});
