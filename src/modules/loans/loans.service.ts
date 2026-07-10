import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  NotImplementedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash } from 'crypto';
import { Decimal } from 'decimal.js';
import {
  AccountType,
  GuarantorStatus,
  JournalEntryType,
  LoanStatus,
  Prisma,
  TransactionType,
  TransactionStatus,
  InterestType,
  UserRole,
} from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DOMAIN_EVENTS, DomainEventName } from '../../common/constants/events';
import { RedisService } from '../../common/services/redis.service';
import { CacheService } from '../../common/services/cache.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { CreateLoanProductDto } from './dto/create-loan-product.dto';
import { UpdateLoanProductDto } from './dto/update-loan-product.dto';
import { ApplyLoanDto } from './dto/apply-loan.dto';
import { InviteGuarantorsDto } from './dto/invite-guarantors.dto';
import { GuarantorAction, GuarantorResponseDto } from './dto/guarantor-response.dto';
import { RejectLoanDto } from './dto/reject-loan.dto';
import {
  QUEUE_NAMES,
  GuarantorReminderJobPayload,
  EmailJobPayload,
} from '../queue/queue.constants';
import { DisbursementGateService } from '../../loans/disbursement-gate.service';
import { ProductRuleService } from './product-rule.service';
import { LedgerService } from '../accounting/ledger.service';
import { ApprovalChainService } from '../fraud/approval-chain.service';
import { BehavioralRiskScorerService } from '../fraud/risk-scorer/behavioral-risk-scorer.service';

/**
 * Loans Service
 *
 * Instalment calculation:
 *  FLAT:             instalment = P * (1 + r_annual * n/12) / n
 *  REDUCING_BALANCE: instalment = P * r_monthly * (1+r_monthly)^n / ((1+r_monthly)^n - 1)
 *
 * All monetary arithmetic uses Decimal — never native number.
 *
 * Loan lifecycle (guarantor path):
 *   DRAFT → PENDING_GUARANTORS → PENDING_REVIEW → APPROVED → ACTIVE → FULLY_PAID | DEFAULTED
 * Loan lifecycle (direct-approval path, no guarantors):
 *   DRAFT → PENDING_APPROVAL → APPROVED → ACTIVE → FULLY_PAID | DEFAULTED
 * Either path can transition to REJECTED before APPROVED.
 */
@Injectable()
export class LoansService {
  private readonly logger = new Logger(LoansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly cache: CacheService,
    private readonly idempotency: IdempotencyService,
    @InjectQueue(QUEUE_NAMES.LOAN_GUARANTOR_REMINDER)
    private readonly guarantorReminderQueue: Queue<GuarantorReminderJobPayload>,
    @InjectQueue(QUEUE_NAMES.EMAIL)
    private readonly emailQueue: Queue<EmailJobPayload>,
    private readonly disbursementGate: DisbursementGateService,
    private readonly productRules: ProductRuleService,
    private readonly ledger: LedgerService,
    private readonly approvalChain: ApprovalChainService,
    private readonly riskScorer: BehavioralRiskScorerService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Fire-and-forget email dispatch.
   * Failures are logged but never propagate to the calling service method.
   */
  private enqueueEmail(payload: EmailJobPayload, ctx: string): void {
    this.emailQueue
      .add('send', payload, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 500,
        removeOnFail: { age: 86400, count: 50 },
      })
      .catch((e: unknown) =>
        this.logger.error(
          `[EmailQueue] enqueue failed [${ctx}]: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
  }

  private emitDomainEvent(eventName: DomainEventName, payload: Record<string, unknown>): void {
    try {
      this.eventEmitter.emit(eventName, payload);
    } catch (error: unknown) {
      this.logger.error(
        `Domain event emit failed (${eventName}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ─── LOAN PRODUCTS ───────────────────────────────────────────

  private async invalidateProductCache(tenantId: string): Promise<void> {
    await Promise.all([
      this.redis.del(`loan:products:${tenantId}:true`),
      this.redis.del(`loan:products:${tenantId}:false`),
    ]);
  }

  async createProduct(
    dto: CreateLoanProductDto,
    tenantId: string,
    createdBy: string,
    ipAddress?: string,
  ) {
    if (new Decimal(dto.minAmount).greaterThan(new Decimal(dto.maxAmount))) {
      throw new BadRequestException('minAmount must be less than or equal to maxAmount');
    }

    const existing = await this.prisma.loanProduct.findFirst({
      where: { tenantId, name: dto.name },
      select: { id: true },
    });
    if (existing) throw new ConflictException(`Loan product "${dto.name}" already exists`);

    const product = await this.prisma.loanProduct.create({
      data: {
        tenantId,
        name: dto.name,
        description: dto.description,
        minAmount: new Decimal(dto.minAmount).toDecimalPlaces(4).toString(),
        maxAmount: new Decimal(dto.maxAmount).toDecimalPlaces(4).toString(),
        interestRate: new Decimal(dto.interestRate).toDecimalPlaces(4).toString(),
        interestType: dto.interestType,
        maxTenureMonths: dto.maxTenureMonths,
        processingFeeRate: new Decimal(dto.processingFeeRate ?? 0).toDecimalPlaces(4).toString(),
        requiredAccountType: dto.requiredAccountType ?? null,
        savingsMultiplier: new Decimal(dto.savingsMultiplier ?? 3).toDecimalPlaces(4).toString(),
        minGuarantors: dto.minGuarantors ?? 0,
        maxGuarantors: dto.maxGuarantors ?? 3,
        guarantorCoverageRatio: new Decimal(dto.guarantorCoverageRatio ?? 1)
          .toDecimalPlaces(4)
          .toString(),
        requiresPayslip: dto.requiresPayslip ?? false,
        minActiveMonths: dto.minActiveMonths ?? 0,
        gracePeriodMonths: dto.gracePeriodMonths ?? 0,
        isActive: dto.isActive ?? true,
      },
    });

    await this.audit
      .create({
        tenantId,
        userId: createdBy,
        action: 'LOAN_PRODUCT.CREATE',
        resource: 'LoanProduct',
        resourceId: product.id,
        metadata: { name: product.name },
        ipAddress,
      })
      .catch((e: unknown) => this.logger.error('Audit write failed', e));

    await this.invalidateProductCache(tenantId);

    return product;
  }

  async findAllProducts(tenantId: string, includeInactive = false) {
    const cacheKey = `loan:products:${tenantId}:${includeInactive}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        /* fallthrough */
      }
    }
    const products = await this.prisma.loanProduct.findMany({
      where: { tenantId, ...(!includeInactive && { isActive: true }) },
      orderBy: { name: 'asc' },
    });
    await this.redis.set(cacheKey, JSON.stringify(products), 300); // 5 min TTL
    return products;
  }

  async findOneProduct(id: string, tenantId: string) {
    const product = await this.prisma.loanProduct.findFirst({
      where: { id, tenantId },
      include: { _count: { select: { loans: true } } },
    });
    if (!product) throw new NotFoundException('Loan product not found');
    return product;
  }

  async updateProduct(
    id: string,
    dto: UpdateLoanProductDto,
    tenantId: string,
    updatedBy: string,
    ipAddress?: string,
  ) {
    const existing = await this.prisma.loanProduct.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('Loan product not found');

    const nextMin =
      dto.minAmount !== undefined
        ? new Decimal(dto.minAmount)
        : new Decimal(existing.minAmount.toString());
    const nextMax =
      dto.maxAmount !== undefined
        ? new Decimal(dto.maxAmount)
        : new Decimal(existing.maxAmount.toString());
    if (nextMin.greaterThan(nextMax)) {
      throw new BadRequestException('minAmount must be less than or equal to maxAmount');
    }

    if (dto.name && dto.name !== existing.name) {
      const duplicate = await this.prisma.loanProduct.findFirst({
        where: { tenantId, name: dto.name, id: { not: id } },
        select: { id: true },
      });
      if (duplicate) throw new ConflictException(`Loan product "${dto.name}" already exists`);
    }

    const product = await this.prisma.loanProduct.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.minAmount !== undefined && {
          minAmount: new Decimal(dto.minAmount).toDecimalPlaces(4).toString(),
        }),
        ...(dto.maxAmount !== undefined && {
          maxAmount: new Decimal(dto.maxAmount).toDecimalPlaces(4).toString(),
        }),
        ...(dto.interestRate !== undefined && {
          interestRate: new Decimal(dto.interestRate).toDecimalPlaces(4).toString(),
        }),
        ...(dto.interestType !== undefined && { interestType: dto.interestType }),
        ...(dto.maxTenureMonths !== undefined && { maxTenureMonths: dto.maxTenureMonths }),
        ...(dto.processingFeeRate !== undefined && {
          processingFeeRate: new Decimal(dto.processingFeeRate).toDecimalPlaces(4).toString(),
        }),
        ...(dto.requiredAccountType !== undefined && {
          requiredAccountType: dto.requiredAccountType ?? null,
        }),
        ...(dto.savingsMultiplier !== undefined && {
          savingsMultiplier: new Decimal(dto.savingsMultiplier).toDecimalPlaces(4).toString(),
        }),
        ...(dto.minGuarantors !== undefined && { minGuarantors: dto.minGuarantors }),
        ...(dto.maxGuarantors !== undefined && { maxGuarantors: dto.maxGuarantors }),
        ...(dto.guarantorCoverageRatio !== undefined && {
          guarantorCoverageRatio: new Decimal(dto.guarantorCoverageRatio)
            .toDecimalPlaces(4)
            .toString(),
        }),
        ...(dto.requiresPayslip !== undefined && { requiresPayslip: dto.requiresPayslip }),
        ...(dto.minActiveMonths !== undefined && { minActiveMonths: dto.minActiveMonths }),
        ...(dto.gracePeriodMonths !== undefined && { gracePeriodMonths: dto.gracePeriodMonths }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });

    await this.audit
      .create({
        tenantId,
        userId: updatedBy,
        action: 'LOAN_PRODUCT.UPDATE',
        resource: 'LoanProduct',
        resourceId: product.id,
        oldValue: { name: existing.name, isActive: existing.isActive },
        newValue: { name: product.name, isActive: product.isActive },
        metadata: { changedFields: Object.keys(dto) },
        ipAddress,
      })
      .catch((e: unknown) => this.logger.error('Audit write failed', e));

    await this.invalidateProductCache(tenantId);

    return product;
  }

  async deactivateProduct(id: string, tenantId: string, updatedBy: string, ipAddress?: string) {
    return this.updateProduct(id, { isActive: false }, tenantId, updatedBy, ipAddress);
  }

  // ─── LOAN APPLICATION ────────────────────────────────────────

  /**
   * @deprecated Legacy admin loan application path disabled for production.
   * Use LoanApplicationService.memberApply via the member portal workflow, which
   * enforces idempotency, open-loan checks, product rules, and guarantor policy.
   */
  async apply(
    dto: ApplyLoanDto,
    tenantId: string,
    appliedBy: string,
    ipAddress?: string,
    idempotencyKey?: string,
  ) {
    void dto;
    void tenantId;
    void appliedBy;
    void ipAddress;
    void idempotencyKey;
    throw new NotImplementedException(
      'Legacy loan application endpoint is disabled. Use the strict member loan application workflow.',
    );
  }
  // ─── LIST LOANS ───────────────────────────────────────────────

  async findAll(
    tenantId: string,
    opts: {
      memberId?: string;
      status?: LoanStatus;
      cursor?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const limit = Math.min(100, Math.max(1, Number(opts.limit ?? 20)));

    const where: Prisma.LoanWhereInput = {
      tenantId,
      ...(opts.memberId && { memberId: opts.memberId }),
      ...(opts.status && { status: opts.status }),
    };

    const loans = await this.prisma.loan.findMany({
      where,
      include: {
        member: {
          select: { memberNumber: true, user: { select: { firstName: true, lastName: true } } },
        },
        loanProduct: { select: { name: true } },
      },
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      take: limit + 1,
      orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
    });

    const hasMore = loans.length > limit;
    const pageRows = hasMore ? loans.slice(0, limit) : loans;
    const nextCursor = hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null;

    // Guarantor coverage for the whole page in one groupBy - never loop-and-query per loan.
    const loanIds = pageRows.map((loan) => loan.id);
    const acceptedTotals = loanIds.length
      ? await this.prisma.loanGuarantor.groupBy({
          by: ['loanId'],
          where: { tenantId, loanId: { in: loanIds }, status: GuarantorStatus.ACCEPTED },
          _sum: { guaranteedAmount: true },
        })
      : [];
    const coverageByLoanId = new Map(
      acceptedTotals.map((row) => [
        row.loanId,
        new Decimal(row._sum.guaranteedAmount?.toString() ?? '0'),
      ]),
    );

    const data = pageRows.map((loan) => {
      const principal = new Decimal(loan.principalAmount.toString());
      const totalGuaranteed = coverageByLoanId.get(loan.id) ?? new Decimal(0);
      const guarantorCoveragePercent = principal.isZero()
        ? 0
        : totalGuaranteed.dividedBy(principal).times(100).toDecimalPlaces(2).toNumber();
      return { ...loan, guarantorCoveragePercent };
    });

    return {
      data,
      nextCursor,
      hasMore,
      meta: { limit, cursor: opts.cursor ?? null, nextCursor, hasMore },
    };
  }

  // ─── FIND ONE ─────────────────────────────────────────────────

  async findOne(id: string, tenantId: string) {
    const loan = await this.prisma.loan.findFirst({
      where: { id, tenantId },
      include: {
        member: {
          select: {
            memberNumber: true,
            user: { select: { firstName: true, lastName: true, email: true } },
          },
        },
        loanProduct: true,
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    return { ...loan, riskAssessment: await this.assessApplicantRisk(tenantId, loan.memberId) };
  }

  /**
   * Behavioral fraud-risk score for the loan applicant, for the admin detail view.
   * Deliberately not computed in findAll() — BehavioralRiskScorerService issues
   * several DB/Redis calls per member AND persists a new RiskScore row on every
   * call, so running it once per row in a paginated list would both N+1 and
   * spam the risk-score audit trail with noise from page views, not real events.
   * Never allowed to break the detail view — a scoring failure is logged and
   * surfaced as `available: false` instead of failing the whole request.
   */
  private async assessApplicantRisk(tenantId: string, memberId: string) {
    try {
      const result = await this.riskScorer.evaluate(tenantId, memberId, 'MANUAL');
      return {
        available: true,
        riskScore: result.riskScore,
        riskLevel: this.mapRiskLevel(result.recommendation),
        flags: result.flags,
      };
    } catch (err: unknown) {
      this.logger.error(`Risk score evaluation failed for member=${memberId}`, err);
      return { available: false, riskScore: null, riskLevel: null, flags: [] };
    }
  }

  private mapRiskLevel(recommendation: 'APPROVE' | 'REVIEW' | 'BLOCK'): 'LOW' | 'MEDIUM' | 'HIGH' {
    if (recommendation === 'BLOCK') return 'HIGH';
    if (recommendation === 'REVIEW') return 'MEDIUM';
    return 'LOW';
  }

  // ─── APPROVE ─────────────────────────────────────────────────

  /**
   * Approve a loan application.
   *
   * Approvable states:
   *   PENDING_REVIEW     – normal guarantor workflow path
   *   PENDING_APPROVAL – legacy / direct-approval path (no guarantors required)
   *
   * An optional review comment is stored in `notes` and surfaced in audit metadata.
   */
  async approve(
    id: string,
    tenantId: string,
    approvedBy: string,
    comment?: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const loan = await this.prisma.loan.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        status: true,
        loanNumber: true,
        memberId: true,
        principalAmount: true,
        monthlyInstalment: true,
        tenureMonths: true,
        approvedAt: true,
        approvedBy: true,
        notes: true,
        member: { select: { user: { select: { email: true, firstName: true } } } },
      },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    const approvableStatuses: LoanStatus[] = [
      LoanStatus.PENDING_REVIEW,
      LoanStatus.PENDING_APPROVAL,
    ];
    if (!approvableStatuses.includes(loan.status)) {
      throw new BadRequestException(
        `Cannot approve a loan in "${loan.status}" status. ` +
          `Expected one of: ${approvableStatuses.join(', ')}.`,
      );
    }

    await this.disbursementGate.assertPassed(tenantId, id, this.prisma);

    const updated = await this.prisma.$transaction(async (tx) => {
      const oldValue = await tx.loan.findFirst({
        where: { id, tenantId },
        select: {
          id: true,
          loanNumber: true,
          status: true,
          approvedAt: true,
          approvedBy: true,
          notes: true,
        },
      });
      if (!oldValue) throw new NotFoundException('Loan not found');
      if (!approvableStatuses.includes(oldValue.status)) {
        throw new BadRequestException(
          `Cannot approve a loan in "${oldValue.status}" status. ` +
            `Expected one of: ${approvableStatuses.join(', ')}.`,
        );
      }

      const approvedLoan = await tx.loan.update({
        where: { id },
        data: {
          status: LoanStatus.APPROVED,
          approvedAt: new Date(),
          approvedBy,
          ...(comment && { notes: comment }),
        },
      });

      await this.audit.logAtomic(tx, {
        tenantId,
        actorId: approvedBy,
        action: 'LOAN.APPROVE',
        entityType: 'Loan',
        entityId: id,
        oldValue,
        newValue: {
          id: approvedLoan.id,
          loanNumber: approvedLoan.loanNumber,
          status: approvedLoan.status,
          approvedAt: approvedLoan.approvedAt,
          approvedBy: approvedLoan.approvedBy,
          notes: approvedLoan.notes,
        },
        metadata: { loanNumber: loan.loanNumber, memberId: loan.memberId, comment },
        ipAddress,
        userAgent,
      });

      return approvedLoan;
    });

    this.emitDomainEvent(DOMAIN_EVENTS.LOAN.STATUS_CHANGED, {
      tenantId,
      loanId: id,
      memberId: loan.memberId,
      oldStatus: loan.status,
      newStatus: LoanStatus.APPROVED,
      actorId: approvedBy,
    });
    this.emitDomainEvent(DOMAIN_EVENTS.LOAN.APPROVED, {
      tenantId,
      loanId: id,
      memberId: loan.memberId,
      oldStatus: loan.status,
      newStatus: LoanStatus.APPROVED,
      actorId: approvedBy,
    });

    // Notify member of approval
    const memberUser = loan.member?.user;
    if (memberUser?.email) {
      this.enqueueEmail(
        {
          type: 'LOAN_APPROVED',
          to: memberUser.email,
          firstName: memberUser.firstName,
          loanNumber: loan.loanNumber,
          principalAmount: new Decimal(loan.principalAmount.toString()).toNumber(),
          monthlyInstalment: new Decimal(loan.monthlyInstalment?.toString() ?? '0').toNumber(),
          tenureMonths: loan.tenureMonths,
        },
        `loan.approve:${id}`,
      );
    }

    // 4-eyes principle: loans ≥ KES 500,000 additionally require MANAGER + TELLER
    // sign-off (via PATCH :id/approval-chain/sign) before disburse() will proceed.
    // The loan is still APPROVED above — this is a second, independent control
    // gating fund release, not a replacement for the approval decision itself.
    const requiresDualApproval = this.approvalChain.requiresDualApproval(loan.principalAmount);
    if (requiresDualApproval) {
      await this.approvalChain.initApprovalChain(id, tenantId);
    }

    await this.cache.invalidateTenantDashboard(tenantId);

    return { ...updated, requiresDualApproval };
  }

  // ─── 4-EYES APPROVAL CHAIN (loans ≥ KES 500,000) ──────────────

  /**
   * A MANAGER or TELLER signs off on a large loan's disbursement chain.
   * disburse() blocks until every slot in the chain is APPROVED.
   */
  async signApprovalChain(
    id: string,
    tenantId: string,
    actorId: string,
    actorRole: UserRole,
    approve: boolean,
    notes?: string,
    ipAddress?: string,
  ) {
    const loan = await this.prisma.loan.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    return this.approvalChain.signOff(id, tenantId, actorId, actorRole, approve, notes, ipAddress);
  }

  // ─── DISBURSE ────────────────────────────────────────────────

  /**
   * Disburse a loan: credit the member's FOSA account and mark loan as ACTIVE.
   *
   * dueDate = disbursedAt + gracePeriodMonths + tenureMonths
   *   - Grace period shifts the first repayment date by N months.
   *   - The instalment amount is unchanged; the total repayment window is extended.
   *
   * Uses a Prisma interactive transaction for atomicity.
   */
  async disburse(
    id: string,
    tenantId: string,
    disbursedBy: string,
    ipAddress?: string,
    disburseToMpesa?: boolean,
  ) {
    if (disburseToMpesa) {
      throw new BadRequestException(
        'Direct M-Pesa disbursement is disabled for security and reconciliation reasons. ' +
          "Funds must be disbursed to the member's FOSA account first.",
      );
    }
    const loan = await this.prisma.loan.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        status: true,
        loanNumber: true,
        dueDate: true,
        principalAmount: true,
        processingFee: true,
        memberId: true,
        tenureMonths: true,
        gracePeriodMonths: true,
        monthlyInstalment: true,
        repaymentScheduleGenerated: true,
        member: { select: { user: { select: { email: true, firstName: true } } } },
      },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    const reference = `LOAN-DISBURSEMENT-${id}`;
    const feeReference = `LOAN-DISBURSEMENT-${id}-FEE`;

    // Idempotent replay: if the loan is already ACTIVE, it was successfully
    // disbursed by an earlier request — return that disbursement's result instead
    // of re-running (or rejecting) the request, mirroring how LedgerService.
    // postEntry() replays a duplicate reference rather than throwing.
    if (loan.status === LoanStatus.ACTIVE) {
      const [existingPrincipalTxn, existingFeeTxn] = await Promise.all([
        this.prisma.transaction.findFirst({ where: { tenantId, reference } }),
        this.prisma.transaction.findFirst({ where: { tenantId, reference: feeReference } }),
      ]);
      if (!existingPrincipalTxn) {
        throw new ConflictException(
          `Loan ${loan.loanNumber} is ACTIVE but its disbursement transaction (${reference}) could not be found — ledger is inconsistent`,
        );
      }
      const finalTxn = existingFeeTxn ?? existingPrincipalTxn;
      return {
        loan,
        transaction: existingPrincipalTxn,
        newBalance: new Decimal(finalTxn.balanceAfter.toString()).toNumber(),
        dueDate: loan.dueDate,
        disbursement_status: 'COMPLETED' as const,
        estimated_settlement: existingPrincipalTxn.createdAt.toISOString(),
      };
    }
    if (loan.status !== LoanStatus.APPROVED) {
      throw new BadRequestException(
        `Cannot disburse a loan in "${loan.status}" status. Expected APPROVED.`,
      );
    }

    // 4-eyes principle: loans ≥ KES 500,000 must have a fully-signed MANAGER +
    // TELLER approval chain before funds can move. isChainApproved() returns
    // true for loans below the threshold (no chain was ever created).
    if (!(await this.approvalChain.isChainApproved(id, tenantId))) {
      throw new BadRequestException(
        'This loan requires MANAGER and TELLER sign-off before disbursement (4-eyes principle for loans ≥ KES 500,000).',
      );
    }

    // Verify member KYC is approved before disbursement
    const member = await this.prisma.member.findFirst({
      where: { id: loan.memberId, tenantId },
      select: { kycStatus: true },
    });
    if (member?.kycStatus !== 'APPROVED') {
      throw new BadRequestException('KYC must be approved before loan disbursement.');
    }

    // Locate the member's FOSA account for disbursement
    const fosaAccount = await this.prisma.account.findFirst({
      where: { memberId: loan.memberId, tenantId, accountType: 'FOSA', isActive: true },
      select: { id: true },
    });
    if (!fosaAccount) {
      throw new BadRequestException(
        'Member has no active FOSA account. Please open a FOSA account before disbursing.',
      );
    }

    // Use SERIALIZABLE isolation on the direct client to prevent race conditions
    // (lost updates) when two disbursements or a disbursement + deposit run concurrently.
    const txClient = this.prisma.direct ?? this.prisma;
    const disbursalResult = await txClient.$transaction(
      async (tx) => {
        const lockedLoans = await tx.$queryRaw<
          Array<{
            id: string;
            status: LoanStatus;
            principalAmount: string;
            processingFee: string;
            tenureMonths: number;
            gracePeriodMonths: number | null;
            monthlyInstalment: string;
            repaymentScheduleGenerated: boolean;
          }>
        >`
          SELECT id, status, "principalAmount", "processingFee", "tenureMonths", "gracePeriodMonths",
                 "monthlyInstalment", "repaymentScheduleGenerated"
          FROM "Loan"
          WHERE id = ${id} AND "tenantId" = ${tenantId}
          FOR UPDATE
        `;
        const lockedLoan = lockedLoans[0];
        if (!lockedLoan) throw new NotFoundException('Loan not found');
        if (lockedLoan.status === LoanStatus.ACTIVE) {
          throw new ConflictException(
            `Loan ${loan.loanNumber} has already been disbursed and is ACTIVE.`,
          );
        }
        if (lockedLoan.status !== LoanStatus.APPROVED) {
          throw new BadRequestException(
            `Cannot disburse a loan in "${lockedLoan.status}" status. Expected APPROVED.`,
          );
        }

        await this.disbursementGate.assertPassed(tenantId, id, tx);

        const txPrincipal = new Decimal(lockedLoan.principalAmount.toString());
        const processingFee = new Decimal(lockedLoan.processingFee.toString());
        const netDisbursement = txPrincipal.minus(processingFee);
        if (netDisbursement.lessThan(0)) {
          throw new BadRequestException('Processing fee cannot exceed loan principal.');
        }

        // Credit gross principal to FOSA: debit LOAN_RECEIVABLE, credit FOSA_DEPOSITS.
        // Account-balance concurrency/floor enforcement happens inside postEntry()'s
        // own compare-and-swap updateMany() — no separate FOR UPDATE lock needed here.
        const { transaction: principalTxn } = await this.ledger.postEntry({
          tx,
          tenantId,
          reference,
          journalType: JournalEntryType.LOAN_DISBURSEMENT,
          accountId: fosaAccount.id,
          amount: txPrincipal,
          direction: 'CREDIT',
          actorId: disbursedBy,
          description: `Loan disbursement – ${loan.loanNumber}`,
          loanId: id,
        });

        // Charge the processing fee (if any): debit FOSA_DEPOSITS, credit FEE_INCOME.
        let feeTxn: typeof principalTxn | null = null;
        if (processingFee.greaterThan(0)) {
          const feeResult = await this.ledger.postEntry({
            tx,
            tenantId,
            reference: feeReference,
            journalType: JournalEntryType.FEE_CHARGE,
            accountId: fosaAccount.id,
            amount: processingFee,
            direction: 'DEBIT',
            actorId: disbursedBy,
            description: `Loan processing fee - ${loan.loanNumber}`,
            loanId: id,
          });
          feeTxn = feeResult.transaction;
        }

        const balanceBefore = new Decimal(principalTxn.balanceBefore.toString());
        const balanceAfter = new Decimal((feeTxn ?? principalTxn).balanceAfter.toString());

        const disbursedAt = new Date();
        // dueDate = disbursement + grace period + repayment tenure
        const dueDate = new Date(disbursedAt);
        dueDate.setMonth(
          dueDate.getMonth() + (lockedLoan.gracePeriodMonths ?? 0) + lockedLoan.tenureMonths,
        );

        const updatedLoan = await tx.loan.update({
          where: { id },
          data: {
            status: LoanStatus.ACTIVE,
            disbursedAt,
            disbursedBy,
            dueDate,
            repaymentScheduleGenerated: true,
          },
        });

        // Generate monthly LoanRepayment schedule records (one per tenure month).
        // skipDuplicates guards against re-runs inside the same Serializable tx.
        if (!lockedLoan.repaymentScheduleGenerated) {
          const instalment = new Decimal(lockedLoan.monthlyInstalment.toString());
          await tx.loanRepayment.createMany({
            data: Array.from({ length: lockedLoan.tenureMonths }, (_, i) => {
              const paymentDate = new Date(disbursedAt);
              paymentDate.setMonth(
                paymentDate.getMonth() + (lockedLoan.gracePeriodMonths ?? 0) + i + 1,
              );
              return {
                tenantId,
                loanId: id,
                dayNumber: i + 1,
                amountPaid: instalment.toDecimalPlaces(2).toString(),
                dueDate: paymentDate,
                principalDue: instalment.toDecimalPlaces(4).toString(),
                paymentDate,
                method: 'SCHEDULED',
                status: 'PENDING',
              };
            }),
            skipDuplicates: true,
          });
        }

        await tx.auditLog.create({
          data: {
            tenantId,
            actorId: disbursedBy,
            action: 'LOAN.DISBURSE',
            entityType: 'Loan',
            entityId: id,
            oldValue: { status: lockedLoan.status, accountBalance: balanceBefore.toNumber() },
            newValue: { status: LoanStatus.ACTIVE, accountBalance: balanceAfter.toNumber() },
            metadata: {
              loanNumber: loan.loanNumber,
              principalAmount: txPrincipal.toNumber(),
              processingFee: processingFee.toNumber(),
              netDisbursement: netDisbursement.toNumber(),
              fosaAccountId: fosaAccount.id,
              reference,
              feeReference,
              gracePeriodMonths: lockedLoan.gracePeriodMonths ?? 0,
              disbursedAt,
              dueDate,
            },
            ipAddress: ipAddress ?? null,
          },
        });

        return {
          loan: updatedLoan,
          transaction: principalTxn,
          newBalance: balanceAfter.toNumber(),
          dueDate,
          disbursement_status: 'COMPLETED' as const,
          estimated_settlement: disbursedAt.toISOString(),
        };
      },
      { isolationLevel: 'Serializable' as const },
    );

    this.emitDomainEvent(DOMAIN_EVENTS.LOAN.STATUS_CHANGED, {
      tenantId,
      loanId: id,
      memberId: loan.memberId,
      oldStatus: loan.status,
      newStatus: disbursalResult.loan.status,
      actorId: disbursedBy,
    });
    this.emitDomainEvent(DOMAIN_EVENTS.LOAN.DISBURSED, {
      tenantId,
      loanId: id,
      memberId: loan.memberId,
      oldStatus: loan.status,
      newStatus: disbursalResult.loan.status,
      actorId: disbursedBy,
      transactionRef: reference,
    });

    // Notify member of disbursement (after transaction commits)
    const memberUser = loan.member?.user;
    if (memberUser?.email) {
      this.enqueueEmail(
        {
          type: 'LOAN_DISBURSED',
          to: memberUser.email,
          firstName: memberUser.firstName,
          loanNumber: loan.loanNumber,
          principalAmount: new Decimal(loan.principalAmount.toString()).toNumber(),
          monthlyInstalment: new Decimal(loan.monthlyInstalment?.toString() ?? '0').toNumber(),
          dueDate: disbursalResult.dueDate.toISOString().split('T')[0],
          accountNumber: fosaAccount.id,
        },
        `loan.disburse:${id}`,
      );
    }

    await this.cache.invalidateTenantDashboard(tenantId);

    return disbursalResult;
  }

  // ─── REJECT ──────────────────────────────────────────────────

  async reject(
    id: string,
    dto: RejectLoanDto,
    tenantId: string,
    rejectedBy: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const loan = await this.prisma.loan.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        status: true,
        loanNumber: true,
        memberId: true,
        loanProduct: { select: { requiredAccountType: true } },
        member: { select: { user: { select: { email: true, firstName: true } } } },
      },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    const rejectableStatuses: LoanStatus[] = [
      LoanStatus.PENDING_APPROVAL,
      LoanStatus.PENDING_GUARANTORS,
      LoanStatus.PENDING_REVIEW,
    ];
    if (!rejectableStatuses.includes(loan.status)) {
      throw new BadRequestException(`Cannot reject a loan in "${loan.status}" status`);
    }

    const txClient = this.prisma.direct ?? this.prisma;
    const updated = await txClient.$transaction(
      async (tx) => {
        const lockedLoans = await tx.$queryRaw<Array<{ id: string; status: LoanStatus }>>`
        SELECT id, status
        FROM "Loan"
        WHERE id = ${id} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
        const lockedLoan = lockedLoans[0];
        if (!lockedLoan) throw new NotFoundException('Loan not found');
        if (!rejectableStatuses.includes(lockedLoan.status)) {
          throw new BadRequestException(`Cannot reject a loan in "${lockedLoan.status}" status`);
        }

        const acceptedGuarantors = await tx.loanGuarantor.findMany({
          where: { tenantId, loanId: id, status: GuarantorStatus.ACCEPTED, holdReleasedAt: null },
          select: { id: true, memberId: true, guaranteedAmount: true },
        });
        const accountType = loan.loanProduct.requiredAccountType ?? AccountType.FOSA;
        const releasedHolds: Array<{
          guarantorId: string;
          memberId: string;
          releasedAmount: string;
        }> = [];

        for (const guarantor of acceptedGuarantors) {
          const accounts = await tx.$queryRaw<Array<{ id: string; frozenSavings: string }>>`
          SELECT id, "frozenSavings"
          FROM "Account"
          WHERE "tenantId" = ${tenantId}
            AND "memberId" = ${guarantor.memberId}
            AND "accountType"::text = ${accountType}
            AND "isActive" = true
          FOR UPDATE
        `;
          const account = accounts[0];
          if (!account) continue;

          const releaseAmount = Decimal.min(
            new Decimal(account.frozenSavings.toString()),
            new Decimal(guarantor.guaranteedAmount.toString()),
          ).toDecimalPlaces(4);
          if (releaseAmount.lessThanOrEqualTo(0)) continue;

          await tx.account.updateMany({
            where: { id: account.id, tenantId, isActive: true },
            data: {
              frozenSavings: { decrement: releaseAmount.toString() },
              version: { increment: 1 },
            },
          });
          await tx.loanGuarantor.updateMany({
            where: { id: guarantor.id, tenantId },
            data: { holdReleasedAt: new Date(), notes: dto.reason },
          });
          releasedHolds.push({
            guarantorId: guarantor.id,
            memberId: guarantor.memberId,
            releasedAmount: releaseAmount.toString(),
          });
        }

        const rejectedLoan = await tx.loan.update({
          where: { id },
          data: { status: LoanStatus.REJECTED, notes: dto.reason },
        });

        await this.audit.logAtomic(tx, {
          tenantId,
          actorId: rejectedBy,
          action: 'LOAN.REJECT',
          entityType: 'Loan',
          entityId: id,
          oldValue: { status: lockedLoan.status },
          newValue: { status: LoanStatus.REJECTED, notes: dto.reason },
          metadata: {
            loanNumber: loan.loanNumber,
            reason: dto.reason,
            releasedHolds,
          },
          ipAddress,
          userAgent,
        });
        return rejectedLoan;
      },
      { isolationLevel: 'Serializable' as const },
    );

    this.emitDomainEvent(DOMAIN_EVENTS.LOAN.STATUS_CHANGED, {
      tenantId,
      loanId: id,
      memberId: loan.memberId,
      oldStatus: loan.status,
      newStatus: LoanStatus.REJECTED,
      actorId: rejectedBy,
      reason: dto.reason,
    });
    this.emitDomainEvent(DOMAIN_EVENTS.LOAN.REJECTED, {
      tenantId,
      loanId: id,
      memberId: loan.memberId,
      oldStatus: loan.status,
      newStatus: LoanStatus.REJECTED,
      actorId: rejectedBy,
      reason: dto.reason,
    });

    // Notify member of rejection
    const rejectMemberUser = loan.member?.user;
    if (rejectMemberUser?.email) {
      this.enqueueEmail(
        {
          type: 'LOAN_REJECTED',
          to: rejectMemberUser.email,
          firstName: rejectMemberUser.firstName,
          loanNumber: loan.loanNumber,
          reason: dto.reason,
        },
        `loan.reject:${id}`,
      );
    }

    return updated;
  }

  // ─── GUARANTORS ──────────────────────────────────────────────

  /**
   * @deprecated Legacy guarantor invitation path disabled for production.
   * Use LoanApplicationService.inviteGuarantors, which enforces product-specific
   * collateral rules, frozenSavings checks, and hardened guarantor validation.
   */
  async inviteGuarantors(
    loanId: string,
    dto: InviteGuarantorsDto,
    tenantId: string,
    invitedBy: string,
    ipAddress?: string,
  ) {
    void loanId;
    void dto;
    void tenantId;
    void invitedBy;
    void ipAddress;
    throw new NotImplementedException(
      'Legacy guarantor invitation endpoint is disabled. Use the strict guarantor invitation workflow.',
    );
  }
  /**
   * A guarantor member responds to their guarantee request.
   * After all guarantors have responded (or threshold met), loan moves to PENDING_REVIEW.
   */
  async respondAsGuarantor(
    loanId: string,
    memberId: string,
    dto: GuarantorResponseDto,
    tenantId: string,
    ipAddress?: string,
  ) {
    const guarantor = await this.prisma.loanGuarantor.findFirst({
      where: { loanId, memberId, tenantId },
      include: { member: { select: { userId: true } } },
    });
    if (!guarantor) throw new NotFoundException('LoanGuarantor record not found for this loan');

    if (guarantor.status !== GuarantorStatus.PENDING) {
      throw new BadRequestException(
        `You have already ${guarantor.status.toLowerCase()} this guarantee request`,
      );
    }

    const newStatus =
      dto.action === GuarantorAction.ACCEPT ? GuarantorStatus.ACCEPTED : GuarantorStatus.REJECTED;

    await this.prisma.loanGuarantor.update({
      where: { id: guarantor.id },
      data: { status: newStatus, respondedAt: new Date(), notes: dto.notes },
    });

    await this.audit
      .create({
        tenantId,
        userId: memberId,
        action: `LOAN.GUARANTOR_${newStatus}`,
        resource: 'LoanGuarantor',
        resourceId: guarantor.id,
        metadata: { loanId, notes: dto.notes },
        ipAddress,
      })
      .catch((e: unknown) => this.logger.error('Audit write failed', e));

    const guarantorPayload = {
      tenantId,
      loanId,
      guarantorUserId: guarantor.member.userId,
      guarantorMemberId: memberId,
      status: newStatus,
    };
    this.emitDomainEvent(DOMAIN_EVENTS.GUARANTOR.RESPONSE_RECEIVED, guarantorPayload);
    this.emitDomainEvent(
      newStatus === GuarantorStatus.ACCEPTED
        ? DOMAIN_EVENTS.GUARANTOR.ACCEPTED
        : DOMAIN_EVENTS.GUARANTOR.REJECTED,
      guarantorPayload,
    );

    // Check if minimum coverage is now met to auto-advance to PENDING_REVIEW
    await this.checkAndAdvanceLoanStatus(loanId, tenantId);

    return { loanId, memberId, status: newStatus };
  }

  /**
   * If accepted guarantors cover 100% of principal, advance loan to PENDING_REVIEW.
   */
  private async checkAndAdvanceLoanStatus(loanId: string, tenantId: string) {
    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, tenantId, status: LoanStatus.PENDING_GUARANTORS },
      select: { id: true, principalAmount: true },
    });
    if (!loan) return;

    const acceptedGuarantors = await this.prisma.loanGuarantor.findMany({
      where: { loanId, status: GuarantorStatus.ACCEPTED },
      select: { guaranteedAmount: true },
    });

    const totalAccepted = acceptedGuarantors.reduce(
      (sum, g) => sum.plus(g.guaranteedAmount.toString()),
      new Decimal(0),
    );

    const principal = new Decimal(loan.principalAmount.toString());
    const minCoverage = principal.times('1.00');

    if (totalAccepted.greaterThanOrEqualTo(minCoverage)) {
      await this.prisma.loan.update({
        where: { id: loanId },
        data: { status: LoanStatus.PENDING_APPROVAL },
      });
      this.logger.log(
        `Loan ${loanId} advanced to PENDING_APPROVAL - coverage ${totalAccepted.toNumber()} >= ${minCoverage.toNumber()}`,
      );
    }
  }

  /** Get all guarantors for a loan with their status */
  async getGuarantors(loanId: string, tenantId: string) {
    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, tenantId },
      select: { id: true },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    return this.prisma.loanGuarantor.findMany({
      where: { loanId, tenantId },
      include: {
        member: {
          select: {
            memberNumber: true,
            user: { select: { firstName: true, lastName: true, phone: true } },
          },
        },
      },
      orderBy: { invitedAt: 'asc' },
    });
  }

  // ─── REPAYMENT ────────────────────────────────────────────────

  /**
   * Post a loan repayment: debit member FOSA, update loan outstanding balance.
   *
   * Concurrency safety:
   *   - Uses the direct (non-pooler) Prisma client for Serializable isolation.
   *   - Acquires FOR UPDATE row locks on both Account and Loan before reading
   *     balances, eliminating the TOCTOU window that allowed concurrent repayments
   *     to both read a stale balance and double-deduct.
   *   - Balance and outstanding checks happen INSIDE the transaction under the lock.
   *
   * Error codes:
   *   - 404  Active loan or FOSA account not found
   *   - 422  Insufficient FOSA balance (UnprocessableEntity per SACCO spec)
   *   - 400  Loan status changed during concurrent processing
   */
  async repay(
    loanId: string,
    amountKes: number,
    tenantId: string,
    processedBy: string,
    ipAddress?: string,
    idempotencyKey?: string,
  ) {
    if (amountKes <= 0) throw new BadRequestException('Repayment amount must be positive');
    const amount = new Decimal(amountKes);

    // ── Pre-flight reads (no state change, no lock needed) ───────────────────
    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, tenantId, status: LoanStatus.ACTIVE },
      select: { id: true, loanNumber: true, memberId: true, monthlyInstalment: true },
    });
    if (!loan) throw new NotFoundException('Active loan not found');

    const fosaAccount = await this.prisma.account.findFirst({
      where: { memberId: loan.memberId, tenantId, accountType: 'FOSA', isActive: true },
      select: { id: true },
    });
    if (!fosaAccount) throw new BadRequestException('No active FOSA account for repayment');

    // Fetch member email outside transaction — read-only, low contention
    const repayMemberUser = await this.prisma.member.findFirst({
      where: { id: loan.memberId, tenantId },
      select: { user: { select: { email: true, firstName: true } } },
    });

    // ── Serializable transaction with FOR UPDATE row locks ───────────────────
    // Use the direct (non-pooled) client so the Serializable isolation level is
    // actually honoured. Falls back to the pooled client if DIRECT_URL is not set,
    // which is acceptable for dev but should be configured in production.
    const txClient = this.prisma.direct ?? this.prisma;

    // Deterministic reference — never uuid() here. A fresh uuid() per call would
    // defeat replay protection on network retries of the same repayment request,
    // letting the same cash movement double-debit the member's FOSA balance.
    // Computed up-front (not from locked data) so a replay can short-circuit
    // before ever taking the FOR UPDATE locks below.
    const reference = idempotencyKey
      ? `REPAY-${tenantId}-${idempotencyKey}`
      : `TXN-REPAY-${tenantId}-${loanId}-${amountKes}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;

    const repayResult = await txClient.$transaction(
      async (tx) => {
        // Idempotency check: if this exact repayment reference was already posted
        // (retry after a timed-out response, double-submit, etc.), replay the
        // original result instead of re-running the waterfall and double-debiting.
        const existingReplay = await tx.transaction.findFirst({ where: { tenantId, reference } });
        if (existingReplay) {
          const currentLoan = await tx.loan.findFirst({ where: { id: loanId, tenantId } });
          if (!currentLoan) throw new NotFoundException('Loan not found');
          return {
            loan: currentLoan,
            transaction: existingReplay,
            reference,
            paidAt: existingReplay.createdAt,
            newOutstandingBalance: Math.max(
              0,
              new Decimal(currentLoan.outstandingBalance.toString()).toNumber(),
            ),
            allocation: { toPenalties: 0, toInterest: 0, toPrincipal: 0 },
          };
        }

        // Acquire exclusive row locks on both Account and Loan atomically.
        // This prevents two concurrent repayments from reading the same stale
        // balance and both decrementing by their full amount.
        const [lockedAccounts, lockedLoans] = await Promise.all([
          tx.$queryRaw<{ id: string; balance: string; version: number }[]>`
            SELECT id, balance, version
            FROM "Account"
            WHERE id = ${fosaAccount.id}
              AND "tenantId" = ${tenantId}
              AND "isActive" = true
            FOR UPDATE
          `,
          tx.$queryRaw<
            {
              id: string;
              outstandingBalance: string;
              status: string;
              accruedInterest: string;
              arrearsAmount: string;
            }[]
          >`
            SELECT id, "outstandingBalance", status, "accruedInterest", "arrearsAmount"
            FROM "Loan"
            WHERE id = ${loanId}
              AND "tenantId" = ${tenantId}
            FOR UPDATE
          `,
        ]);

        const acc = lockedAccounts[0];
        if (!acc) throw new NotFoundException('FOSA account not found or inactive');

        const currentLoan = lockedLoans[0];
        if (!currentLoan) throw new NotFoundException('Loan not found');
        // Guard: status may have changed between the pre-flight read and the lock
        if (currentLoan.status !== LoanStatus.ACTIVE) {
          throw new BadRequestException(
            `Loan status changed to "${currentLoan.status}" during concurrent processing. ` +
              'Please retry the repayment.',
          );
        }

        const balBefore = new Decimal(acc.balance.toString());
        const outstanding = new Decimal(currentLoan.outstandingBalance.toString());
        const accrued = new Decimal(currentLoan.accruedInterest.toString());
        const arrears = new Decimal(currentLoan.arrearsAmount.toString());

        // Cap repayment at total amount owed (penalties + interest + principal)
        const totalOwed = arrears.plus(accrued).plus(outstanding);
        const actualRepayment = amount.greaterThan(totalOwed) ? totalOwed : amount;

        // 422 Unprocessable Entity: member does not have sufficient funds
        if (balBefore.lessThan(actualRepayment)) {
          throw new UnprocessableEntityException(
            `Insufficient FOSA balance KES ${balBefore.toFixed(2)} ` +
              `for repayment of KES ${actualRepayment.toFixed(2)}. ` +
              'Please deposit funds before repaying.',
          );
        }

        // SASRA waterfall: Penalties → Accrued Interest → Principal
        let remaining = actualRepayment;

        const toArrears = Decimal.min(remaining, arrears);
        remaining = remaining.minus(toArrears);
        const newArrearsAmount = arrears.minus(toArrears);

        const toInterest = Decimal.min(remaining, accrued);
        remaining = remaining.minus(toInterest);
        const newAccruedInterest = accrued.minus(toInterest);

        const toPrincipal = remaining;
        const newOutstanding = outstanding.minus(toPrincipal);

        const balAfter = balBefore.minus(actualRepayment);

        const txn = await tx.transaction.create({
          data: {
            tenantId,
            accountId: fosaAccount.id,
            loanId,
            type: TransactionType.LOAN_REPAYMENT,
            status: TransactionStatus.COMPLETED,
            amount: actualRepayment.toDecimalPlaces(4).toString(),
            balanceBefore: balBefore.toDecimalPlaces(4).toString(),
            balanceAfter: balAfter.toDecimalPlaces(4).toString(),
            reference,
            description: `Loan repayment – ${loan.loanNumber}`,
            processedBy,
          },
        });

        await tx.account.update({
          where: { id: fosaAccount.id },
          data: { balance: balAfter.toDecimalPlaces(4).toString() },
        });

        // GL side: the FOSA balance above is decremented exactly once, for the full
        // actualRepayment amount. These three legs post the GL-only breakdown
        // (debit FOSA_DEPOSITS / credit the leg-specific income/receivable code) —
        // they do NOT touch Account.balance again, avoiding a double debit. See
        // LedgerService.postAccountSourcedRepaymentLegEntry() for why this differs
        // from the M-Pesa-sourced waterfall (which debits CASH, not FOSA_DEPOSITS).
        if (toArrears.greaterThan(0)) {
          await this.ledger.postAccountSourcedRepaymentLegEntry({
            tx,
            tenantId,
            reference: `${reference}-PENALTY`,
            leg: 'PENALTY',
            amount: toArrears,
            accountType: AccountType.FOSA,
            transactionId: txn.id,
            actorId: processedBy,
          });
        }
        if (toInterest.greaterThan(0)) {
          await this.ledger.postAccountSourcedRepaymentLegEntry({
            tx,
            tenantId,
            reference: `${reference}-INTEREST`,
            leg: 'INTEREST',
            amount: toInterest,
            accountType: AccountType.FOSA,
            transactionId: txn.id,
            actorId: processedBy,
          });
        }
        if (toPrincipal.greaterThan(0)) {
          await this.ledger.postAccountSourcedRepaymentLegEntry({
            tx,
            tenantId,
            reference: `${reference}-PRINCIPAL`,
            leg: 'PRINCIPAL',
            amount: toPrincipal,
            accountType: AccountType.FOSA,
            transactionId: txn.id,
            actorId: processedBy,
          });
        }

        const newStatus = newOutstanding.lessThanOrEqualTo(0)
          ? LoanStatus.FULLY_PAID
          : LoanStatus.ACTIVE;

        const updatedLoan = await tx.loan.update({
          where: { id: loanId },
          data: {
            outstandingBalance: newOutstanding.lessThan(0)
              ? '0'
              : newOutstanding.toDecimalPlaces(4).toString(),
            accruedInterest: newAccruedInterest.lessThan(0)
              ? '0'
              : newAccruedInterest.toDecimalPlaces(4).toString(),
            arrearsAmount: newArrearsAmount.lessThan(0)
              ? '0'
              : newArrearsAmount.toDecimalPlaces(4).toString(),
            totalRepaid: { increment: actualRepayment.toDecimalPlaces(4).toNumber() },
            status: newStatus,
          },
        });

        if (newStatus === LoanStatus.FULLY_PAID) {
          await this.releaseGuarantorHoldsOnFullRepayment(tx, tenantId, loanId, processedBy);
        }

        await this.audit.createAtomic(tx, {
          tenantId,
          userId: processedBy,
          action: 'LOAN.REPAYMENT',
          resource: 'Loan',
          resourceId: loanId,
          metadata: {
            loanNumber: loan.loanNumber,
            amount: actualRepayment.toNumber(),
            newOutstanding: Math.max(0, newOutstanding.toNumber()),
            newStatus,
            reference,
          },
          ipAddress,
        });

        return {
          loan: updatedLoan,
          transaction: txn,
          reference,
          paidAt: new Date(),
          newOutstandingBalance: Math.max(0, newOutstanding.toNumber()),
          allocation: {
            toPenalties: toArrears.toNumber(),
            toInterest: toInterest.toNumber(),
            toPrincipal: toPrincipal.toNumber(),
          },
        };
      },
      { isolationLevel: 'Serializable' as const },
    );

    // Notify member after the transaction commits — fire-and-forget
    if (repayResult.loan.status === LoanStatus.FULLY_PAID) {
      this.emitDomainEvent(DOMAIN_EVENTS.LOAN.STATUS_CHANGED, {
        tenantId,
        loanId,
        memberId: loan.memberId,
        oldStatus: LoanStatus.ACTIVE,
        newStatus: LoanStatus.FULLY_PAID,
        actorId: processedBy,
      });
      this.emitDomainEvent(DOMAIN_EVENTS.LOAN.REPAID, {
        tenantId,
        loanId,
        memberId: loan.memberId,
        amountPaid: parseFloat(repayResult.transaction.amount.toString()),
        transactionRef: repayResult.reference,
      });
    }

    if (repayMemberUser?.user?.email) {
      this.enqueueEmail(
        {
          type: 'REPAYMENT_RECEIPT',
          to: repayMemberUser.user.email,
          firstName: repayMemberUser.user.firstName,
          loanNumber: loan.loanNumber,
          amountPaid: parseFloat(repayResult.transaction.amount.toString()),
          outstandingBalance: repayResult.newOutstandingBalance,
          reference: repayResult.reference,
          paidAt: repayResult.paidAt.toISOString(),
        },
        `loan.repay:${loanId}`,
      );
    }

    await this.cache.invalidateTenantDashboard(tenantId);

    return repayResult;
  }

  // ─── HELPERS ─────────────────────────────────────────────────

  private async releaseGuarantorHoldsOnFullRepayment(
    tx: Prisma.TransactionClient,
    tenantId: string,
    loanId: string,
    actorId: string,
  ): Promise<void> {
    const loan = await tx.loan.findFirst({
      where: { id: loanId, tenantId },
      select: {
        loanProduct: { select: { requiredAccountType: true } },
        guarantors: {
          where: { tenantId, status: GuarantorStatus.ACCEPTED, holdReleasedAt: null },
          select: { id: true, memberId: true, guaranteedAmount: true },
        },
      },
    });
    if (!loan || loan.guarantors.length === 0) return;

    const accountType = loan.loanProduct.requiredAccountType ?? AccountType.FOSA;
    const guarantorMemberIds = loan.guarantors.map((guarantor) => guarantor.memberId);
    const accounts = await tx.account.findMany({
      where: { tenantId, memberId: { in: guarantorMemberIds }, accountType, isActive: true },
      select: { id: true, memberId: true, frozenSavings: true },
    });
    const accountMap = new Map(accounts.map((account) => [account.memberId, account]));

    for (const guarantor of loan.guarantors) {
      const account = accountMap.get(guarantor.memberId);
      if (!account) continue;

      const releaseAmount = Decimal.min(
        new Decimal(account.frozenSavings.toString()),
        new Decimal(guarantor.guaranteedAmount.toString()),
      ).toDecimalPlaces(4);
      if (releaseAmount.lessThanOrEqualTo(0)) continue;

      await tx.account.updateMany({
        where: { id: account.id, tenantId, isActive: true },
        data: { frozenSavings: { decrement: releaseAmount.toString() }, version: { increment: 1 } },
      });
      await tx.loanGuarantor.updateMany({
        where: { id: guarantor.id, tenantId },
        data: { holdReleasedAt: new Date() },
      });
      const auditTimestamp = new Date();
      const prevAudit = await tx.auditLog.findFirst({
        where: { tenantId },
        orderBy: { timestamp: 'desc' },
        select: { entryHash: true },
      });
      const auditPayload = {
        loanId,
        guarantorMemberId: guarantor.memberId,
        releasedAmount: releaseAmount.toString(),
        reason: 'LOAN_FULLY_PAID',
      };
      const prevHash = prevAudit?.entryHash ?? null;
      const entryHash = createHash('sha256')
        .update(
          JSON.stringify({
            tenantId,
            actorId,
            action: 'GUARANTOR.HOLD_RELEASED_LOAN_REPAID',
            entityType: 'LoanGuarantor',
            entityId: guarantor.id,
            payload: auditPayload,
            prevHash,
            timestamp: auditTimestamp,
          }),
          'utf8',
        )
        .digest('hex');
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId,
          action: 'GUARANTOR.HOLD_RELEASED_LOAN_REPAID',
          entityType: 'LoanGuarantor',
          entityId: guarantor.id,
          metadata: auditPayload,
          payload: auditPayload,
          prevHash,
          entryHash,
          timestamp: auditTimestamp,
        },
      });
    }
  }

  /**
   * Calculate monthly instalment using Decimal arithmetic.
   *
   * FLAT:
   *   total = P + P * annualRate * (n/12)
   *   instalment = total / n
   *
   * REDUCING_BALANCE (standard amortisation):
   *   r = annualRate / 12
   *   instalment = P * r * (1+r)^n / ((1+r)^n – 1)
   *   Edge case r=0: instalment = P / n
   */
  private calculateInstalment(
    principal: Decimal,
    annualRate: Decimal,
    tenureMonths: number,
    interestType: InterestType,
  ): Decimal {
    const n = new Decimal(tenureMonths);

    if (interestType === InterestType.FLAT) {
      const totalInterest = principal.times(annualRate).times(n.dividedBy(12));
      return principal.plus(totalInterest).dividedBy(n);
    }

    // REDUCING_BALANCE
    const r = annualRate.dividedBy(12);

    if (r.isZero()) {
      return principal.dividedBy(n);
    }

    // (1+r)^n
    const onePlusR = new Decimal(1).plus(r);
    const onePlusRPowN = onePlusR.pow(n);

    return principal.times(r).times(onePlusRPowN).dividedBy(onePlusRPowN.minus(1));
  }
}
