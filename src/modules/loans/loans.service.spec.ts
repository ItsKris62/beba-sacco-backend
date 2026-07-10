import { NotImplementedException } from '@nestjs/common';
import { LoansService } from './loans.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RedisService } from '../../common/services/redis.service';
import { CacheService } from '../../common/services/cache.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { DisbursementGateService } from '../../loans/disbursement-gate.service';
import { ProductRuleService } from './product-rule.service';
import { LedgerService } from '../accounting/ledger.service';
import { ApprovalChainService } from '../fraud/approval-chain.service';
import { BehavioralRiskScorerService } from '../fraud/risk-scorer/behavioral-risk-scorer.service';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-uuid-1';
const MEMBER_ID = 'member-uuid-1';
const PRODUCT_ID = 'product-uuid-1';
const ACTOR_ID = 'user-uuid-1';

const APPLY_DTO = {
  memberId: MEMBER_ID,
  loanProductId: PRODUCT_ID,
  principalAmount: 50000,
  tenureMonths: 12,
  purpose: 'Business expansion',
};

// ─── Mock factories ───────────────────────────────────────────────────────────

const mockPrisma = {} as unknown as PrismaService;
const mockAudit = { create: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
const mockRedis = {} as unknown as RedisService;
const mockCache = {} as unknown as CacheService;
const mockIdempotency = {} as unknown as IdempotencyService;
const mockEmailQueue = { add: jest.fn().mockResolvedValue({}) };
const mockGuarantorQueue = { add: jest.fn().mockResolvedValue({}) };
const mockDisbursementGate = { assertPassed: jest.fn().mockResolvedValue(undefined) } as unknown as DisbursementGateService;
const mockProductRules = {
  assertLoanApplicationRules: jest.fn().mockReturnValue(undefined),
} as unknown as ProductRuleService;
const mockLedger = {} as unknown as LedgerService;
const mockApprovalChain = {} as unknown as ApprovalChainService;
const mockRiskScorer = {} as unknown as BehavioralRiskScorerService;

function makeService(): LoansService {
  return new LoansService(
    mockPrisma,
    mockAudit,
    mockRedis,
    mockCache,
    mockIdempotency,
    mockGuarantorQueue as never,
    mockEmailQueue as never,
    mockDisbursementGate,
    mockProductRules,
    mockLedger,
    mockApprovalChain,
    mockRiskScorer,
  );
}

// ─── Suite ───────────────────────────────────────────────────────────────────
//
// LoansService.apply() is a permanently-disabled legacy stub (loans.service.ts:232-247) —
// it unconditionally throws NotImplementedException regardless of input. Applications now
// go through LoanApplicationService.memberApply() (see loans/tests/loans.service.spec.ts and
// loan-application.service.spec.ts). This suite only confirms the stub stays disabled.

describe('LoansService.apply [M-5]', () => {
  beforeEach(() => jest.clearAllMocks());

  it('always throws NotImplementedException (legacy endpoint disabled)', async () => {
    const service = makeService();

    await expect(service.apply(APPLY_DTO, TENANT_ID, ACTOR_ID)).rejects.toThrow(
      new NotImplementedException(
        'Legacy loan application endpoint is disabled. Use the strict member loan application workflow.',
      ),
    );
  });
});
