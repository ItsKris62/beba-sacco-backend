import { Decimal } from 'decimal.js';
import { TestAppContext, TestAppFactory } from './helpers/test-app.factory';

describe('Guarantor workflow phases 1-3', () => {
  let ctx: TestAppContext;
  let productId: string;
  let phaseLoanId: string;

  beforeAll(async () => {
    ctx = await TestAppFactory.create();
    const product = await ctx.prisma.loanProduct.create({
      data: {
        tenantId: ctx.seed.tenantId,
        name: `Guarantor Product ${Date.now()}`,
        minAmount: new Decimal(1000).toDecimalPlaces(4).toString(),
        maxAmount: new Decimal(50000).toDecimalPlaces(4).toString(),
        requiredAccountType: 'FOSA',
        savingsMultiplier: new Decimal(3).toDecimalPlaces(4).toString(),
        minGuarantors: 1,
        maxGuarantors: 2,
        guarantorCoverageRatio: new Decimal(1).toDecimalPlaces(4).toString(),
        interestRate: new Decimal(0.12).toDecimalPlaces(4).toString(),
        interestType: 'REDUCING_BALANCE',
        maxTenureMonths: 12,
        processingFeeRate: new Decimal(0).toDecimalPlaces(4).toString(),
        isActive: true,
      },
    });
    productId = product.id;
  }, 60000);

  afterAll(async () => {
    await ctx.teardown();
  }, 30000);

  it('phase 1: looks up guarantor by National ID and applies with guarantorIds', async () => {
    const lookup = await ctx.request()
      .post('/api/members/guarantors/lookup')
      .set('Authorization', `Bearer ${ctx.seed.memberToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .send({ idNumber: '87654321' });

    expect(lookup.status).toBe(200);
    expect(lookup.body.memberId).toBe(ctx.seed.guarantorMemberId);
    expect(lookup.body.kycStatus).toBe('KYC_VERIFIED');
    expect(lookup.body.availableBalance).toBeGreaterThanOrEqual(30000);

    const apply = await ctx.request()
      .post('/api/members/loans/apply')
      .set('Authorization', `Bearer ${ctx.seed.memberToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .set('X-Idempotency-Key', `apply-${Date.now()}`)
      .send({ loanProductId: productId, principalAmount: 30000, tenureMonths: 6, guarantorIds: [lookup.body.memberId] });

    expect(apply.status).toBe(201);
    expect(apply.body.status).toBe('PENDING_GUARANTORS');
    phaseLoanId = apply.body.id;

    const guarantor = await ctx.prisma.loanGuarantor.findFirst({
      where: { tenantId: ctx.seed.tenantId, loanId: phaseLoanId, memberId: ctx.seed.guarantorMemberId },
    });
    expect(guarantor?.status).toBe('PENDING');
  });

  it('phase 2: shows guarantor dashboard requests and supports manager override decline', async () => {
    const requests = await ctx.request()
      .get('/api/members/guarantor/requests')
      .set('Authorization', `Bearer ${ctx.seed.guarantorToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId);

    expect(requests.status).toBe(200);
    expect(requests.body.some((item: { loanId: string }) => item.loanId === phaseLoanId)).toBe(true);

    const loan = await ctx.request()
      .post('/api/members/loans/apply')
      .set('Authorization', `Bearer ${ctx.seed.memberToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .set('X-Idempotency-Key', `apply-override-${Date.now()}`)
      .send({ loanProductId: productId, principalAmount: 10000, tenureMonths: 6, guarantorIds: [ctx.seed.guarantorMemberId] });

    expect(loan.status).toBe(201);

    const override = await ctx.request()
      .patch(`/api/admin/loans/${loan.body.id}/guarantors/${ctx.seed.guarantorMemberId}/status`)
      .set('Authorization', `Bearer ${ctx.seed.adminToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .send({ action: 'DECLINE', notes: 'Manager verified refusal' });

    expect(override.status).toBe(200);
    expect(override.body.status).toBe('REJECTED');
    expect(override.body.loanStatus).toBe('REJECTED_GUARANTOR_DECLINE');
  });

  it('phase 3: places hold on accept and enforces approval/disbursement gate', async () => {
    const before = await ctx.prisma.account.findFirst({
      where: { tenantId: ctx.seed.tenantId, memberId: ctx.seed.guarantorMemberId, accountType: 'FOSA' },
    });
    const lockedBefore = new Decimal(before?.lockedBalance.toString() ?? '0');

    const accept = await ctx.request()
      .post(`/api/members/loans/${phaseLoanId}/guarantor-response`)
      .set('Authorization', `Bearer ${ctx.seed.guarantorToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .set('X-Idempotency-Key', `accept-${Date.now()}`)
      .send({ action: 'ACCEPT', digitalAcknowledgment: true, notes: 'Accepted' });

    expect(accept.status).toBe(200);
    expect(accept.body.status).toBe('ACCEPTED');
    expect(accept.body.loanStatus).toBe('PENDING_REVIEW');

    const after = await ctx.prisma.account.findFirst({
      where: { tenantId: ctx.seed.tenantId, memberId: ctx.seed.guarantorMemberId, accountType: 'FOSA' },
    });
    expect(new Decimal(after?.lockedBalance.toString() ?? '0').minus(lockedBefore).toNumber()).toBe(30000);

    const approve = await ctx.request()
      .patch(`/api/admin/loans/${phaseLoanId}/status`)
      .set('Authorization', `Bearer ${ctx.seed.adminToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .send({ status: 'APPROVED', reason: 'Coverage met' });
    expect(approve.status).toBe(200);

    const disburse = await ctx.request()
      .patch(`/api/admin/loans/${phaseLoanId}/status`)
      .set('Authorization', `Bearer ${ctx.seed.adminToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .send({ status: 'DISBURSED' });
    expect([200, 201]).toContain(disburse.status);
    expect(disburse.body.loan.status).toBe('ACTIVE');
  });
});