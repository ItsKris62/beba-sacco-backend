import { LoanStatus, GuarantorStatus } from '@prisma/client';
import { LoansService } from '../loans.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { RedisService } from '../../../common/services/redis.service';
import { CacheService } from '../../../common/services/cache.service';
import { IdempotencyService } from '../../../common/services/idempotency.service';
import { DisbursementGateService } from '../../../loans/disbursement-gate.service';
import { ProductRuleService } from '../product-rule.service';
import { LedgerService } from '../../accounting/ledger.service';
import { ApprovalChainService } from '../../fraud/approval-chain.service';
import { BehavioralRiskScorerService } from '../../fraud/risk-scorer/behavioral-risk-scorer.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

const TENANT_ID = 'tenant-uuid-1';

describe('LoansService.getPendingApprovalQueue', () => {
  function buildService(args: {
    loans?: Array<Record<string, unknown>>;
    guarantors?: Array<Record<string, unknown>>;
  } = {}) {
    const loanFindMany = jest.fn().mockResolvedValue(
      args.loans ?? [
        {
          id: 'loan-1',
          loanNumber: 'LN-2026-000001',
          status: LoanStatus.PENDING_APPROVAL,
          principalAmount: '50000.0000',
          tenureMonths: 12,
          monthlyInstalment: '4500.0000',
          purpose: 'Business',
          appliedAt: new Date('2026-07-01T00:00:00Z'),
          member: {
            memberNumber: 'M-001',
            user: { firstName: 'Jane', lastName: 'Doe', phone: '254712345678', phoneNumber: null },
          },
          loanProduct: {
            name: 'Standard Loan',
            interestRate: '12.5000',
            minGuarantors: 2,
            guarantorCoverageRatio: '1.0000',
          },
        },
      ],
    );
    const guarantorFindMany = jest.fn().mockResolvedValue(
      args.guarantors ?? [
        {
          loanId: 'loan-1',
          guaranteedAmount: '25000.0000',
          respondedAt: new Date('2026-07-02T00:00:00Z'),
          member: { memberNumber: 'M-002', user: { firstName: 'John', lastName: 'Smith' } },
        },
      ],
    );

    const prisma = {
      loan: { findMany: loanFindMany },
      loanGuarantor: { findMany: guarantorFindMany },
    } as unknown as PrismaService;

    const service = new LoansService(
      prisma,
      {} as unknown as AuditService,
      {} as unknown as RedisService,
      {} as unknown as CacheService,
      {} as unknown as IdempotencyService,
      {} as never,
      {} as never,
      {} as unknown as DisbursementGateService,
      {} as unknown as ProductRuleService,
      {} as unknown as LedgerService,
      {} as unknown as ApprovalChainService,
      {} as unknown as BehavioralRiskScorerService,
      { emit: jest.fn() } as unknown as EventEmitter2,
    );

    return { service, loanFindMany, guarantorFindMany };
  }

  it('filters strictly by tenantId and status=PENDING_APPROVAL', async () => {
    const { service, loanFindMany } = buildService();

    await service.getPendingApprovalQueue(TENANT_ID);

    expect(loanFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_ID, status: LoanStatus.PENDING_APPROVAL },
      }),
    );
  });

  it('enriches each loan with member contact, product terms, and accepted guarantors', async () => {
    const { service } = buildService();

    const result = await service.getPendingApprovalQueue(TENANT_ID);

    expect(result.data).toHaveLength(1);
    const loan = result.data[0];
    expect(loan.member).toEqual({
      memberNumber: 'M-001',
      firstName: 'Jane',
      lastName: 'Doe',
      phone: '254712345678',
    });
    expect(loan.loanProduct).toEqual({
      name: 'Standard Loan',
      interestRate: 12.5,
      minGuarantors: 2,
      guarantorCoverageRatio: 1,
    });
    expect(loan.acceptedGuarantors).toEqual([
      {
        memberNumber: 'M-002',
        firstName: 'John',
        lastName: 'Smith',
        guaranteedAmount: 25000,
        respondedAt: new Date('2026-07-02T00:00:00Z'),
      },
    ]);
  });

  it('falls back to user.phoneNumber when user.phone is null', async () => {
    const { service } = buildService({
      loans: [
        {
          id: 'loan-2',
          loanNumber: 'LN-2026-000002',
          status: LoanStatus.PENDING_APPROVAL,
          principalAmount: '10000.0000',
          tenureMonths: 6,
          monthlyInstalment: '1800.0000',
          purpose: 'School fees',
          appliedAt: new Date(),
          member: {
            memberNumber: 'M-003',
            user: { firstName: 'A', lastName: 'B', phone: null, phoneNumber: '254700000000' },
          },
          loanProduct: {
            name: 'Emergency Loan',
            interestRate: '15.0000',
            minGuarantors: 1,
            guarantorCoverageRatio: '1.0000',
          },
        },
      ],
      guarantors: [],
    });

    const result = await service.getPendingApprovalQueue(TENANT_ID);

    expect(result.data[0].member.phone).toBe('254700000000');
    expect(result.data[0].acceptedGuarantors).toEqual([]);
  });

  it('returns an empty guarantor list without querying loanGuarantor when there are no loans', async () => {
    const { service, guarantorFindMany } = buildService({ loans: [] });

    const result = await service.getPendingApprovalQueue(TENANT_ID);

    expect(result.data).toEqual([]);
    expect(guarantorFindMany).not.toHaveBeenCalled();
  });

  it('scopes the accepted-guarantors query to ACCEPTED status only', async () => {
    const { service, guarantorFindMany } = buildService();

    await service.getPendingApprovalQueue(TENANT_ID);

    expect(guarantorFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: GuarantorStatus.ACCEPTED }),
      }),
    );
  });
});
