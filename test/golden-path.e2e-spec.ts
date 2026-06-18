import { Decimal } from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { AccountType } from '@prisma/client';
import { TestAppContext, TestAppFactory } from './helpers/test-app.factory';

describe('Golden Path Smoke E2E', () => {
  let ctx: TestAppContext;
  let productId: string;

  beforeAll(async () => {
    ctx = await TestAppFactory.create();

    await ctx.prisma.loan.update({
      where: { id: ctx.seed.loanId },
      data: { status: 'REJECTED', notes: 'Golden path starts with no active loans' },
    });

    const product = await ctx.prisma.loanProduct.create({
      data: {
        tenantId: ctx.seed.tenantId,
        name: `Development Loan Golden Path ${Date.now()}`,
        minAmount: new Decimal(1000).toDecimalPlaces(4).toString(),
        maxAmount: new Decimal(100000).toDecimalPlaces(4).toString(),
        requiredAccountType: AccountType.FOSA,
        savingsMultiplier: new Decimal(10).toDecimalPlaces(4).toString(),
        minGuarantors: 1,
        maxGuarantors: 1,
        guarantorCoverageRatio: new Decimal(1).toDecimalPlaces(4).toString(),
        interestRate: new Decimal(0.12).toDecimalPlaces(4).toString(),
        interestType: 'REDUCING_BALANCE',
        maxTenureMonths: 12,
        processingFeeRate: new Decimal(0.02).toDecimalPlaces(4).toString(),
        isActive: true,
      },
    });
    productId = product.id;
  }, 60000);

  afterAll(async () => {
    await ctx.prisma.ticketMessage.deleteMany({ where: { ticket: { tenantId: ctx.seed.tenantId } } });
    await ctx.prisma.supportTicket.deleteMany({ where: { tenantId: ctx.seed.tenantId } });
    await ctx.teardown();
  }, 30000);

  it('member applies, guarantor accepts, admin approves/disburses, member sees net FOSA credit, and support ticket reaches admin queue', async () => {
    const startingDashboard = await ctx.request()
      .get('/api/members/dashboard')
      .set('Authorization', `Bearer ${ctx.seed.memberToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId);

    expect(startingDashboard.status).toBe(200);
    expect(startingDashboard.body.activeLoans).toHaveLength(0);

    const accountBefore = await ctx.prisma.account.findUniqueOrThrow({
      where: { id: ctx.seed.memberAccountId },
    });
    const startingFosaBalance = new Decimal(accountBefore.balance.toString());
    const principal = new Decimal(20000);
    const processingFee = principal.mul(0.02).toDecimalPlaces(4);
    const expectedNetDisbursement = principal.minus(processingFee);

    const application = await ctx.request()
      .post('/api/members/loans/apply')
      .set('Authorization', `Bearer ${ctx.seed.memberToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .set('X-Idempotency-Key', `golden-apply-${uuidv4()}`)
      .send({
        loanProductId: productId,
        principalAmount: principal.toNumber(),
        tenureMonths: 6,
        guarantorIds: [ctx.seed.guarantorMemberId],
      });

    expect(application.status).toBe(201);
    expect(application.body.status).toBe('PENDING_GUARANTORS');

    const pendingGuarantees = await ctx.request()
      .get('/api/members/guarantor/requests')
      .set('Authorization', `Bearer ${ctx.seed.guarantorToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId);

    expect(pendingGuarantees.status).toBe(200);
    expect(pendingGuarantees.body.some((request: { loanId: string }) => request.loanId === application.body.id)).toBe(true);

    const guarantee = await ctx.request()
      .post(`/api/members/loans/${application.body.id}/guarantor-response`)
      .set('Authorization', `Bearer ${ctx.seed.guarantorToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .set('X-Idempotency-Key', `golden-accept-${uuidv4()}`)
      .send({ action: 'ACCEPT', digitalAcknowledgment: true, notes: 'Golden path guarantee accepted' });

    expect(guarantee.status).toBe(200);
    expect(guarantee.body.status).toBe('ACCEPTED');
    expect(guarantee.body.loanStatus).toBe('PENDING_REVIEW');

    const approval = await ctx.request()
      .patch(`/api/admin/loans/${application.body.id}/status`)
      .set('Authorization', `Bearer ${ctx.seed.adminToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .send({ status: 'APPROVED', reason: 'Golden path approval' });

    expect(approval.status).toBe(200);
    expect(approval.body.status).toBe('APPROVED');

    const disbursement = await ctx.request()
      .patch(`/api/admin/loans/${application.body.id}/status`)
      .set('Authorization', `Bearer ${ctx.seed.adminToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .set('Idempotency-Key', `golden-disburse-${uuidv4()}`)
      .send({ status: 'DISBURSED' });

    expect(disbursement.status).toBe(200);
    expect(disbursement.body.loan.status).toBe('ACTIVE');

    const accountAfter = await ctx.prisma.account.findUniqueOrThrow({
      where: { id: ctx.seed.memberAccountId },
    });
    const endingFosaBalance = new Decimal(accountAfter.balance.toString());
    expect(endingFosaBalance.equals(startingFosaBalance.plus(expectedNetDisbursement))).toBe(true);

    const ledgerEntries = await ctx.prisma.transaction.findMany({
      where: { tenantId: ctx.seed.tenantId, loanId: application.body.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(ledgerEntries.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(['LOAN_DISBURSEMENT', 'FEE_CHARGE']),
    );

    const memberDashboard = await ctx.request()
      .get('/api/members/dashboard')
      .set('Authorization', `Bearer ${ctx.seed.memberToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId);

    expect(memberDashboard.status).toBe(200);
    expect(memberDashboard.body.balances.fosa).toBe(endingFosaBalance.toNumber());
    expect(memberDashboard.body.activeLoans.some((loan: { id: string }) => loan.id === application.body.id)).toBe(true);

    const ticket = await ctx.request()
      .post('/api/support/tickets')
      .set('Authorization', `Bearer ${ctx.seed.memberToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .send({
        subject: 'Question about loan processing fee',
        description: 'Please explain why my development loan processing fee was deducted at disbursement.',
        category: 'LOAN_QUERY',
        priority: 'MEDIUM',
        relatedLoanId: application.body.id,
      });

    expect(ticket.status).toBe(201);
    expect(ticket.body.subject).toBe('Question about loan processing fee');

    const supportQueue = await ctx.request()
      .get('/api/support/tickets')
      .set('Authorization', `Bearer ${ctx.seed.adminToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId);

    expect(supportQueue.status).toBe(200);
    expect(supportQueue.body.some((row: { id: string }) => row.id === ticket.body.id)).toBe(true);
  }, 60000);
});
