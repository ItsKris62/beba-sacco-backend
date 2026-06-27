import { JwtService } from '@nestjs/jwt';
import { LoanStatus, TicketCategory, TicketPriority, TicketStatus, UserRole } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import * as argon2 from 'argon2';
import { TestAppContext, TestAppFactory } from './helpers/test-app.factory';
import { StorageService } from '../src/modules/storage/storage.service';

function expectForbiddenOrNotFound(status: number) {
  expect([403, 404]).toContain(status);
}

describe('Support tenant isolation E2E', () => {
  let ctx: TestAppContext;
  let jwt: JwtService;
  let tenantAId: string;
  let tenantBId: string;
  let memberAToken: string;
  let memberBToken: string;
  let staffAToken: string;
  let staffBToken: string;
  let memberAId: string;
  let memberBId: string;
  let ticketAId: string;
  let ticketBId: string;
  let loanBId: string;

  beforeAll(async () => {
    ctx = await TestAppFactory.create();
    jwt = ctx.app.get(JwtService);
    const storage = ctx.app.get(StorageService);
    jest.spyOn(storage, 'getUploadUrlForKey').mockImplementation(async ({ objectKey }) => ({
      uploadUrl: `https://storage.test/${encodeURIComponent(objectKey)}`,
      objectKey,
      expiresIn: 300,
    }));
    jest.spyOn(storage, 'fileExists').mockResolvedValue(true);

    tenantAId = ctx.seed.tenantId;
    memberAId = ctx.seed.memberId;
    memberAToken = ctx.seed.memberToken;

    tenantBId = uuidv4();
    const passwordHash = await argon2.hash('TestPassword123!');

    await ctx.prisma.tenant.create({
      data: {
        id: tenantBId,
        name: 'TenantB SACCO',
        slug: 'tenant-b-sacco',
        schemaName: 'tenant_tenant_b_sacco',
        status: 'ACTIVE',
        contactEmail: 'tenant-b@sacco.co.ke',
        contactPhone: '254700000002',
      },
    });
    await ctx.prisma.tenantCounter.create({ data: { tenantId: tenantBId, memberSeq: 0, accountSeq: 0, loanSeq: 0 } });

    const staffAId = uuidv4();
    const staffBId = uuidv4();
    const memberBUserId = uuidv4();

    await ctx.prisma.user.createMany({
      data: [
        {
          id: staffAId,
          tenantId: tenantAId,
          email: 'support-staff-a@test-sacco.co.ke',
          passwordHash,
          role: UserRole.LOAN_OFFICER,
          firstName: 'Staff',
          lastName: 'A',
          phone: '254755555551',
          isActive: true,
          emailVerified: true,
          status: 'APPROVED',
        },
        {
          id: staffBId,
          tenantId: tenantBId,
          email: 'support-staff-b@test-sacco.co.ke',
          passwordHash,
          role: UserRole.LOAN_OFFICER,
          firstName: 'Staff',
          lastName: 'B',
          phone: '254755555552',
          isActive: true,
          emailVerified: true,
          status: 'APPROVED',
        },
        {
          id: memberBUserId,
          tenantId: tenantBId,
          email: 'member-b@test-sacco.co.ke',
          passwordHash,
          role: UserRole.MEMBER,
          firstName: 'Member',
          lastName: 'B',
          phone: '254755555553',
          isActive: true,
          emailVerified: true,
          status: 'APPROVED',
        },
      ],
    });

    memberBId = uuidv4();
    await ctx.prisma.member.create({
      data: {
        id: memberBId,
        tenantId: tenantBId,
        userId: memberBUserId,
        memberNumber: 'B-000001',
        nationalId: '22345678',
        isActive: true,
        kycStatus: 'APPROVED',
      },
    });

    const loanProductBId = uuidv4();
    await ctx.prisma.loanProduct.create({
      data: {
        id: loanProductBId,
        tenantId: tenantBId,
        name: 'TenantB Development Loan',
        minAmount: new Decimal(1000).toDecimalPlaces(4).toString(),
        maxAmount: new Decimal(100000).toDecimalPlaces(4).toString(),
        interestRate: new Decimal(0.12).toDecimalPlaces(4).toString(),
        interestType: 'REDUCING_BALANCE',
        maxTenureMonths: 12,
        processingFeeRate: new Decimal(0.02).toDecimalPlaces(4).toString(),
        isActive: true,
      },
    });

    loanBId = uuidv4();
    await ctx.prisma.loan.create({
      data: {
        id: loanBId,
        tenantId: tenantBId,
        memberId: memberBId,
        loanProductId: loanProductBId,
        loanNumber: 'B-LN-2026-000001',
        status: LoanStatus.APPROVED,
        principalAmount: new Decimal(25000).toDecimalPlaces(4).toString(),
        interestRate: new Decimal(0.12).toDecimalPlaces(4).toString(),
        processingFee: new Decimal(500).toDecimalPlaces(4).toString(),
        tenureMonths: 6,
        monthlyInstalment: new Decimal(4402.58).toDecimalPlaces(4).toString(),
        outstandingBalance: new Decimal(25000).toDecimalPlaces(4).toString(),
        totalRepaid: new Decimal(0).toDecimalPlaces(4).toString(),
        appliedAt: new Date(),
        approvedAt: new Date(),
        approvedBy: staffBId,
      },
    });

    const [ticketA, ticketB] = await Promise.all([
      ctx.prisma.supportTicket.create({
        data: {
          tenantId: tenantAId,
          memberId: memberAId,
          subject: 'TenantA ticket',
          description: 'TenantA member needs help.',
          status: TicketStatus.OPEN,
          priority: TicketPriority.MEDIUM,
          category: TicketCategory.LOAN_QUERY,
        },
      }),
      ctx.prisma.supportTicket.create({
        data: {
          tenantId: tenantBId,
          memberId: memberBId,
          subject: 'TenantB ticket',
          description: 'TenantB member needs help.',
          status: TicketStatus.OPEN,
          priority: TicketPriority.MEDIUM,
          category: TicketCategory.LOAN_QUERY,
        },
      }),
    ]);
    ticketAId = ticketA.id;
    ticketBId = ticketB.id;

    staffAToken = jwt.sign({ sub: staffAId, email: 'support-staff-a@test-sacco.co.ke', role: UserRole.LOAN_OFFICER, tenantId: tenantAId, jti: uuidv4() });
    staffBToken = jwt.sign({ sub: staffBId, email: 'support-staff-b@test-sacco.co.ke', role: UserRole.LOAN_OFFICER, tenantId: tenantBId, jti: uuidv4() });
    memberBToken = jwt.sign({ sub: memberBUserId, email: 'member-b@test-sacco.co.ke', role: UserRole.MEMBER, tenantId: tenantBId, jti: uuidv4() });
  }, 60000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await ctx.teardown();
  }, 30000);

  it('allows MemberA to read their own ticket', async () => {
    await ctx.request()
      .get(`/api/support/tickets/${ticketAId}`)
      .set('Authorization', `Bearer ${memberAToken}`)
      .set('X-Tenant-ID', tenantAId)
      .expect(200);
  });

  it('blocks MemberB from reading MemberA ticket', async () => {
    const res = await ctx.request()
      .get(`/api/support/tickets/${ticketAId}`)
      .set('Authorization', `Bearer ${memberBToken}`)
      .set('X-Tenant-ID', tenantAId);

    expectForbiddenOrNotFound(res.status);
  });

  it('allows StaffA to read tickets in TenantA', async () => {
    await ctx.request()
      .get(`/api/support/tickets/${ticketAId}`)
      .set('Authorization', `Bearer ${staffAToken}`)
      .set('X-Tenant-ID', tenantAId)
      .expect(200);
  });

  it('blocks StaffB from reading tickets in TenantA', async () => {
    const res = await ctx.request()
      .get(`/api/support/tickets/${ticketAId}`)
      .set('Authorization', `Bearer ${staffBToken}`)
      .set('X-Tenant-ID', tenantAId);

    expectForbiddenOrNotFound(res.status);
  });

  it('blocks MemberA from creating a ticket with MemberB relatedLoanId', async () => {
    const res = await ctx.request()
      .post('/api/support/tickets')
      .set('Authorization', `Bearer ${memberAToken}`)
      .set('X-Tenant-ID', tenantAId)
      .send({
        subject: 'Cross tenant loan issue',
        description: 'This should not attach another tenant loan.',
        category: TicketCategory.LOAN_QUERY,
        relatedLoanId: loanBId,
      });

    expectForbiddenOrNotFound(res.status);
  });

  it('blocks MemberA from uploading an attachment to MemberB ticket', async () => {
    const res = await ctx.request()
      .post(`/api/support/tickets/${ticketBId}/attachments/presign`)
      .set('Authorization', `Bearer ${memberAToken}`)
      .set('X-Tenant-ID', tenantBId)
      .send({
        fileName: 'receipt.pdf',
        mimeType: 'application/pdf',
        size: 1024,
      });

    expectForbiddenOrNotFound(res.status);
  });
});
