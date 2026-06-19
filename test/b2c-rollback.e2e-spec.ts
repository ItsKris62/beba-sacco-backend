import { Test, TestingModule } from '@nestjs/testing';
process.env.WORKER_MODE = 'false';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { MpesaCallbackProcessor } from '../src/modules/queue/processors/mpesa-callback.processor';
import { Job } from 'bullmq';
import { AccountType, TransactionStatus, TransactionType, LoanStatus, GuarantorStatus, MpesaTxType, MpesaTriggerSource } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { LoansService } from '../src/modules/loans/loans.service';
import { LoanApplicationService } from '../src/modules/loans/loan-application.service';
import { LoanRecoveryService } from '../src/modules/loans/loan-recovery.service';

describe('B2C Rollback & Financial Workflows (Integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mpesaProcessor: MpesaCallbackProcessor;
  let loansService: LoansService;
  let loanApplicationService: LoanApplicationService;
  let loanRecoveryService: LoanRecoveryService;

  let tenantId: string;
  let memberId: string;
  let accountId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get<PrismaService>(PrismaService);
    mpesaProcessor = app.get<MpesaCallbackProcessor>(MpesaCallbackProcessor, { strict: false });
    loansService = app.get<LoansService>(LoansService);
    loanApplicationService = app.get<LoanApplicationService>(LoanApplicationService);
    loanRecoveryService = app.get<LoanRecoveryService>(LoanRecoveryService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Seed test data
    const tenant = await prisma.tenant.create({
      data: { name: 'Test Tenant B2C', slug: 'test-b2c-tenant', schemaName: 'test_b2c_tenant', contactEmail: 'admin@b2c.com', contactPhone: '254700000000' },
    });
    tenantId = tenant.id;

    const user = await prisma.user.create({
      data: { tenantId, email: `test-b2c-${Date.now()}@beba.co.ke`, firstName: 'John', lastName: 'Doe', passwordHash: 'dummy' },
    });

    const member = await prisma.member.create({
      data: {
        tenantId,
        userId: user.id,
        memberNumber: `M-${Date.now()}`,
        kycStatus: 'APPROVED',
      },
    });
    memberId = member.id;

    const account = await prisma.account.create({
      data: {
        tenantId,
        memberId,
        accountType: AccountType.FOSA,
        accountNumber: 'ACC-FOSA-' + Date.now(),
        balance: '10000',
        lockedBalance: '0',
        isActive: true,
      },
    });
    accountId = account.id;
  });

  it('1. should process a failed B2C withdrawal and refund the FOSA account exactly once', async () => {
    // 1. Create an MpesaTransaction for FOSA_WITHDRAWAL
    const mpesaTx = await prisma.mpesaTransaction.create({
      data: {
        tenantId,
        type: MpesaTxType.B2C,
        status: 'PENDING',
        amount: '500',
        phoneNumber: '254700000000',
        referenceType: 'FOSA_WITHDRAWAL',
        referenceId: accountId,
        triggerSource: MpesaTriggerSource.SYSTEM,
        reference: `B2C-${Date.now()}-1`,
        originatorConversationId: 'Originator-123',
        conversationId: 'Conv-123',
        checkoutRequestId: 'Req-123',
      },
    });

    // 2. Simulate failed B2C callback
    const job = {
      name: 'b2c-callback',
      data: {
        payload: {
          Result: {
            ResultType: 0,
            ResultCode: 2001,
            ResultDesc: 'The initiator information is invalid.',
            OriginatorConversationID: 'Originator-123',
            ConversationID: 'Conv-123',
            TransactionID: 'TX123FAILED',
          },
        },
        tenantId,
      },
    } as unknown as Job;

    await mpesaProcessor.process(job);

    // 3. Verify refund
    const refundedAccount = await prisma.account.findUnique({ where: { id: accountId } });
    expect(Number(refundedAccount!.balance)).toBe(10500); // 10000 + 500

    const updatedMpesaTx = await prisma.mpesaTransaction.findUnique({ where: { id: mpesaTx.id } });
    expect(updatedMpesaTx!.status).toBe('FAILED');

    // 4. Verify system transaction was created
    const sysTx = await prisma.transaction.findFirst({
      where: { accountId, type: TransactionType.DEPOSIT },
    });
    expect(sysTx).toBeDefined();
    expect(Number(sysTx!.amount)).toBe(500);
  });

  it('2. should not refund a successful B2C withdrawal', async () => {
    const mpesaTx = await prisma.mpesaTransaction.create({
      data: {
        tenantId,
        type: MpesaTxType.B2C,
        status: 'PENDING',
        amount: '500',
        phoneNumber: '254700000000',
        referenceType: 'FOSA_WITHDRAWAL',
        referenceId: accountId,
        triggerSource: MpesaTriggerSource.SYSTEM,
        reference: `B2C-${Date.now()}-2`,
        originatorConversationId: 'Originator-222',
        conversationId: 'Conv-222',
      },
    });

    const job = {
      name: 'b2c-callback',
      data: {
        payload: {
          Result: {
            ResultCode: 0,
            ResultDesc: 'Success',
            OriginatorConversationID: 'Originator-222',
            ConversationID: 'Conv-222',
            TransactionID: 'TX123SUCCESS',
          },
        },
        tenantId,
      },
    } as unknown as Job;

    await mpesaProcessor.process(job);

    const account = await prisma.account.findUnique({ where: { id: accountId } });
    expect(Number(account!.balance)).toBe(10000); // Balance should NOT increase

    const updatedMpesaTx = await prisma.mpesaTransaction.findUnique({ where: { id: mpesaTx.id } });
    expect(updatedMpesaTx!.status).toBe('COMPLETED');
  });

  it('3. should refuse to disburse a loan directly to M-Pesa', async () => {
    await expect(
      loansService.disburse('loan-123', tenantId, 'admin-123', '127.0.0.1', true)
    ).rejects.toThrow('Direct M-Pesa disbursement is disabled');
  });

  it('4. should calculate effective guarantor hold proportionally when loan balance is less than sum of holds', async () => {
    // Setup a loan with 10k principal, 5k outstanding, and two guarantors with 5k hold each (10k total holds).
    // The outstanding is 5k, which is 50% of the 10k total holds. So effective holds should be 2.5k each.
    
    const product = await prisma.loanProduct.create({
      data: {
        tenantId,
        name: 'Test Product',
        interestRate: '0.05',
        maxAmount: '50000',
        minAmount: '1000',
        maxTenureMonths: 12,
        requiredAccountType: 'FOSA'
      }
    });

    const loan = await prisma.loan.create({
      data: {
        tenantId,
        memberId,
        loanProductId: product.id,
        loanNumber: `LN-${Date.now()}`,
        principalAmount: '10000',
        interestRate: '0.05',
        outstandingBalance: '5000', // Paid down
        monthlyInstalment: '1000',
        status: LoanStatus.ACTIVE,
        tenureMonths: 12
      }
    });

    const gUser1 = await prisma.user.create({ data: { tenantId, email: `g1-${Date.now()}@beba.co.ke`, firstName: 'G1', lastName: 'G1', passwordHash: 'dummy' } });
    const gMember1 = await prisma.member.create({ data: { tenantId, userId: gUser1.id, memberNumber: `M-G1-${Date.now()}` } });
    const gUser2 = await prisma.user.create({ data: { tenantId, email: `g2-${Date.now()}@beba.co.ke`, firstName: 'G2', lastName: 'G2', passwordHash: 'dummy' } });
    const gMember2 = await prisma.member.create({ data: { tenantId, userId: gUser2.id, memberNumber: `M-G2-${Date.now()}` } });

    await prisma.loanGuarantor.create({
      data: { tenantId, loanId: loan.id, memberId: gMember1.id, guaranteedAmount: '5000', status: GuarantorStatus.ACCEPTED }
    });
    await prisma.loanGuarantor.create({
      data: { tenantId, loanId: loan.id, memberId: gMember2.id, guaranteedAmount: '5000', status: GuarantorStatus.ACCEPTED }
    });

    const exposure1 = await loanApplicationService.getGuarantorExposure(gMember1.id, tenantId);
    expect(exposure1.activeGuarantees[0].guaranteedAmount).toBeCloseTo(2500, 2);

    const exposure2 = await loanApplicationService.getGuarantorExposure(gMember2.id, tenantId);
    expect(exposure2.activeGuarantees[0].guaranteedAmount).toBeCloseTo(2500, 2);
  });

  // Test 5, 6, 7, 8, 9, 10 ... can be extrapolated to cover other functions or scenarios.
  it('5. should process B2C rollback atomically under concurrent calls', async () => {
    const mpesaTx = await prisma.mpesaTransaction.create({
      data: {
        tenantId,
        type: MpesaTxType.B2C,
        status: 'PENDING',
        amount: '1000',
        phoneNumber: '254700000000',
        referenceType: 'FOSA_WITHDRAWAL',
        referenceId: accountId,
        triggerSource: MpesaTriggerSource.SYSTEM,
        reference: `B2C-${Date.now()}-3`,
        originatorConversationId: 'Originator-333',
        conversationId: 'Conv-333',
      },
    });

    const job = {
      name: 'b2c-callback',
      data: {
        payload: {
          Result: {
            ResultCode: 2001,
            OriginatorConversationID: 'Originator-333',
            TransactionID: 'TX333',
          },
        },
        tenantId,
      },
    } as unknown as Job;

    // Run concurrently
    await Promise.allSettled([
      mpesaProcessor.process(job),
      mpesaProcessor.process(job),
      mpesaProcessor.process(job)
    ]);

    const account = await prisma.account.findUnique({ where: { id: accountId } });
    expect(Number(account!.balance)).toBe(11000); // Exactly ONE refund of 1000!
    
    const refunds = await prisma.transaction.count({
      where: { accountId, reference: { startsWith: 'REFUND-' } },
    });
    expect(refunds).toBe(1);
  });
});
