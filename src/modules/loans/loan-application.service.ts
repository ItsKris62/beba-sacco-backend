import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash } from 'crypto';
import { Decimal } from 'decimal.js';
import {
  LoanStatus,
  GuarantorStatus,
  InterestType,
  UserRole,
  AccountType,
  Prisma,
  AccountStatus,
} from '@prisma/client';
import { canTransition } from './loan-state-machine';
import { v4 as uuidv4 } from 'uuid';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DOMAIN_EVENTS, DomainEventName } from '../../common/constants/events';
import { RedisService } from '../../common/services/redis.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { MemberApplyLoanDto, GuarantorNominationDto } from './dto/member-apply-loan.dto';
import { AdminLoanStatus } from './dto/update-loan-status.dto';
import { GuarantorValidationService } from './guarantor-validation.service';
import { ProductRuleService } from './product-rule.service';
import { SmsService } from '../sms/sms.service';
import { LoansService } from './loans.service';
import {
  QUEUE_NAMES,
  GuarantorExpiryJobPayload,
  GuarantorReminderJobPayload,
  GuarantorValidationJobPayload,
  EmailJobPayload,
  AuditLogJobPayload,
} from '../queue/queue.constants';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

/**
 * Domain events emitted by the loan application workflow.
 * These are queued to BullMQ for async processing.
 */
export type LoanDomainEvent =
  | { type: 'LoanApplied'; payload: LoanAppliedEvent }
  | { type: 'LoanApproved'; payload: LoanStatusChangedEvent }
  | { type: 'LoanRejected'; payload: LoanStatusChangedEvent }
  | { type: 'LoanDisbursed'; payload: LoanStatusChangedEvent };

export interface LoanAppliedEvent {
  loanId: string;
  tenantId: string;
  memberId: string;
  principalAmount: number;
  loanProductId: string;
  appliedBy: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId: string;
}

export interface LoanStatusChangedEvent {
  loanId: string;
  tenantId: string;
  oldStatus: string;
  newStatus: string;
  actorId: string;
  reason?: string;
  correlationId: string;
}

/**
 * Loan Application Service
 *
 * MVP Scope: Complete Loan Application & Guarantor Workflow
 * - Member self-service loan application with eligibility checks
 * - Explicit guarantor consent with 72h expiry
 * - Immutable consent logging with evidence bundle
 * - Role-based access control with tenant isolation
 * - Domain event publishing → BullMQ → async audit writer
 */
@Injectable()
export class LoanApplicationService {
  private readonly logger = new Logger(LoanApplicationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly idempotency: IdempotencyService,
    private readonly guarantorValidation: GuarantorValidationService,
    private readonly productRules: ProductRuleService,
    @InjectQueue(QUEUE_NAMES.LOAN_GUARANTOR_REMINDER)
    private readonly guarantorReminderQueue: Queue<GuarantorReminderJobPayload>,
    @InjectQueue(QUEUE_NAMES.LOAN_GUARANTOR_EXPIRY)
    private readonly guarantorExpiryQueue: Queue<GuarantorExpiryJobPayload>,
    @InjectQueue(QUEUE_NAMES.GUARANTOR_VALIDATION)
    private readonly guarantorValidationQueue: Queue<GuarantorValidationJobPayload>,
    @InjectQueue(QUEUE_NAMES.EMAIL)
    private readonly emailQueue: Queue<EmailJobPayload>,
    @InjectQueue(QUEUE_NAMES.AUDIT_LOG)
    private readonly auditQueue: Queue<AuditLogJobPayload>,
    private readonly smsService: SmsService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(forwardRef(() => LoansService))
    private readonly loansService: LoansService,
  ) {}

  // ─── DOMAIN EVENT PUBLISHER ────────────────────────────────────────────────

  /**
   * Publish a domain event to the audit queue for async processing.
   * Failures are logged but never block the calling operation.
   */
  private async publishEvent(event: LoanDomainEvent): Promise<void> {
    try {
      await this.auditQueue.add('domain-event', {
        tenantId: event.payload.tenantId,
        action: `EVENT.${event.type}`,
        resource: 'LoanWorkflow',
        resourceId: event.payload.loanId,
        metadata: { event },
        requestId: event.payload.correlationId,
      });
    } catch (e: unknown) {
      this.logger.error(
        `Failed to publish event ${event.type}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ─── EMAIL ENQUEUE HELPER ──────────────────────────────────────────────────

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

  // ─── MEMBER ELIGIBILITY CHECKS ─────────────────────────────────────────────

  /**
   * Validates a member's eligibility to apply for a loan.
   * Rules:
   *   1. KYC must be APPROVED
   *   2. Must have at least one active FOSA or BOSA account
   *   3. Must not be blacklisted (cannotBorrow)
   *   4. Must not have any ACTIVE defaulted loans
   */
  async validateMemberEligibility(
    memberId: string,
    tenantId: string,
  ): Promise<{
    eligible: boolean;
    reason?: string;
    fosaBalance: Decimal;
    bosaBalance: Decimal;
    kycStatus: string;
  }> {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, tenantId, isActive: true },
      select: {
        id: true,
        memberNumber: true,
        kycStatus: true,
        isBlacklisted: true,
        user: { select: { firstName: true, lastName: true } },
      },
    });

    if (!member) {
      return {
        eligible: false,
        reason: 'Member not found or inactive',
        fosaBalance: new Decimal(0),
        bosaBalance: new Decimal(0),
        kycStatus: 'UNKNOWN',
      };
    }

    // Check KYC
    if (member.kycStatus !== 'APPROVED') {
      return {
        eligible: false,
        reason: 'KYC verification required before applying for a loan',
        fosaBalance: new Decimal(0),
        bosaBalance: new Decimal(0),
        kycStatus: member.kycStatus,
      };
    }

    if (member.isBlacklisted) {
      return {
        eligible: false,
        reason: 'Member is blacklisted and cannot apply for loans',
        fosaBalance: new Decimal(0),
        bosaBalance: new Decimal(0),
        kycStatus: member.kycStatus,
      };
    }

    // Check accounts
    const accounts = await this.prisma.account.findMany({
      where: { memberId, tenantId, isActive: true },
      select: { accountType: true, balance: true, lockedBalance: true, frozenSavings: true },
    });

    const hasFosa = accounts.some((a) => a.accountType === 'FOSA');
    const hasBosa = accounts.some((a) => a.accountType === 'BOSA');

    if (!hasFosa && !hasBosa) {
      return {
        eligible: false,
        reason: 'No active FOSA or BOSA account found',
        fosaBalance: new Decimal(0),
        bosaBalance: new Decimal(0),
        kycStatus: member.kycStatus,
      };
    }

    const fosaBalance = accounts
      .filter((a) => a.accountType === 'FOSA')
      .reduce(
        (sum, a) =>
          sum.plus(
            new Decimal(a.balance.toString())
              .minus(new Decimal(a.lockedBalance?.toString() ?? '0'))
              .minus(new Decimal(a.frozenSavings?.toString() ?? '0')),
          ),
        new Decimal(0),
      );
    const bosaBalance = accounts
      .filter((a) => a.accountType === 'BOSA')
      .reduce(
        (sum, a) =>
          sum.plus(
            new Decimal(a.balance.toString())
              .minus(new Decimal(a.lockedBalance?.toString() ?? '0'))
              .minus(new Decimal(a.frozenSavings?.toString() ?? '0')),
          ),
        new Decimal(0),
      );

    // Check blacklist (placeholder — MemberBlacklist model in schema additions)
    // TODO: Uncomment after migrating schema additions
    // const blacklist = await this.prisma.memberBlacklist?.findFirst({
    //   where: { memberId, tenantId, canBorrow: false },
    // });
    // if (blacklist && !blacklist.liftedAt) {
    //   return { eligible: false, reason: `Member is blacklisted: ${blacklist.reason}`, fosaBalance, bosaBalance, kycStatus: member.kycStatus };
    // }

    // Check defaulted loans
    const defaultedLoan = await this.prisma.loan.findFirst({
      where: { memberId, tenantId, status: LoanStatus.DEFAULTED },
      select: { id: true },
    });
    if (defaultedLoan) {
      return {
        eligible: false,
        reason: 'Member has an active defaulted loan',
        fosaBalance,
        bosaBalance,
        kycStatus: member.kycStatus,
      };
    }

    return { eligible: true, fosaBalance, bosaBalance, kycStatus: member.kycStatus };
  }

  // ─── GUARANTOR ELIGIBILITY ─────────────────────────────────────────────────

  /**
   * Validates whether a member can act as a guarantor.
   * Rules:
   *   1. Must be active member in same tenant
   *   2. Must have active FOSA account with sufficient balance
   *   3. Must not be blacklisted (canGuarantee = false)
   *   4. Must not have any defaulted loans
   *   5. Must not exceed max concurrent guarantees (default 3, configurable per tenant)
   *   6. Cannot guarantee their own loan
   */
  async validateGuarantorEligibility(
    guarantorMemberId: string,
    loanId: string,
    tenantId: string,
    proposedAmount: Decimal,
    borrowerMemberId: string,
    accountType: AccountType = AccountType.FOSA,
  ): Promise<{ eligible: boolean; reason?: string }> {
    if (guarantorMemberId === borrowerMemberId) {
      return { eligible: false, reason: 'Member cannot guarantee their own loan' };
    }

    const guarantor = await this.prisma.member.findFirst({
      where: { id: guarantorMemberId, tenantId, isActive: true },
      select: {
        id: true,
        kycStatus: true,
        isBlacklisted: true,
        user: { select: { firstName: true, lastName: true, role: true, accountStatus: true } },
      },
    });
    if (!guarantor) {
      return { eligible: false, reason: 'Guarantor not found or inactive' };
    }
    if (
      guarantor.user.role !== UserRole.MEMBER ||
      guarantor.user.accountStatus !== AccountStatus.ACTIVE
    ) {
      return { eligible: false, reason: 'Guarantor must be an active approved member' };
    }
    if (guarantor.kycStatus !== 'APPROVED') {
      return { eligible: false, reason: 'Guarantor KYC is not approved' };
    }
    if (guarantor.isBlacklisted) {
      return { eligible: false, reason: 'Guarantor is blacklisted' };
    }

    const circularGuarantee = await this.prisma.loanGuarantor.findFirst({
      where: {
        tenantId,
        memberId: borrowerMemberId,
        status: { in: [GuarantorStatus.PENDING, GuarantorStatus.ACCEPTED] },
        loan: {
          tenantId,
          memberId: guarantorMemberId,
          status: {
            in: [
              LoanStatus.PENDING_GUARANTORS,
              LoanStatus.PENDING_REVIEW,
              LoanStatus.PENDING_APPROVAL,
              LoanStatus.APPROVED,
              LoanStatus.ACTIVE,
              LoanStatus.DISBURSED,
            ],
          },
        },
      },
      select: { id: true },
    });
    if (circularGuarantee) {
      return {
        eligible: false,
        reason:
          'Circular guarantee detected. This member is already guaranteeing a loan for the applicant.',
      };
    }

    // Check FOSA
    const fosaAccount = await this.prisma.account.findFirst({
      where: { memberId: guarantorMemberId, tenantId, accountType, isActive: true },
      select: { id: true, balance: true, lockedBalance: true, frozenSavings: true },
    });
    if (!fosaAccount) {
      return { eligible: false, reason: 'Guarantor has no active FOSA account' };
    }

    const fosaBalance = new Decimal(fosaAccount.balance.toString());
    const lockedBalance = new Decimal(fosaAccount.lockedBalance?.toString() ?? '0');
    const frozenSavings = new Decimal(fosaAccount.frozenSavings?.toString() ?? '0');
    const availableBalance = fosaBalance.minus(lockedBalance).minus(frozenSavings);

    if (availableBalance.lessThan(proposedAmount)) {
      return {
        eligible: false,
        reason: `Insufficient FOSA available balance: available KES ${availableBalance.toFixed(2)}, committing KES ${proposedAmount.toFixed(2)}`,
      };
    }

    // Check blacklist (placeholder — MemberBlacklist model in schema additions)
    // TODO: Uncomment after migrating schema additions
    // const blacklist = await this.prisma.memberBlacklist?.findFirst({
    //   where: { memberId: guarantorMemberId, tenantId, canGuarantee: false },
    // });
    // if (blacklist && !blacklist.liftedAt) {
    //   return { eligible: false, reason: `Guarantor is blacklisted: ${blacklist.reason}` };
    // }

    // Check defaulted loans
    const defaulted = await this.prisma.loan.findFirst({
      where: { memberId: guarantorMemberId, tenantId, status: LoanStatus.DEFAULTED },
      select: { id: true },
    });
    if (defaulted) {
      return { eligible: false, reason: 'Guarantor has a defaulted loan' };
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId },
      select: { settings: true },
    });
    const maxGuarantees = this.resolveMaxConcurrentGuarantees(tenant?.settings);

    const activeGuarantees = await this.prisma.loanGuarantor.count({
      where: {
        memberId: guarantorMemberId,
        tenantId,
        status: GuarantorStatus.ACCEPTED,
        loan: { status: { in: [LoanStatus.ACTIVE, LoanStatus.APPROVED, LoanStatus.DISBURSED] } },
      },
    });

    if (activeGuarantees >= maxGuarantees) {
      return {
        eligible: false,
        reason: `Guarantor has reached the maximum concurrent guarantee limit (${maxGuarantees})`,
      };
    }

    return { eligible: true };
  }

  // ─── APPLY FOR LOAN (MEMBER SELF-SERVICE) ──────────────────────────────────

  /**
   * Member self-service loan application.
   * Validates eligibility, creates a Loan record in DRAFT status,
   * and optionally invites guarantors if provided.
   *
   * Idempotency: Uses Redis to prevent duplicate applications.
   */
  async memberApply(
    dto: MemberApplyLoanDto,
    tenantId: string,
    memberId: string,
    userId: string,
    req: Request,
    idempotencyKey?: string,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');
    }
    // 1. Idempotency guard
    if (idempotencyKey) {
      const idemKey = `loan:apply:${userId}:${memberId}:${dto.loanProductId}:${idempotencyKey}`;
      const check = await this.idempotency.checkAndReserve(idemKey, tenantId, 24 * 60 * 60);
      if (check.status === 'COMPLETED') {
        this.logger.log(`Idempotency cache hit for loan apply: ${idemKey}`);
        return check.result as Awaited<ReturnType<LoanApplicationService['_doMemberApply']>>;
      }
      if (check.status === 'PROCESSING') {
        throw new ConflictException('Loan application is already being processed. Please wait.');
      }
    }

    try {
      const correlationId = (req.headers['x-request-id'] as string) ?? uuidv4();
      const result = await this._doMemberApply(dto, tenantId, memberId, userId, req, correlationId);
      if (idempotencyKey) {
        const idemKey = `loan:apply:${userId}:${memberId}:${dto.loanProductId}:${idempotencyKey}`;
        await this.idempotency.complete(idemKey, tenantId, result, 24 * 60 * 60);
      }
      return result;
    } catch (err) {
      const isOneOpenLoanViolation = this.isOneOpenLoanConstraintViolation(err);

      // Incident 2026-07-18: release used to be conditional on
      // BadRequestException/ConflictException/the one-open-loan violation
      // only, so a transient failure (e.g. the Prisma interactive-transaction
      // timeout from _doMemberApply's $transaction) left the key stuck
      // PROCESSING for its full 24h TTL — the member's own retry then hit
      // "already being processed" instead of actually retrying. Releasing
      // unconditionally is safe here specifically because the DB-level
      // "loan_one_open_per_member" partial unique index (migration
      // 20260707193000) is the real duplicate-application guard, independent
      // of idempotency-key state: even if a request had actually succeeded
      // server-side despite the client observing an error, a retry after
      // release hits that constraint (isOneOpenLoanViolation above) instead
      // of creating a second loan.
      if (idempotencyKey) {
        const idemKey = `loan:apply:${userId}:${memberId}:${dto.loanProductId}:${idempotencyKey}`;
        try {
          await this.idempotency.release(idemKey, tenantId);
        } catch (releaseErr) {
          // A Redis failure while cleaning up must never mask the original error.
          this.logger.error(
            `Failed to release idempotency key after loan apply failure [key=${idemKey}, member=${memberId}]`,
            releaseErr instanceof Error ? releaseErr.stack : String(releaseErr),
          );
        }
      }

      if (isOneOpenLoanViolation) {
        throw this.oneOpenLoanConflict();
      }
      throw err;
    }
  }

  private oneOpenLoanConflict(): ConflictException {
    return new ConflictException(
      'ONE_OPEN_LOAN_ONLY: You already have an open loan. You can apply for another loan after it is fully paid.',
    );
  }

  private isOneOpenLoanConstraintViolation(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = Array.isArray(error.meta?.target)
        ? error.meta.target.join(',')
        : String(error.meta?.target ?? '');
      return (
        target.includes('loan_one_open_per_member') ||
        (target.includes('tenantId') && target.includes('memberId'))
      );
    }

    const dbError = error as {
      code?: string;
      constraint?: string;
      meta?: { code?: string; constraint?: string; target?: unknown };
      cause?: { code?: string; constraint?: string };
    };
    const code = dbError.code ?? dbError.meta?.code ?? dbError.cause?.code;
    const constraint = dbError.constraint ?? dbError.meta?.constraint ?? dbError.cause?.constraint;

    return code === '23505' && constraint === 'loan_one_open_per_member';
  }

  private async _doMemberApply(
    dto: MemberApplyLoanDto,
    tenantId: string,
    memberId: string,
    userId: string,
    req: Request,
    correlationId: string,
  ) {
    const principal = new Decimal(dto.principalAmount);
    let guarantors = dto.guarantors ?? [];
    const year = new Date().getFullYear();

    try {
      const txResult = await this.prisma.$transaction(
        async (tx) => {
          const member = await tx.member.findFirst({
            where: { id: memberId, tenantId, isActive: true },
            select: { id: true, memberNumber: true, kycStatus: true, isBlacklisted: true },
          });
          if (!member) {
            throw new NotFoundException('Member not found or inactive');
          }
          if (member.kycStatus !== 'APPROVED') {
            throw new BadRequestException('KYC verification required before applying for a loan');
          }
          if (member.isBlacklisted) {
            throw new ForbiddenException('Member is blacklisted and cannot apply for loans');
          }
          await tx.$queryRaw`
          SELECT id FROM "Member"
          WHERE id = ${memberId} AND "tenantId" = ${tenantId}
          FOR UPDATE
        `;

          const existingOpenLoan = await tx.loan.findFirst({
            where: {
              memberId,
              tenantId,
              status: {
                in: [
                  LoanStatus.DRAFT,
                  LoanStatus.PENDING_GUARANTORS,
                  LoanStatus.PENDING_REVIEW,
                  LoanStatus.PENDING_APPROVAL,
                  LoanStatus.APPROVED,
                  LoanStatus.DISBURSED,
                  LoanStatus.ACTIVE,
                  LoanStatus.DEFAULTED,
                ],
              },
            },
            select: { id: true, loanNumber: true, status: true },
          });
          if (existingOpenLoan) {
            throw new BadRequestException(
              `ONE_OPEN_LOAN_ONLY: You already have loan ${existingOpenLoan.loanNumber} in ${existingOpenLoan.status.replace(/_/g, ' ')} status. You can apply for another loan after it is fully paid.`,
            );
          }

          const product = await tx.loanProduct.findFirst({
            where: { id: dto.loanProductId, tenantId, isActive: true },
          });
          if (!product) {
            throw new NotFoundException('Loan product not found or inactive');
          }

          if (dto.guarantorIds?.length) {
            const coverageRatio = new Decimal(product.guarantorCoverageRatio?.toString() ?? '1.0');
            const requiredCoverage = principal.times(coverageRatio).toDecimalPlaces(4);
            const equalShare = requiredCoverage
              .div(dto.guarantorIds.length)
              .toDecimalPlaces(4, Decimal.ROUND_DOWN);
            guarantors = dto.guarantorIds.map((guarantorId, index) => {
              const guaranteedAmount =
                index === dto.guarantorIds!.length - 1
                  ? requiredCoverage
                      .minus(equalShare.times(dto.guarantorIds!.length - 1))
                      .toDecimalPlaces(4)
                  : equalShare;
              return { memberId: guarantorId, guaranteedAmount: guaranteedAmount.toNumber() };
            });
          }

          const minAmt = new Decimal(product.minAmount.toString());
          const maxAmt = new Decimal(product.maxAmount.toString());
          if (principal.lessThan(minAmt) || principal.greaterThan(maxAmt)) {
            throw new BadRequestException(
              `Principal must be between KES ${minAmt.toNumber()} and KES ${maxAmt.toNumber()}`,
            );
          }
          if (dto.tenureMonths > product.maxTenureMonths) {
            throw new BadRequestException(`Maximum tenure is ${product.maxTenureMonths} months`);
          }

          const defaultedLoan = await tx.loan.findFirst({
            where: { memberId, tenantId, status: LoanStatus.DEFAULTED },
            select: { id: true },
          });
          if (defaultedLoan) {
            throw new BadRequestException('Member has an active defaulted loan');
          }

          const accounts = await tx.account.findMany({
            where: { memberId, tenantId, isActive: true },
            select: { accountType: true, balance: true, lockedBalance: true, frozenSavings: true },
          });

          const fosaBalance = this.sumAvailableSavings(accounts, AccountType.FOSA);
          const bosaBalance = this.sumAvailableSavings(accounts, AccountType.BOSA);
          if (fosaBalance.plus(bosaBalance).equals(0)) {
            throw new BadRequestException('No active FOSA or BOSA account found');
          }

          const rules = this.productRules.assertLoanApplicationRules({
            product,
            principal,
            guarantorCount: guarantors.length,
            fosaBalance,
            bosaBalance,
          });

          const requiresGuarantors = rules.minGuarantors > 0 || guarantors.length > 0;
          const guarantorAccountType = this.guarantorValidation.resolveAccountType(product);
          const coverageResult =
            requiresGuarantors || guarantors.length > 0
              ? await this.guarantorValidation.validateGuarantorCoverage(
                  tx,
                  tenantId,
                  principal,
                  guarantors,
                  product,
                )
              : {
                  totalGuaranteed: new Decimal(0),
                  requiredCoverage: new Decimal(0),
                  coverageRatio: new Decimal(product.guarantorCoverageRatio?.toString() ?? '1.0'),
                };

          if (guarantors.length > 0) {
            const eligibilityResults = await this.validateGuarantorsEligibilityBatchInTransaction(
              tx,
              guarantors.map((item) => ({
                memberId: item.memberId,
                guaranteedAmount: new Decimal(item.guaranteedAmount),
              })),
              tenantId,
              memberId,
              guarantorAccountType,
            );
            const ineligible = eligibilityResults.find((result) => !result.eligible);
            if (ineligible) {
              throw new BadRequestException(
                `GUARANTOR_NOT_ELIGIBLE: guarantor ${ineligible.memberId} not eligible: ${ineligible.reason}`,
              );
            }
          }

          const annualRate = new Decimal(product.interestRate.toString());
          const processingFeeRate = new Decimal(product.processingFeeRate.toString());
          const processingFee = principal.times(processingFeeRate).toDecimalPlaces(4);
          const monthlyInstalment = this.calculateInstalment(
            principal,
            annualRate,
            dto.tenureMonths,
            product.interestType,
          );

          const counter = await tx.tenantCounter.upsert({
            where: { tenantId },
            create: { tenantId, loanSeq: 1 },
            update: { loanSeq: { increment: 1 } },
          });
          const loanNumber = `LN-${year}-${String(counter.loanSeq).padStart(6, '0')}`;

          const createdLoan = await tx.loan.create({
            data: {
              tenantId,
              memberId,
              loanProductId: dto.loanProductId,
              loanNumber,
              status: requiresGuarantors ? LoanStatus.PENDING_GUARANTORS : LoanStatus.DRAFT,
              purpose: dto.purpose,
              principalAmount: principal.toDecimalPlaces(4).toString(),
              interestRate: annualRate.toDecimalPlaces(4).toString(),
              processingFee: processingFee.toString(),
              tenureMonths: dto.tenureMonths,
              gracePeriodMonths: product.gracePeriodMonths,
              monthlyInstalment: monthlyInstalment.toDecimalPlaces(4).toString(),
              outstandingBalance: principal.toDecimalPlaces(4).toString(),
              notes: dto.notes,
            },
            include: {
              member: {
                select: {
                  memberNumber: true,
                  user: { select: { firstName: true, lastName: true } },
                },
              },
              loanProduct: { select: { name: true, interestType: true } },
            },
          });

          const pendingGuarantors: Array<{
            id: string;
            memberId: string;
            guaranteedAmount: Decimal;
          }> = [];

          if (requiresGuarantors) {
            for (const item of guarantors) {
              const createdGuarantor = await tx.loanGuarantor.create({
                data: {
                  tenantId,
                  loanId: createdLoan.id,
                  memberId: item.memberId,
                  guaranteedAmount: new Decimal(item.guaranteedAmount)
                    .toDecimalPlaces(4)
                    .toString(),
                  status: GuarantorStatus.PENDING,
                  expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
                },
              });
              pendingGuarantors.push({
                id: createdGuarantor.id,
                memberId: item.memberId,
                guaranteedAmount: new Decimal(item.guaranteedAmount),
              });
            }
          }

          await this.createAuditLogInTransaction(tx, {
            tenantId,
            actorId: userId,
            action: 'LOAN.APPLY',
            entityType: 'Loan',
            entityId: createdLoan.id,
            metadata: {
              loanNumber: createdLoan.loanNumber,
              memberId,
              principalAmount: principal.toNumber(),
              tenureMonths: dto.tenureMonths,
              monthlyInstalment: monthlyInstalment.toNumber(),
              loanProductId: dto.loanProductId,
              productName: product.name,
              requiredAccountType: product.requiredAccountType ?? 'COMBINED',
              savingsMultiplier: rules.savingsMultiplier.toNumber(),
              eligibleSavings: rules.eligibleSavings.toNumber(),
              minGuarantors: rules.minGuarantors,
              guarantorCount: guarantors.length,
              guarantorCoverageRatio: coverageResult.coverageRatio.toNumber(),
              totalGuaranteed: coverageResult.totalGuaranteed.toNumber(),
              requiredCoverage: coverageResult.requiredCoverage.toNumber(),
              correlationId,
            },
            ipAddress: req.ip ?? null,
            userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
            requestId: `${correlationId}:loan-apply`,
          });

          return {
            loan: createdLoan,
            principalAmount: principal.toNumber(),
            guarantorNotifications: pendingGuarantors.map((guarantor) => ({
              guarantorId: guarantor.id,
              memberId: guarantor.memberId,
              guaranteedAmount: guarantor.guaranteedAmount.toNumber(),
              loanNumber: createdLoan.loanNumber,
              borrowerName:
                [createdLoan.member.user.firstName, createdLoan.member.user.lastName]
                  .filter(Boolean)
                  .join(' ') || createdLoan.member.memberNumber,
            })),
          };
        },
        {
          // Incident 2026-07-18: this transaction ran ~15-18 sequential DB
          // round-trips (member/product/account lookups + guarantor validation)
          // and, under Neon compute-quota pressure, exceeded Prisma's unconfigured
          // default (5000ms) at 5160ms — the transaction was force-closed mid-flight
          // and the next query threw on a dead handle. maxWait bounds how long we'll
          // queue for a pool connection; timeout is the wall-clock budget for the
          // transaction body itself. 30s gives real headroom above the observed
          // failure even with a few guarantors and some latency variance, without
          // masking a truly hung query forever. Scoped to this call only — the
          // global PrismaService default is unchanged.
          maxWait: 10_000,
          timeout: 30_000,
        },
      );

      await this.publishEvent({
        type: 'LoanApplied',
        payload: {
          loanId: txResult.loan.id,
          tenantId,
          memberId,
          principalAmount: txResult.principalAmount,
          loanProductId: dto.loanProductId,
          appliedBy: userId,
          ipAddress: req.ip ?? undefined,
          userAgent: req.headers['user-agent'] ?? undefined,
          correlationId,
        },
      });
      this.emitDomainEvent(DOMAIN_EVENTS.LOAN.APPLICATION_RECEIVED, {
        tenantId,
        loanId: txResult.loan.id,
        memberId,
        principalAmount: txResult.principalAmount,
        loanProductId: dto.loanProductId,
        appliedBy: userId,
        correlationId,
      });

      const guarantorMemberIds = txResult.guarantorNotifications.map(
        (guarantor) => guarantor.memberId,
      );
      const guarantorMembers =
        guarantorMemberIds.length > 0
          ? await this.prisma.member.findMany({
              where: { id: { in: guarantorMemberIds }, tenantId },
              select: {
                id: true,
                userId: true,
                user: { select: { email: true, firstName: true, phone: true, phoneNumber: true } },
              },
            })
          : [];
      const guarantorMemberMap = new Map(guarantorMembers.map((member) => [member.id, member]));

      for (const guarantor of txResult.guarantorNotifications) {
        const guarantorMember = guarantorMemberMap.get(guarantor.memberId);
        this.emitDomainEvent(DOMAIN_EVENTS.GUARANTOR.REQUESTED, {
          tenantId,
          loanId: txResult.loan.id,
          guarantorUserId: guarantorMember?.userId ?? guarantor.memberId,
          guarantorMemberId: guarantor.memberId,
          guaranteedAmount: guarantor.guaranteedAmount,
        });

        await this.guarantorExpiryQueue
          .add(
            'guarantor-expiry-check',
            { tenantId, loanId: txResult.loan.id, guarantorId: guarantor.guarantorId },
            {
              delay: 72 * 60 * 60 * 1000,
              attempts: 3,
              removeOnComplete: 1000,
              removeOnFail: { age: 86400, count: 50 },
            },
          )
          .catch((e: unknown) => this.logger.error('Failed to enqueue guarantor expiry', e));

        if (guarantorMember?.user?.email) {
          this.enqueueEmail(
            {
              type: 'GUARANTOR_INVITE',
              to: guarantorMember.user.email,
              firstName: guarantorMember.user.firstName,
              borrowerName: guarantor.borrowerName,
              loanNumber: guarantor.loanNumber,
              guaranteedAmount: guarantor.guaranteedAmount,
              loanPrincipal: txResult.principalAmount,
            },
            `loan.apply.guarantorInvite:${txResult.loan.id}:${guarantor.memberId}`,
          );
        }
        const guarantorPhone = guarantorMember?.user?.phone ?? guarantorMember?.user?.phoneNumber;
        if (guarantorPhone) {
          void this.smsService.enqueueSms(
            {
              type: 'GUARANTOR_INVITE',
              phone: guarantorPhone,
              message:
                `Beba SACCO: ${guarantor.borrowerName} requested you to guarantee loan ` +
                `${guarantor.loanNumber} for KES ${guarantor.guaranteedAmount}. Log in to respond.`,
            },
            `loan.apply.guarantorSms:${txResult.loan.id}:${guarantor.memberId}`,
          );
        }
      }

      return txResult.loan;
    } catch (err) {
      if (
        err instanceof BadRequestException ||
        err instanceof NotFoundException ||
        err instanceof ConflictException ||
        err instanceof ForbiddenException
      ) {
        throw err;
      }
      this.logger.error(
        `Loan application transaction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new InternalServerErrorException(
        'Loan application could not be completed. Please retry.',
      );
    }
  }

  private sumAvailableSavings(
    accounts: Array<{
      accountType: AccountType;
      balance: { toString(): string };
      lockedBalance: { toString(): string } | null;
      frozenSavings: { toString(): string } | null;
    }>,
    accountType?: AccountType,
  ): Decimal {
    return accounts
      .filter((account) => !accountType || account.accountType === accountType)
      .reduce((sum, account) => {
        const balance = new Decimal(account.balance.toString());
        const lockedBalance = new Decimal(account.lockedBalance?.toString() ?? '0');
        const frozenSavings = new Decimal(account.frozenSavings?.toString() ?? '0');
        return sum.plus(balance.minus(lockedBalance).minus(frozenSavings));
      }, new Decimal(0));
  }

  /**
   * Batched replacement for the former validateGuarantorEligibilityInTransaction()
   * (called once per guarantor in a loop — 6 sequential queries each). That
   * fan-out was a major contributor to incident 2026-07-18: a 3-guarantor
   * application ran ~18 sequential round-trips here alone, inside a single
   * interactive transaction, eating most of its time budget.
   *
   * DB round-trips: exactly 5, regardless of guarantor count.
   *
   * Preserves the exact eligibility rules, error messages, and evaluation
   * order of the method it replaces — only the query shape changed.
   */
  private async validateGuarantorsEligibilityBatchInTransaction(
    tx: Prisma.TransactionClient,
    guarantors: Array<{ memberId: string; guaranteedAmount: Decimal }>,
    tenantId: string,
    borrowerMemberId: string,
    accountType: AccountType = AccountType.FOSA,
  ): Promise<Array<{ memberId: string; eligible: boolean; reason?: string }>> {
    const guarantorIds = guarantors.map((g) => g.memberId);

    // 1. All guarantor members + their user + their accounts of accountType.
    const members = await tx.member.findMany({
      where: { id: { in: guarantorIds }, tenantId, isActive: true },
      select: {
        id: true,
        kycStatus: true,
        isBlacklisted: true,
        user: { select: { role: true, accountStatus: true } },
        accounts: {
          where: { accountType, isActive: true },
          select: { id: true, balance: true, lockedBalance: true, frozenSavings: true },
        },
      },
    });
    const memberById = new Map(members.map((m) => [m.id, m]));

    // 2. Circular-guarantee check for ALL guarantors at once: is the borrower
    //    already guaranteeing an active/pending loan for any of them?
    const circularGuarantees = await tx.loanGuarantor.findMany({
      where: {
        tenantId,
        memberId: borrowerMemberId,
        status: { in: [GuarantorStatus.PENDING, GuarantorStatus.ACCEPTED] },
        loan: {
          tenantId,
          memberId: { in: guarantorIds },
          status: {
            in: [
              LoanStatus.PENDING_GUARANTORS,
              LoanStatus.PENDING_REVIEW,
              LoanStatus.PENDING_APPROVAL,
              LoanStatus.APPROVED,
              LoanStatus.ACTIVE,
              LoanStatus.DISBURSED,
            ],
          },
        },
      },
      select: { loan: { select: { memberId: true } } },
    });
    const circularGuarantorIds = new Set(circularGuarantees.map((g) => g.loan.memberId));

    // 3. Defaulted-loan check for ALL guarantors at once.
    const defaultedLoans = await tx.loan.findMany({
      where: { memberId: { in: guarantorIds }, tenantId, status: LoanStatus.DEFAULTED },
      select: { memberId: true },
    });
    const defaultedGuarantorIds = new Set(defaultedLoans.map((l) => l.memberId));

    // 4. Active-guarantee counts for ALL guarantors at once. Unlike the
    //    per-guarantor original, this has no `loanId: { not: loanId }`
    //    exclusion — the sole call site passes a not-yet-created loan, so
    //    that exclusion was always a no-op here.
    const activeGuaranteeCounts = await tx.loanGuarantor.groupBy({
      by: ['memberId'],
      where: {
        memberId: { in: guarantorIds },
        tenantId,
        status: GuarantorStatus.ACCEPTED,
        loan: {
          tenantId,
          status: { in: [LoanStatus.ACTIVE, LoanStatus.APPROVED, LoanStatus.DISBURSED] },
        },
      },
      _count: { _all: true },
    });
    const activeGuaranteesByMember = new Map(
      activeGuaranteeCounts.map((row) => [row.memberId, row._count._all]),
    );

    // 5. Tenant settings — shared across all guarantors, fetched once instead
    //    of once per guarantor.
    const tenant = await tx.tenant.findFirst({
      where: { id: tenantId },
      select: { settings: true },
    });
    const maxGuarantees = this.resolveMaxConcurrentGuarantees(tenant?.settings);

    return guarantors.map(({ memberId: guarantorMemberId, guaranteedAmount }) => {
      if (guarantorMemberId === borrowerMemberId) {
        return {
          memberId: guarantorMemberId,
          eligible: false,
          reason: 'Member cannot guarantee their own loan',
        };
      }

      const guarantor = memberById.get(guarantorMemberId);
      if (!guarantor) {
        return {
          memberId: guarantorMemberId,
          eligible: false,
          reason: 'Guarantor not found or inactive',
        };
      }
      if (
        guarantor.user.role !== UserRole.MEMBER ||
        guarantor.user.accountStatus !== AccountStatus.ACTIVE
      ) {
        return {
          memberId: guarantorMemberId,
          eligible: false,
          reason: 'Guarantor must be an active approved member',
        };
      }
      if (guarantor.kycStatus !== 'APPROVED') {
        return {
          memberId: guarantorMemberId,
          eligible: false,
          reason: 'Guarantor KYC is not approved',
        };
      }
      if (guarantor.isBlacklisted) {
        return { memberId: guarantorMemberId, eligible: false, reason: 'Guarantor is blacklisted' };
      }
      if (circularGuarantorIds.has(guarantorMemberId)) {
        return {
          memberId: guarantorMemberId,
          eligible: false,
          reason:
            'Circular guarantee detected. This member is already guaranteeing a loan for the applicant.',
        };
      }

      const fosaAccount = guarantor.accounts[0];
      if (!fosaAccount) {
        return {
          memberId: guarantorMemberId,
          eligible: false,
          reason: `Guarantor has no active ${accountType} account`,
        };
      }

      const availableBalance = new Decimal(fosaAccount.balance.toString()).minus(
        new Decimal(fosaAccount.lockedBalance?.toString() ?? '0').plus(
          new Decimal(fosaAccount.frozenSavings?.toString() ?? '0'),
        ),
      );
      if (availableBalance.lessThan(guaranteedAmount)) {
        return {
          memberId: guarantorMemberId,
          eligible: false,
          reason: `Insufficient ${accountType} available balance: available KES ${availableBalance.toFixed(2)}, committing KES ${guaranteedAmount.toFixed(2)}`,
        };
      }

      if (defaultedGuarantorIds.has(guarantorMemberId)) {
        return {
          memberId: guarantorMemberId,
          eligible: false,
          reason: 'Guarantor has a defaulted loan',
        };
      }

      const activeGuarantees = activeGuaranteesByMember.get(guarantorMemberId) ?? 0;
      if (activeGuarantees >= maxGuarantees) {
        return {
          memberId: guarantorMemberId,
          eligible: false,
          reason: `Guarantor has reached the maximum concurrent guarantee limit (${maxGuarantees})`,
        };
      }

      return { memberId: guarantorMemberId, eligible: true };
    });
  }

  private resolveMaxConcurrentGuarantees(settings: Prisma.JsonValue | null | undefined): number {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return 3;
    }

    const value = (settings as Record<string, unknown>).maxConcurrentGuarantees;
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 3;
  }

  private async createAuditLogInTransaction(
    tx: Prisma.TransactionClient,
    data: {
      tenantId: string;
      actorId?: string | null;
      action: string;
      entityType: string;
      entityId?: string | null;
      oldValue?: Record<string, unknown>;
      newValue?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      ipAddress?: string | null;
      userAgent?: string | null;
      requestId?: string | null;
    },
  ): Promise<void> {
    const timestamp = new Date();
    const prevEntry = await tx.auditLog.findFirst({
      where: { tenantId: data.tenantId },
      orderBy: { timestamp: 'desc' },
      select: { entryHash: true },
    });
    const prevHash = prevEntry?.entryHash ?? null;
    const entryHash = this.computeAuditEntryHash({
      tenantId: data.tenantId,
      actorId: data.actorId ?? null,
      action: data.action,
      entityType: data.entityType,
      entityId: data.entityId ?? null,
      timestamp,
      prevHash,
    });

    await tx.auditLog.create({
      data: {
        tenantId: data.tenantId,
        actorId: data.actorId ?? null,
        action: data.action,
        entityType: data.entityType,
        entityId: data.entityId ?? null,
        oldValue: data.oldValue ? (data.oldValue as Prisma.InputJsonValue) : Prisma.JsonNull,
        newValue: data.newValue ? (data.newValue as Prisma.InputJsonValue) : Prisma.JsonNull,
        metadata: data.metadata ? (data.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
        ipAddress: data.ipAddress ?? null,
        userAgent: data.userAgent ?? null,
        requestId: data.requestId ?? null,
        timestamp,
        prevHash,
        entryHash,
      },
    });
  }

  private computeAuditEntryHash(entry: {
    tenantId: string;
    actorId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    timestamp: Date;
    prevHash?: string | null;
  }): string {
    const payload = [
      entry.tenantId,
      entry.actorId ?? '',
      entry.action,
      entry.entityType,
      entry.entityId ?? '',
      entry.timestamp.toISOString(),
      entry.prevHash ?? '',
    ].join('|');

    return createHash('sha256').update(payload, 'utf8').digest('hex');
  }

  // ─── INVITE GUARANTORS ─────────────────────────────────────────────────────

  /**
   * Invite guarantors for a DRAFT loan.
   * Creates LoanGuarantor rows with PENDING status and 72h expiry.
   */
  async inviteGuarantors(
    loanId: string,
    guarantors: GuarantorNominationDto[],
    tenantId: string,
    invitedBy: string,
    req: Request,
  ) {
    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, tenantId },
      select: {
        id: true,
        status: true,
        loanNumber: true,
        memberId: true,
        principalAmount: true,
        loanProduct: {
          select: { requiredAccountType: true, guarantorCoverageRatio: true, maxGuarantors: true },
        },
        member: { select: { user: { select: { firstName: true, lastName: true } } } },
      },
    });
    if (!loan) throw new NotFoundException('Loan not found');
    if (loan.status !== LoanStatus.DRAFT && loan.status !== LoanStatus.PENDING_GUARANTORS) {
      throw new BadRequestException(`Cannot add guarantors to a loan in "${loan.status}" status`);
    }

    const principal = new Decimal(loan.principalAmount.toString());
    const minCoverageRatio = new Decimal(
      loan.loanProduct.guarantorCoverageRatio?.toString() ?? '1.00',
    );
    const consentExpiryHours = 72;
    const minCoverageRequired = principal.times(minCoverageRatio);
    const existingActiveGuarantors = await this.prisma.loanGuarantor.count({
      where: {
        tenantId,
        loanId,
        status: { in: [GuarantorStatus.PENDING, GuarantorStatus.ACCEPTED] },
      },
    });
    if (
      loan.loanProduct.maxGuarantors > 0 &&
      existingActiveGuarantors + guarantors.length > loan.loanProduct.maxGuarantors
    ) {
      throw new BadRequestException(
        `This product allows at most ${loan.loanProduct.maxGuarantors} guarantor(s).`,
      );
    }
    const accountType = this.guarantorValidation.resolveAccountType(loan.loanProduct);

    const results: Array<{
      memberId: string;
      guaranteedAmount: number;
      status: 'invited' | 'skipped';
      reason?: string;
    }> = [];
    const guarantorMemberIds = Array.from(
      new Set(guarantors.map((guarantor) => guarantor.memberId)),
    );
    const guarantorMembers =
      guarantorMemberIds.length > 0
        ? await this.prisma.member.findMany({
            where: { id: { in: guarantorMemberIds }, tenantId },
            select: { id: true, userId: true, user: { select: { email: true, firstName: true } } },
          })
        : [];
    const guarantorMemberMap = new Map(guarantorMembers.map((member) => [member.id, member]));

    for (const item of guarantors) {
      const eligibility = await this.validateGuarantorEligibility(
        item.memberId,
        loanId,
        tenantId,
        new Decimal(item.guaranteedAmount),
        loan.memberId,
        accountType,
      );

      if (!eligibility.eligible) {
        results.push({
          memberId: item.memberId,
          guaranteedAmount: item.guaranteedAmount,
          status: 'skipped',
          reason: eligibility.reason,
        });
        continue;
      }

      // Compute expiry
      const invitedAt = new Date();
      const expiresAt = new Date(invitedAt);
      expiresAt.setHours(expiresAt.getHours() + consentExpiryHours);

      // Upsert LoanGuarantor (idempotent re-invite)
      const createdGuarantor = await this.prisma.loanGuarantor.upsert({
        where: { loanId_memberId: { loanId, memberId: item.memberId } },
        create: {
          tenantId,
          loanId,
          memberId: item.memberId,
          guaranteedAmount: new Decimal(item.guaranteedAmount).toDecimalPlaces(4).toString(),
          status: GuarantorStatus.PENDING,
          invitedAt,
          expiresAt,
        },
        update: {
          guaranteedAmount: new Decimal(item.guaranteedAmount).toDecimalPlaces(4).toString(),
          status: GuarantorStatus.PENDING,
          invitedAt,
          expiresAt,
          respondedAt: null,
        },
      });

      results.push({
        memberId: item.memberId,
        guaranteedAmount: item.guaranteedAmount,
        status: 'invited',
      });

      // Notify guarantor
      const guarantorMember = guarantorMemberMap.get(item.memberId);
      this.emitDomainEvent(DOMAIN_EVENTS.GUARANTOR.REQUESTED, {
        tenantId,
        loanId,
        guarantorUserId: guarantorMember?.userId ?? item.memberId,
        guarantorMemberId: item.memberId,
        guaranteedAmount: item.guaranteedAmount,
      });

      const borrowerName =
        [loan.member?.user?.firstName, loan.member?.user?.lastName].filter(Boolean).join(' ') ||
        'A fellow member';

      if (guarantorMember?.user?.email) {
        this.enqueueEmail(
          {
            type: 'GUARANTOR_INVITE',
            to: guarantorMember.user.email,
            firstName: guarantorMember.user.firstName,
            borrowerName,
            loanNumber: loan.loanNumber,
            guaranteedAmount: item.guaranteedAmount,
            loanPrincipal: principal.toNumber(),
          },
          `loan.inviteGuarantor:${loanId}:${item.memberId}`,
        );
      }

      // Schedule reminders at 24h and 48h post-invite. Both jobs re-check the
      // guarantor's live status before sending (see GuarantorReminderProcessor),
      // so an early response simply makes the later job a no-op. jobId makes
      // re-invite (upsert) idempotent instead of stacking duplicate reminders.
      const reminderPayload: Omit<GuarantorReminderJobPayload, 'stage'> = {
        loanId,
        guarantorId: item.memberId,
        tenantId,
        memberId: item.memberId,
        loanNumber: loan.loanNumber,
      };
      this.guarantorReminderQueue
        .add(
          'send-reminder',
          { ...reminderPayload, stage: 1 },
          {
            delay: 24 * 60 * 60 * 1000,
            attempts: 2,
            jobId: `guarantor-reminder-24h.${loanId}.${item.memberId}`,
          },
        )
        .catch((e: unknown) => this.logger.error('Failed to enqueue 24h guarantor reminder', e));
      this.guarantorReminderQueue
        .add(
          'send-reminder',
          { ...reminderPayload, stage: 2 },
          {
            delay: 48 * 60 * 60 * 1000,
            attempts: 2,
            jobId: `guarantor-reminder-48h.${loanId}.${item.memberId}`,
          },
        )
        .catch((e: unknown) => this.logger.error('Failed to enqueue 48h guarantor reminder', e));

      this.guarantorExpiryQueue
        .add(
          'guarantor-expiry-check',
          { tenantId, loanId, guarantorId: createdGuarantor.id },
          {
            delay: consentExpiryHours * 60 * 60 * 1000,
            attempts: 3,
            removeOnComplete: 1000,
            removeOnFail: { age: 86400, count: 50 },
          },
        )
        .catch((e: unknown) => this.logger.error('Failed to enqueue guarantor expiry', e));
    }

    // Update loan status
    await this.prisma.loan.update({
      where: { id: loanId },
      data: { status: LoanStatus.PENDING_GUARANTORS },
    });

    const invitedCount = results.filter((r) => r.status === 'invited').length;
    const totalGuaranteed = results
      .filter((r) => r.status === 'invited')
      .reduce((sum, r) => sum.plus(r.guaranteedAmount), new Decimal(0));

    await this.audit
      .create({
        tenantId,
        actorId: invitedBy,
        action: 'LOAN.GUARANTORS_INVITED',
        entityType: 'Loan',
        entityId: loanId,
        metadata: {
          loanNumber: loan.loanNumber,
          invitedCount,
          totalGuaranteed: totalGuaranteed.toNumber(),
          minCoverageRequired: minCoverageRequired.toNumber(),
        },
        ipAddress: req.ip ?? undefined,
        userAgent: req.headers['user-agent'] ?? undefined,
      })
      .catch((e: unknown) => this.logger.error('Audit write failed', e));

    return {
      loanId,
      invitedCount,
      totalGuaranteedAmount: totalGuaranteed.toNumber(),
      minimumCoverageRequired: minCoverageRequired.toNumber(),
      coverageMet: totalGuaranteed.greaterThanOrEqualTo(minCoverageRequired),
      results,
    };
  }

  // ─── CHECK COVERAGE & ADVANCE STATUS ───────────────────────────────────────

  private async checkAndAdvanceLoanStatus(loanId: string, tenantId: string) {
    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, tenantId, status: LoanStatus.PENDING_GUARANTORS },
      select: {
        id: true,
        principalAmount: true,
        loanProduct: { select: { minGuarantors: true, guarantorCoverageRatio: true } },
      },
    });
    if (!loan) return;

    const acceptedGuarantors = await this.prisma.loanGuarantor.findMany({
      where: { loanId, tenantId, status: GuarantorStatus.ACCEPTED },
      select: { guaranteedAmount: true },
    });

    const totalAccepted = acceptedGuarantors.reduce(
      (sum, g) => sum.plus(new Decimal(g.guaranteedAmount.toString())),
      new Decimal(0),
    );

    const principal = new Decimal(loan.principalAmount.toString());
    const minCoverage = principal.times(
      new Decimal(loan.loanProduct.guarantorCoverageRatio.toString()),
    );

    if (
      acceptedGuarantors.length >= loan.loanProduct.minGuarantors &&
      totalAccepted.greaterThanOrEqualTo(minCoverage)
    ) {
      await this.prisma.loan.updateMany({
        where: { id: loanId, tenantId },
        data: { status: LoanStatus.PENDING_APPROVAL },
      });
      this.logger.log(
        `Loan ${loanId} advanced to PENDING_APPROVAL - coverage ${totalAccepted.toNumber()} >= ${minCoverage.toNumber()}`,
      );
    }
  }

  // ─── GET GUARANTOR STATUS ──────────────────────────────────────────────────

  async getGuarantorStatus(loanId: string, tenantId: string, memberId?: string) {
    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, tenantId },
      select: { id: true, status: true, loanNumber: true, principalAmount: true },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    const where: Record<string, unknown> = { loanId };
    if (memberId) {
      where.memberId = memberId;
    }

    const guarantors = await this.prisma.loanGuarantor.findMany({
      where,
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

    const principal = new Decimal(loan.principalAmount.toString());
    const totalAccepted = guarantors
      .filter((g) => g.status === GuarantorStatus.ACCEPTED)
      .reduce((sum, g) => sum.plus(new Decimal(g.guaranteedAmount.toString())), new Decimal(0));

    return {
      loanId,
      loanNumber: loan.loanNumber,
      principalAmount: principal.toNumber(),
      totalAccepted: totalAccepted.toNumber(),
      coverageMet: totalAccepted.greaterThanOrEqualTo(principal),
      guarantors: guarantors.map((g) => ({
        memberId: g.memberId,
        memberNumber: g.member.memberNumber,
        name: `${g.member.user.firstName} ${g.member.user.lastName}`,
        status: g.status,
        guaranteedAmount: new Decimal(g.guaranteedAmount.toString()).toNumber(),
        invitedAt: g.invitedAt,
        respondedAt: g.respondedAt,
        notes: g.notes,
      })),
    };
  }

  // ─── ADMIN: UPDATE LOAN STATUS ─────────────────────────────────────────────

  /**
   * PATCH /admin/loans/:id/status
   * Restricted to MANAGER and TENANT_ADMIN roles.
   */
  async updateStatus(
    loanId: string,
    dto: { status: AdminLoanStatus; reason?: string },
    tenantId: string,
    actor: AuthenticatedUser,
    req: Request,
  ) {
    // Role check: only MANAGER+ can update loan status
    const allowedRoles = new Set<string>([
      UserRole.LOAN_OFFICER,
      UserRole.MANAGER,
      UserRole.TENANT_ADMIN,
      UserRole.SUPER_ADMIN,
    ]);
    if (!allowedRoles.has(actor.role)) {
      throw new ForbiddenException('Only loan officers and above can update loan status');
    }

    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, tenantId },
      select: {
        id: true,
        status: true,
        loanNumber: true,
        memberId: true,
        member: {
          select: {
            user: { select: { email: true, firstName: true, phone: true, phoneNumber: true } },
          },
        },
      },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    const oldStatus = loan.status;
    const correlationId = (req.headers['x-request-id'] as string) ?? uuidv4();
    const targetStatus = dto.status as unknown as LoanStatus;
    const userAgent = req.get?.('user-agent') ?? (req.headers['user-agent'] as string | undefined);

    if (!canTransition(oldStatus, targetStatus)) {
      throw new BadRequestException(`Cannot transition from ${oldStatus} to ${targetStatus}`);
    }

    // DISBURSED must go through LoansService.disburse() (real FOSA credit).
    if (targetStatus === LoanStatus.DISBURSED) {
      throw new BadRequestException(
        'DISBURSED transitions must go through PATCH /admin/loans/:id/status which routes ' +
          'to LoansService.disburse() for financial processing. ' +
          'Direct calls to updateStatus() with DISBURSED are not permitted.',
      );
    }

    if (targetStatus === LoanStatus.APPROVED) {
      return this.loansService.approve(loanId, tenantId, actor.id, dto.reason, req.ip, userAgent);
    }

    if (targetStatus === LoanStatus.REJECTED) {
      if (!dto.reason) {
        throw new BadRequestException('Reason is required when rejecting a loan');
      }
      return this.loansService.reject(
        loanId,
        { reason: dto.reason },
        tenantId,
        actor.id,
        req.ip,
        userAgent,
      );
    }

    // Validate state transitions (workflow-only)
    const validTransitions: Record<string, string[]> = {
      [LoanStatus.DRAFT]: [LoanStatus.PENDING_GUARANTORS],
      [LoanStatus.PENDING_GUARANTORS]: [
        LoanStatus.PENDING_REVIEW,
        LoanStatus.PENDING_APPROVAL,
        LoanStatus.REJECTED_GUARANTOR_DECLINE,
      ],
      [LoanStatus.PENDING_REVIEW]: [],
      [LoanStatus.PENDING_APPROVAL]: [],
      // APPROVED → DISBURSED is intentionally absent: handled by LoansService.disburse()
    };

    const allowedNext = validTransitions[oldStatus] ?? [];
    if (!allowedNext.includes(targetStatus)) {
      throw new BadRequestException(
        `Cannot transition from "${oldStatus}" to "${dto.status}". Valid transitions: ${allowedNext.join(', ')}`,
      );
    }

    const updated = await this.prisma.loan.update({
      where: { id: loanId },
      data: { status: targetStatus, ...(dto.reason && { notes: dto.reason }) },
    });

    // Audit
    await this.audit
      .create({
        tenantId,
        actorId: actor.id,
        action: `LOAN.STATUS.${dto.status}`,
        entityType: 'Loan',
        entityId: loanId,
        metadata: {
          oldStatus,
          newStatus: dto.status,
          reason: dto.reason,
          loanNumber: loan.loanNumber,
          correlationId,
        },
        ipAddress: req.ip ?? undefined,
        userAgent: req.headers['user-agent'] ?? undefined,
        requestId: correlationId,
      })
      .catch((e: unknown) => this.logger.error('Audit write failed', e));

    this.emitDomainEvent(DOMAIN_EVENTS.LOAN.STATUS_CHANGED, {
      tenantId,
      loanId,
      memberId: loan.memberId,
      oldStatus,
      newStatus: targetStatus,
      actorId: actor.id,
      reason: dto.reason,
      correlationId,
    });

    return updated;
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

  // ─── ADMIN: GUARANTOR EXPOSURE CHECK ───────────────────────────────────────

  /**
   * GET /admin/members/:id/guarantor-exposure
   * Returns a member's total guarantee exposure, active guarantees,
   * and remaining capacity.
   */
  async getGuarantorExposure(memberId: string, tenantId: string) {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, tenantId, isActive: true },
      select: {
        id: true,
        memberNumber: true,
        user: { select: { firstName: true, lastName: true } },
      },
    });
    if (!member) throw new NotFoundException('Member not found');

    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId },
      select: { settings: true },
    });
    const maxGuarantees = this.resolveMaxConcurrentGuarantees(tenant?.settings);

    const activeGuarantees = await this.prisma.loanGuarantor.findMany({
      where: {
        memberId,
        tenantId,
        status: GuarantorStatus.ACCEPTED,
        loan: {
          status: {
            in: [
              LoanStatus.ACTIVE,
              LoanStatus.APPROVED,
              LoanStatus.DISBURSED,
              LoanStatus.PENDING_GUARANTORS,
              LoanStatus.PENDING_REVIEW,
            ],
          },
        },
      },
      include: {
        loan: {
          select: {
            id: true,
            loanNumber: true,
            status: true,
            outstandingBalance: true,
            member: { select: { user: { select: { firstName: true, lastName: true } } } },
            guarantors: {
              where: { status: GuarantorStatus.ACCEPTED, holdReleasedAt: null },
              select: { guaranteedAmount: true },
            },
          },
        },
      },
    });

    const activeGuaranteesWithEffectiveHolds = activeGuarantees.map((g) => {
      const outstanding = new Decimal(g.loan.outstandingBalance?.toString() ?? '0');
      const sumHolds = g.loan.guarantors.reduce(
        (holdSum, hold) => holdSum.plus(hold.guaranteedAmount.toString()),
        new Decimal(0),
      );
      let effectiveHold = new Decimal(g.guaranteedAmount.toString());

      if (sumHolds.greaterThan(0) && outstanding.lessThan(sumHolds)) {
        const ratio = outstanding.div(sumHolds);
        effectiveHold = effectiveHold.times(ratio).toDecimalPlaces(4);
      }

      return {
        ...g,
        effectiveHold,
      };
    });

    const totalGuaranteedAmount = activeGuaranteesWithEffectiveHolds.reduce(
      (sum, g) => sum.plus(g.effectiveHold),
      new Decimal(0),
    );

    const currentCount = activeGuarantees.length;
    const canGuarantee = currentCount < maxGuarantees;

    return {
      memberId: member.id,
      memberNumber: member.memberNumber,
      memberName: `${member.user.firstName} ${member.user.lastName}`,
      maxConcurrentGuarantees: maxGuarantees,
      currentGuaranteeCount: currentCount,
      totalGuaranteedAmount: totalGuaranteedAmount.toNumber(),
      remainingCapacity: canGuarantee ? maxGuarantees - currentCount : 0,
      canGuarantee,
      activeGuarantees: activeGuarantees.map((g) => ({
        loanId: g.loan.id,
        loanNumber: g.loan.loanNumber,
        guaranteedAmount: new Decimal(g.guaranteedAmount.toString()).toNumber(),
        borrowerName: `${g.loan.member.user.firstName} ${g.loan.member.user.lastName}`,
        status: g.loan.status,
      })),
    };
  }

  // ─── INSTALMENT CALCULATION ────────────────────────────────────────────────

  private calculateInstalment(
    principal: Decimal,
    annualRate: Decimal,
    tenureMonths: number,
    interestType: InterestType,
  ): Decimal {
    if (interestType === InterestType.FLAT) {
      const totalInterest = principal.times(annualRate).times(tenureMonths).div(12);
      const total = principal.plus(totalInterest);
      return total.div(tenureMonths);
    }

    // REDUCING_BALANCE
    const monthlyRate = annualRate.div(12);
    const pow = Decimal.pow(monthlyRate.plus(1), tenureMonths);
    const numerator = principal.times(monthlyRate).times(pow);
    const denominator = pow.minus(1);
    return numerator.div(denominator);
  }
}
