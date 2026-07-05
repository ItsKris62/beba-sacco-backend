import { CallHandler, ExecutionContext, INestApplication, NestInterceptor } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Observable } from 'rxjs';
import { LoansController } from '../loans.controller';
import { LoansService } from '../loans.service';
import { JwtAuthGuard } from '../../../common/guards/jwt.guard';
import { RBACGuard } from '../../../common/guards/rbac.guard';

const tenantId = '11111111-1111-4111-8111-111111111111';

class StubTenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ tenant: { id: string } }>();
    req.tenant = { id: tenantId };
    return next.handle();
  }
}

describe('LoansController - GET /loans/products/public', () => {
  let app: INestApplication;
  const loansService = {
    findAllProducts: jest.fn().mockResolvedValue([{ id: 'p1', name: 'Jipange Loan', isActive: true }]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      controllers: [LoansController],
      providers: [
        Reflector,
        { provide: LoansService, useValue: loansService },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RBACGuard },
        { provide: APP_INTERCEPTOR, useClass: StubTenantInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('is reachable without an Authorization header or user role', async () => {
    await request(app.getHttpServer()).get('/loans/products/public').expect(200);

    expect(loansService.findAllProducts).toHaveBeenCalledWith(tenantId, false);
  });

  it('ignores includeInactive and always requests active-only products', async () => {
    await request(app.getHttpServer())
      .get('/loans/products/public?includeInactive=true')
      .expect(200);

    expect(loansService.findAllProducts).toHaveBeenCalledWith(tenantId, false);
  });
});
