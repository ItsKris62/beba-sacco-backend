import { expect } from '@jest/globals';
import { Decimal } from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import * as argon2 from 'argon2';
import { AccountStatus, AccountType, UserRole } from '@prisma/client';
import { GUARANTOR_EXPIRY_CHECK_JOB } from '../src/modules/queue/queue.constants';
import { GuarantorExpiryConsumer } from '../src/modules/queue/processors/guarantor-expiry.consumer';
import { TestAppContext, TestAppFactory } from './helpers/test-app.factory';

describe('Guarantor workflow phases 1-3', () => {
  let ctx: TestAppContext;
  let productId: string;
  let secondGuarantorMemberId: string;
  let secondGuarantorToken: string;

  beforeAll(async () => {
    ctx = await TestAppFactory.create();
    const passwordHash = await argon2.hash('TestPassword123!');
    const secondUserId = uuidv4();
    secondGuarantorMemberId = uuidv4();

    await ctx.prisma.user.create({
      data: {
        id: secondUserId,
        tenantId: ctx.seed.tenantId,
        email: 'guarantor2@test-sacco.co.ke',
        passwordHash,
        role: UserRole.MEMBER,
        firstName: 'Second',
        lastName: 'Guarantor',
        phone: '254744444444',
        emailVerified: true,
        accountStatus: AccountStatus.ACTIVE,
      },
    });
    await ctx.prisma.member.create({
      data: {
        id: secondGuarantorMemberId,
        tenantId: ctx.seed.tenantId,
        userId: secondUserId,
        memberNumber: 'M-000003',
        nationalId: '11223344',
        isActive: true,
        kycStatus: 'APPROVED',
      },
    });
    await ctx.prisma.account.create({
      data: {
        id: uuidv4(),
        tenantId: ctx.seed.tenantId,
        memberId: secondGuarantorMemberId,
        accountNumber: 'ACC-FOSA-000003',
        accountType: AccountType.FOSA,
        balance: new Decimal(60000).toDecimalPlaces(4).toString(),
        isActive: true,
        version: 0,
      },
    });
    const login = await ctx.request()
      .post('/api/auth/login')
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .send({ email: 'guarantor2@test-sacco.co.ke', password: 'TestPassword123!' });
    secondGuarantorToken = login.body.accessToken ?? login.body.data?.accessToken ?? '';

    const product = await ctx.prisma.loanProduct.create({
      data: {
        tenantId: ctx.seed.tenantId,
        name: `Guarantor Product ${Date.now()}`,
        minAmount: new Decimal(1000).toDecimalPlaces(4).toString(),
        maxAmount: new Decimal(100000).toDecimalPlaces(4).toString(),
        requiredAccountType: AccountType.FOSA,
        savingsMultiplier: new Decimal(10).toDecimalPlaces(4).toString(),
        minGuarantors: 2,
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
    if (ctx) await ctx.teardown();
  }, 30000);

  afterEach(async () => {
    if (!ctx) return;
    await ctx.prisma.loan.updateMany({
      where: {
        tenantId: ctx.seed.tenantId,
        memberId: ctx.seed.memberId,
        status: {
          in: [
            'DRAFT',
            'PENDING_GUARANTORS',
            'PENDING_REVIEW',
            'PENDING_APPROVAL',
            'APPROVED',
            'ACTIVE',
            'DISBURSED',
            'DEFAULTED',
          ],
        },
      },
      data: { status: 'FULLY_PAID', notes: 'E2E cleanup after guarantor workflow scenario' },
    });
  });

  async function applyWithTwoGuarantors(principalAmount = 30000) {
    return ctx.request()
      .post('/api/members/loans/apply')
      .set('Authorization', `Bearer ${ctx.seed.memberToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .set('X-Idempotency-Key', `apply-${principalAmount}-${Date.now()}-${Math.random()}`)
      .send({
        loanProductId: productId,
        principalAmount,
        tenureMonths: 6,
        guarantorIds: [ctx.seed.guarantorMemberId, secondGuarantorMemberId],
      });
  }

  it('happy path: ID lookup → apply → 2 accepts → admin approve → disburse', async () => {
    const lookup = await ctx.request()
      .post('/api/members/guarantors/lookup')
      .set('Authorization', `Bearer ${ctx.seed.memberToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .send({ idNumber: '87654321', requiredAmount: 15000 });
    expect(lookup.status).toBe(200);
    expect(lookup.body).toMatchObject({ memberId: ctx.seed.guarantorMemberId, kycStatus: 'KYC_VERIFIED', eligible: true });
    expect(lookup.body.maskedName).toMatch(/^G\*+ U\*+$/);
    expect(lookup.body.name).toBeUndefined();

    const apply = await applyWithTwoGuarantors(30000);
    expect(apply.status).toBe(201);
    expect(apply.body.status).toBe('PENDING_GUARANTORS');

    const acceptOne = await ctx.request()
      .post(`/api/members/loans/${apply.body.id}/guarantor-response`)
      .set('Authorization', `Bearer ${ctx.seed.guarantorToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .set('X-Idempotency-Key', `accept-g1-${Date.now()}`)
      .send({ action: 'ACCEPT', digitalAcknowledgment: true, notes: 'Accepted' });
    const acceptTwo = await ctx.request()
      .post(`/api/members/loans/${apply.body.id}/guarantor-response`)
      .set('Authorization', `Bearer ${secondGuarantorToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .set('X-Idempotency-Key', `accept-g2-${Date.now()}`)
      .send({ action: 'ACCEPT', digitalAcknowledgment: true, notes: 'Accepted' });
    expect(acceptOne.status).toBe(200);
    expect(acceptTwo.status).toBe(200);
    expect(acceptTwo.body.loanStatus).toBe('PENDING_REVIEW');

    const approve = await ctx.request()
      .patch(`/api/admin/loans/${apply.body.id}/status`)
      .set('Authorization', `Bearer ${ctx.seed.adminToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .send({ status: 'APPROVED', reason: 'Coverage met' });
    expect(approve.status).toBe(200);

    const disburse = await ctx.request()
      .patch(`/api/admin/loans/${apply.body.id}/status`)
      .set('Authorization', `Bearer ${ctx.seed.adminToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .send({ status: 'DISBURSED' });
    expect(disburse.status).toBe(200);
    expect(disburse.body.loan.status).toBe('ACTIVE');
  });

  it('edge 1: insufficient coverage returns 400', async () => {
    const response = await ctx.request()
      .post('/api/members/loans/apply')
      .set('Authorization', `Bearer ${ctx.seed.memberToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .set('X-Idempotency-Key', `insufficient-${Date.now()}`)
      .send({
        loanProductId: productId,
        principalAmount: 30000,
        tenureMonths: 6,
        guarantors: [
          { memberId: ctx.seed.guarantorMemberId, guaranteedAmount: 1000 },
          { memberId: secondGuarantorMemberId, guaranteedAmount: 1000 },
        ],
      });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('INSUFFICIENT_COVERAGE');
  });

  it('edge 2: admin override creates audit log and advances status', async () => {
    const apply = await applyWithTwoGuarantors(20000);
    expect(apply.status).toBe(201);

    const firstAccept = await ctx.request()
      .post(`/api/members/loans/${apply.body.id}/guarantor-response`)
      .set('Authorization', `Bearer ${ctx.seed.guarantorToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .set('X-Idempotency-Key', `accept-admin-edge-${Date.now()}`)
      .send({ action: 'ACCEPT', digitalAcknowledgment: true });
    expect(firstAccept.status).toBe(200);

    const override = await ctx.request()
      .patch(`/api/admin/loans/${apply.body.id}/guarantors/${secondGuarantorMemberId}/status`)
      .set('Authorization', `Bearer ${ctx.seed.adminToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .send({ action: 'ACCEPT', reason: 'Manager confirmed consent by recorded phone call' });
    expect(override.status).toBe(200);
    expect(override.body.status).toBe('ACCEPTED');
    expect(override.body.loanStatus).toBe('PENDING_REVIEW');

    const audit = await ctx.prisma.auditLog.findFirst({
      where: { tenantId: ctx.seed.tenantId, actorId: ctx.seed.adminUserId, action: 'GUARANTOR.ADMIN_OVERRIDE' },
      orderBy: { timestamp: 'desc' },
    });
    expect(audit?.prevHash).toBeDefined();
    expect(JSON.stringify(audit?.payload)).toContain('Manager confirmed consent');
  });

  it('edge 2b: guarantor decline leaves loan open for re-solicitation and reports remaining coverage', async () => {
    const apply = await applyWithTwoGuarantors(24690);
    expect(apply.status).toBe(201);
    expect(apply.body.status).toBe('PENDING_GUARANTORS');

    const firstAccept = await ctx.request()
      .post(`/api/members/loans/${apply.body.id}/guarantor-response`)
      .set('Authorization', `Bearer ${ctx.seed.guarantorToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .set('X-Idempotency-Key', `accept-decline-edge-${Date.now()}`)
      .send({ action: 'ACCEPT', digitalAcknowledgment: true });
    expect(firstAccept.status).toBe(200);
    expect(firstAccept.body.loanStatus).toBe('PENDING_GUARANTORS');

    const secondDecline = await ctx.request()
      .post(`/api/members/loans/${apply.body.id}/guarantor-response`)
      .set('Authorization', `Bearer ${secondGuarantorToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .set('X-Idempotency-Key', `decline-reinvite-edge-${Date.now()}`)
      .send({ action: 'DECLINE', notes: 'Unable to guarantee this loan' });
    expect(secondDecline.status).toBe(200);
    expect(secondDecline.body).toMatchObject({
      status: 'REJECTED',
      loanStatus: 'PENDING_GUARANTORS',
      remainingCoverage: 12345,
    });

    const loan = await ctx.prisma.loan.findFirst({
      where: { tenantId: ctx.seed.tenantId, id: apply.body.id },
      include: { guarantors: true },
    });
    expect(loan?.status).toBe('PENDING_GUARANTORS');
    expect(loan?.guarantors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: ctx.seed.guarantorMemberId,
          status: 'ACCEPTED',
        }),
        expect.objectContaining({
          memberId: secondGuarantorMemberId,
          status: 'REJECTED',
        }),
      ]),
    );

    const acceptedCoverage = (loan?.guarantors ?? [])
      .filter((guarantor) => guarantor.status === 'ACCEPTED')
      .reduce(
        (sum, guarantor) => sum.plus(new Decimal(guarantor.guaranteedAmount.toString())),
        new Decimal(0),
      );
    expect(new Decimal(24690).minus(acceptedCoverage).toNumber()).toBe(12345);

    const notification = await ctx.prisma.inAppNotification.findFirst({
      where: {
        tenantId: ctx.seed.tenantId,
        userId: ctx.seed.memberUserId,
        type: 'LOAN_GUARANTOR_DECLINED',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(notification?.body).toContain('12345');
  });

  it('edge 3: 72h expiry auto-declines and releases accepted holds', async () => {
    const apply = await applyWithTwoGuarantors(20000);
    expect(apply.status).toBe(201);

    const before = await ctx.prisma.account.findFirst({
      where: { tenantId: ctx.seed.tenantId, memberId: ctx.seed.guarantorMemberId, accountType: AccountType.FOSA },
    });
    const lockedBefore = new Decimal(before?.lockedBalance.toString() ?? '0');

    const firstAccept = await ctx.request()
      .post(`/api/members/loans/${apply.body.id}/guarantor-response`)
      .set('Authorization', `Bearer ${ctx.seed.guarantorToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .set('X-Idempotency-Key', `accept-expiry-edge-${Date.now()}`)
      .send({ action: 'ACCEPT', digitalAcknowledgment: true });
    expect(firstAccept.status).toBe(200);

    await ctx.prisma.loanGuarantor.updateMany({
      where: { tenantId: ctx.seed.tenantId, loanId: apply.body.id, memberId: secondGuarantorMemberId },
      data: { invitedAt: new Date(Date.now() - 73 * 60 * 60 * 1000) },
    });

    const consumer = ctx.app.get(GuarantorExpiryConsumer);
    await consumer.process({ id: 'expiry-edge', name: GUARANTOR_EXPIRY_CHECK_JOB, data: { tenantId: ctx.seed.tenantId } } as never);

    const expired = await ctx.prisma.loanGuarantor.findFirst({
      where: { tenantId: ctx.seed.tenantId, loanId: apply.body.id, memberId: secondGuarantorMemberId },
    });
    const loan = await ctx.prisma.loan.findFirst({ where: { tenantId: ctx.seed.tenantId, id: apply.body.id } });
    const after = await ctx.prisma.account.findFirst({
      where: { tenantId: ctx.seed.tenantId, memberId: ctx.seed.guarantorMemberId, accountType: AccountType.FOSA },
    });

    expect(expired?.status).toBe('EXPIRED');
    expect(loan?.status).toBe('REJECTED_GUARANTOR_DECLINE');
    expect(new Decimal(after?.lockedBalance.toString() ?? '0').equals(lockedBefore)).toBe(true);
  });
});
