import { BadRequestException, CanActivate, ExecutionContext, ForbiddenException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import { LoanStatus, UserRole } from '@prisma/client';
import { MemberPortalController } from '../../members/member-portal.controller';
import { LoanAdminController } from '../loan-admin.controller';
import { MembersService } from '../../members/members.service';
import { MemberPortalService } from '../../members/member-portal.service';
import { LoansService } from '../loans.service';
import { LoanApplicationService } from '../loan-application.service';
import { StatementService } from '../../statements/statement.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { DashboardService } from '../../dashboard/dashboard.service';
import { DocumentsService } from '../../documents/documents.service';
import { LoanReviewService } from '../loan-review.service';
import { LoanRecoveryService } from '../loan-recovery.service';
import { SmsService } from '../../sms/sms.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const memberId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const productId = '44444444-4444-4444-8444-444444444444';
const loanId = '55555555-5555-4555-8555-555555555555';

class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const requestContext = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      originalUrl?: string;
      url?: string;
      user?: { id: string; role: UserRole; tenantId: string };
      tenant?: { id: string };
    }>();
    const roleHeader = requestContext.headers['x-test-role'];
    const role = roleHeader && roleHeader in UserRole ? (roleHeader as UserRole) : UserRole.MEMBER;
    requestContext.user = { id: userId, role, tenantId };
    requestContext.tenant = { id: tenantId };

    const path = requestContext.originalUrl ?? requestContext.url ?? '';
    if (path.includes('/admin') && role === UserRole.MEMBER) {
      throw new ForbiddenException('Access denied');
    }
    return true;
  }
}

describe('Loan workflow controllers', () => {
  let app: INestApplication;
  const smsService = {
    enqueueSms: jest.fn().mockResolvedValue(undefined),
  };
  const loanApplicationService = {
    memberApply: jest.fn().mockResolvedValue({ id: loanId, status: LoanStatus.PENDING_GUARANTORS }),
    updateStatus: jest.fn(async (_loanId: string, dto: { status: string }) => {
      if (dto.status === 'REJECTED') throw new BadRequestException('Reason is required when rejecting a loan');
      await smsService.enqueueSms(
        { type: 'LOAN_APPROVED', phone: '0712345678', message: 'Loan approved' },
        `loan.statusSms:${loanId}:APPROVED`,
      );
      return { id: loanId, status: dto.status };
    }),
    getGuarantorExposure: jest.fn(),
  };
  const prismaService = {
    member: { findFirst: jest.fn().mockResolvedValue({ id: memberId }) },
    loan: { findFirst: jest.fn() },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      controllers: [MemberPortalController, LoanAdminController],
      providers: [
        { provide: APP_GUARD, useClass: TestAuthGuard },
        { provide: MembersService, useValue: {} },
        { provide: MemberPortalService, useValue: { getLoanDetail: jest.fn() } },
        { provide: LoansService, useValue: { disburse: jest.fn(), apply: jest.fn() } },
        { provide: LoanApplicationService, useValue: loanApplicationService },
        { provide: StatementService, useValue: { getFosaStatement: jest.fn() } },
        { provide: PrismaService, useValue: prismaService },
        { provide: DashboardService, useValue: { getMemberDashboard: jest.fn() } },
        { provide: DocumentsService, useValue: {} },
        { provide: LoanReviewService, useValue: { process: jest.fn() } },
        { provide: LoanRecoveryService, useValue: { recoverFromGuarantors: jest.fn() } },
        { provide: SmsService, useValue: smsService },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates a member loan application through POST /api/v1/members/loans/apply', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/members/loans/apply')
      .set('x-test-role', UserRole.MEMBER)
      .send({
        loanProductId: productId,
        principalAmount: 50000,
        tenureMonths: 12,
        purpose: 'School fees',
        guarantors: [{ memberId: '66666666-6666-4666-8666-666666666666', guaranteedAmount: 50000 }],
      })
      .expect(201);

    expect(loanApplicationService.memberApply).toHaveBeenCalledWith(
      expect.objectContaining({ loanProductId: productId, principalAmount: 50000 }),
      tenantId,
      memberId,
      userId,
      expect.any(Object),
      undefined,
    );
  });

  it('returns class-validator errors for invalid loan application payloads', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/members/loans/apply')
      .set('x-test-role', UserRole.MEMBER)
      .send({ principalAmount: -1, tenureMonths: 12 })
      .expect(400);

    expect(response.body.message).toEqual(
      expect.arrayContaining([
        expect.stringContaining('loanProductId must be a UUID'),
        expect.stringContaining('principalAmount must not be less than 100'),
      ]),
    );
  });

  it('allows a loan officer to approve a loan and enqueues applicant SMS', async () => {
    prismaService.loan.findFirst.mockResolvedValueOnce({ status: LoanStatus.PENDING_APPROVAL });

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/loans/${loanId}/status`)
      .set('x-test-role', UserRole.LOAN_OFFICER)
      .send({ status: 'APPROVED' })
      .expect(200);

    expect(loanApplicationService.updateStatus).toHaveBeenCalledWith(
      loanId,
      { status: 'APPROVED' },
      tenantId,
      expect.objectContaining({ role: UserRole.LOAN_OFFICER }),
      expect.any(Object),
    );
    expect(smsService.enqueueSms).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'LOAN_APPROVED' }),
      `loan.statusSms:${loanId}:APPROVED`,
    );
  });

  it('returns 400 when rejecting a loan without a reason', async () => {
    prismaService.loan.findFirst.mockResolvedValueOnce({ status: LoanStatus.PENDING_APPROVAL });

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/loans/${loanId}/status`)
      .set('x-test-role', UserRole.LOAN_OFFICER)
      .send({ status: 'REJECTED', reason: '' })
      .expect(400);
  });

  it('returns 403 when a MEMBER role accesses admin loan routes', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/admin/members/${memberId}/guarantor-exposure`)
      .set('x-test-role', UserRole.MEMBER)
      .expect(403);
  });
});
