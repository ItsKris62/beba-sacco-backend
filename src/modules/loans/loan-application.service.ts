import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Decimal } from 'decimal.js';
import {
  LoanStatus,
  GuarantorStatus,
  TransactionType,
  TransactionStatus,
  InterestType,
  UserRole,
  AccountType,
  Prisma,
} from '@prisma/client';
import { canTransition } from './loan-state-machine';
import { v4 as uuidv4 } from 'uuid';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RedisService } from '../../common/services/redis.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { MemberApplyLoanDto, GuarantorNominationDto } from './dto/member-apply-loan.dto';
import { GuarantorConsentResponseDto, GuarantorConsentAction } from './dto/guarantor-consent-response.dto';
import { AdminLoanStatus } from './dto/update-loan-status.dto';
import { ENABLE_PRODUCT_RULES_ENGINE } from '../../config/feature-flags';
import { GuarantorValidationService } from './guarantor-validation.service';
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
  | { type: 'GuarantorConsented'; payload: GuarantorConsentedEvent }
  | { type: 'GuarantorDeclined'; payload: GuarantorDeclinedEvent }
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

export interface GuarantorConsentedEvent {
  loanId: string;
  tenantId: string;
  guarantorMemberId: string;
  guaranteedAmount: number;
  ipAddress?: string;
  userAgent?: string;
  deviceId?: string;
  digitalAcknowledgment: boolean;
  correlationId: string;
}

export interface GuarantorDeclinedEvent {
  loanId: string;
  tenantId: string;
  guarantorMemberId: string;
  reason?: string;
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
  ) {}

  // ─── DOMAIN EVENT PUBLISHER ────────────────────────────────────────────────

  /**
   * Publish a domain event to the audit queue for async processing.
   * Failures are logged but never block the calling operation.
   */
  private async publishEvent(event: LoanDomainEvent): Promise<void> {
    try {
      await this.auditQueue.add('domain-event', {
        tenantId:
          event.type === 'LoanApplied'
            ? event.payload.tenantId
            : event.type === 'GuarantorConsented'
              ? event.payload.tenantId
              : event.type === 'GuarantorDeclined'
                ? event.payload.tenantId
                : event.payload.tenantId,
        action: `EVENT.${event.type}`,
        resource: 'LoanWorkflow',
        resourceId:
          event.type === 'LoanApplied'
            ? event.payload.loanId
            : event.type === 'GuarantorConsented'
              ? event.payload.loanId
              : event.type === 'GuarantorDeclined'
                ? event.payload.loanId
                : event.payload.loanId,
        metadata: { event },
        requestId:
          event.type === 'LoanApplied'
            ? event.payload.correlationId
            : event.type === 'GuarantorConsented'
              ? event.payload.correlationId
              : event.type === 'GuarantorDeclined'
                ? event.payload.correlationId
                : event.payload.correlationId,
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
        removeOnFail: false,
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
  async validateMemberEligibility(memberId: string, tenantId: string): Promise<{
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
        user: { select: { firstName: true, lastName: true } },
      },
    });

    if (!member) {
      return { eligible: false, reason: 'Member not found or inactive', fosaBalance: new Decimal(0), bosaBalance: new Decimal(0), kycStatus: 'UNKNOWN' };
    }

    // Check KYC
    if (member.kycStatus !== 'APPROVED') {
      return { eligible: false, reason: 'KYC verification required before applying for a loan', fosaBalance: new Decimal(0), bosaBalance: new Decimal(0), kycStatus: member.kycStatus };
    }

    // Check accounts
    const accounts = await this.prisma.account.findMany({
      where: { memberId, tenantId, isActive: true },
      select: { accountType: true, balance: true, lockedBalance: true },
    });

    const hasFosa = accounts.some((a) => a.accountType === 'FOSA');
    const hasBosa = accounts.some((a) => a.accountType === 'BOSA');

    if (!hasFosa && !hasBosa) {
      return { eligible: false, reason: 'No active FOSA or BOSA account found', fosaBalance: new Decimal(0), bosaBalance: new Decimal(0), kycStatus: member.kycStatus };
    }

    const fosaBalance = accounts
      .filter((a) => a.accountType === 'FOSA')
      .reduce((sum, a) => sum.plus(new Decimal(a.balance.toString()).minus(new Decimal(a.lockedBalance?.toString() ?? '0'))), new Decimal(0));
    const bosaBalance = accounts
      .filter((a) => a.accountType === 'BOSA')
      .reduce((sum, a) => sum.plus(new Decimal(a.balance.toString()).minus(new Decimal(a.lockedBalance?.toString() ?? '0'))), new Decimal(0));

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
      return { eligible: false, reason: 'Member has an active defaulted loan', fosaBalance, bosaBalance, kycStatus: member.kycStatus };
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
      select: { id: true, user: { select: { firstName: true, lastName: true } } },
    });
    if (!guarantor) {
      return { eligible: false, reason: 'Guarantor not found or inactive' };
    }

    // Check FOSA
    const fosaAccount = await this.prisma.account.findFirst({
      where: { memberId: guarantorMemberId, tenantId, accountType: 'FOSA', isActive: true },
      select: { id: true, balance: true, lockedBalance: true },
    });
    if (!fosaAccount) {
      return { eligible: false, reason: 'Guarantor has no active FOSA account' };
    }

    const fosaBalance = new Decimal(fosaAccount.balance.toString());
    const lockedBalance = new Decimal(fosaAccount.lockedBalance?.toString() ?? '0');
    const availableBalance = fosaBalance.minus(lockedBalance);

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

    // Check concurrent guarantee limit
    // TODO: Replace with TenantGuaranteeConfig after schema migration
    const maxGuarantees = 3;

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
      if (idempotencyKey && (err instanceof BadRequestException || err instanceof ConflictException)) {
        const idemKey = `loan:apply:${userId}:${memberId}:${dto.loanProductId}:${idempotencyKey}`;
        await this.idempotency.release(idemKey, tenantId);
      }
      throw err;
    }
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
      const txResult = await this.prisma.$transaction(async (tx) => {
        const member = await tx.member.findFirst({
          where: { id: memberId, tenantId, isActive: true },
          select: { id: true, memberNumber: true, kycStatus: true },
        });
        if (!member) {
          throw new NotFoundException('Member not found or inactive');
        }
        if (member.kycStatus !== 'APPROVED') {
          throw new BadRequestException('KYC verification required before applying for a loan');
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
          const equalShare = requiredCoverage.div(dto.guarantorIds.length).toDecimalPlaces(4, Decimal.ROUND_DOWN);
          guarantors = dto.guarantorIds.map((guarantorId, index) => {
            const guaranteedAmount = index === dto.guarantorIds!.length - 1
              ? requiredCoverage.minus(equalShare.times(dto.guarantorIds!.length - 1)).toDecimalPlaces(4)
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
          select: { accountType: true, balance: true, lockedBalance: true },
        });

        const fosaBalance = this.sumAvailableSavings(accounts, AccountType.FOSA);
        const bosaBalance = this.sumAvailableSavings(accounts, AccountType.BOSA);
        if (fosaBalance.plus(bosaBalance).equals(0)) {
          throw new BadRequestException('No active FOSA or BOSA account found');
        }

        const rules = this.resolveProductRules(product, fosaBalance, bosaBalance);
        if (rules.eligibleSavings.equals(0)) {
          throw new BadRequestException(
            `This product requires ${rules.requiredAccountLabel} savings, but none are available.`,
          );
        }

        if (guarantors.length < rules.minGuarantors) {
          throw new BadRequestException(
            `${product.name} requires minGuarantors=${rules.minGuarantors}; received ${guarantors.length}.`,
          );
        }
        if (rules.maxGuarantors > 0 && guarantors.length > rules.maxGuarantors) {
          throw new BadRequestException(
            `${product.name} allows at most ${rules.maxGuarantors} guarantor(s); received ${guarantors.length}.`,
          );
        }

        const maxLoanLimit = rules.eligibleSavings.times(rules.savingsMultiplier);
        if (principal.greaterThan(maxLoanLimit)) {
          throw new BadRequestException(
            `Loan amount exceeds your maximum eligible limit of KES ${maxLoanLimit.toFixed(2)} ` +
              `(${rules.savingsMultiplier.toFixed(2)}x ${rules.requiredAccountLabel} savings of KES ${rules.eligibleSavings.toFixed(2)})`,
          );
        }

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

        for (const item of guarantors) {
          const guarantorEligibility = await this.validateGuarantorEligibilityInTransaction(
            tx,
            item.memberId,
            'new-loan-application',
            tenantId,
            new Decimal(item.guaranteedAmount),
            memberId,
            guarantorAccountType,
          );
          if (!guarantorEligibility.eligible) {
            throw new BadRequestException(
              `GUARANTOR_NOT_ELIGIBLE: guarantor ${item.memberId} not eligible: ${guarantorEligibility.reason}`,
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
              select: { memberNumber: true, user: { select: { firstName: true, lastName: true } } },
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
                guaranteedAmount: new Decimal(item.guaranteedAmount).toDecimalPlaces(4).toString(),
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
              [createdLoan.member.user.firstName, createdLoan.member.user.lastName].filter(Boolean).join(' ') ||
              createdLoan.member.memberNumber,
          })),
        };
      });

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

      for (const guarantor of txResult.guarantorNotifications) {
        await this.guarantorExpiryQueue
          .add(
            'guarantor-expiry-check',
            { tenantId, loanId: txResult.loan.id, guarantorId: guarantor.guarantorId },
            { delay: 72 * 60 * 60 * 1000, attempts: 3, removeOnComplete: 1000, removeOnFail: false },
          )
          .catch((e: unknown) => this.logger.error('Failed to enqueue guarantor expiry', e));

        const guarantorMember = await this.prisma.member.findFirst({
          where: { id: guarantor.memberId, tenantId },
          select: { user: { select: { email: true, firstName: true } } },
        });

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
      }

      return txResult.loan;
    } catch (err) {
      if (
        err instanceof BadRequestException ||
        err instanceof NotFoundException ||
        err instanceof ConflictException
      ) {
        throw err;
      }
      this.logger.error(
        `Loan application transaction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  private sumAvailableSavings(
    accounts: Array<{
      accountType: AccountType;
      balance: { toString(): string };
      lockedBalance: { toString(): string } | null;
    }>,
    accountType?: AccountType,
  ): Decimal {
    return accounts
      .filter((account) => !accountType || account.accountType === accountType)
      .reduce((sum, account) => {
        const balance = new Decimal(account.balance.toString());
        const lockedBalance = new Decimal(account.lockedBalance?.toString() ?? '0');
        return sum.plus(balance.minus(lockedBalance));
      }, new Decimal(0));
  }

  private resolveProductRules(
    product: {
      requiredAccountType: AccountType | null;
      savingsMultiplier: { toString(): string } | null;
      minGuarantors: number;
      maxGuarantors: number;
    },
    fosaBalance: Decimal,
    bosaBalance: Decimal,
  ): {
    eligibleSavings: Decimal;
    savingsMultiplier: Decimal;
    requiredAccountLabel: string;
    minGuarantors: number;
    maxGuarantors: number;
  } {
    if (!ENABLE_PRODUCT_RULES_ENGINE) {
      return {
        eligibleSavings: fosaBalance.plus(bosaBalance),
        savingsMultiplier: new Decimal(3),
        requiredAccountLabel: 'combined FOSA+BOSA',
        minGuarantors: 0,
        maxGuarantors: Number.MAX_SAFE_INTEGER,
      };
    }

    const requiredAccountType = product.requiredAccountType;
    const eligibleSavings =
      requiredAccountType === AccountType.BOSA
        ? bosaBalance
        : requiredAccountType === AccountType.FOSA
          ? fosaBalance
          : fosaBalance.plus(bosaBalance);

    return {
      eligibleSavings,
      savingsMultiplier: new Decimal(product.savingsMultiplier?.toString() ?? '3'),
      requiredAccountLabel: requiredAccountType ?? 'combined FOSA+BOSA',
      minGuarantors: product.minGuarantors,
      maxGuarantors: product.maxGuarantors,
    };
  }

  private async validateGuarantorEligibilityInTransaction(
    tx: Prisma.TransactionClient,
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

    const guarantor = await tx.member.findFirst({
      where: { id: guarantorMemberId, tenantId, isActive: true },
      select: { id: true },
    });
    if (!guarantor) {
      return { eligible: false, reason: 'Guarantor not found or inactive' };
    }

    const fosaAccount = await tx.account.findFirst({
      where: { memberId: guarantorMemberId, tenantId, accountType, isActive: true },
      select: { id: true, balance: true, lockedBalance: true },
    });
    if (!fosaAccount) {
      return { eligible: false, reason: `Guarantor has no active ${accountType} account` };
    }

    const availableBalance = new Decimal(fosaAccount.balance.toString()).minus(
      new Decimal(fosaAccount.lockedBalance?.toString() ?? '0'),
    );
    if (availableBalance.lessThan(proposedAmount)) {
      return {
        eligible: false,
        reason: `Insufficient ${accountType} available balance: available KES ${availableBalance.toFixed(2)}, committing KES ${proposedAmount.toFixed(2)}`,
      };
    }

    const defaulted = await tx.loan.findFirst({
      where: { memberId: guarantorMemberId, tenantId, status: LoanStatus.DEFAULTED },
      select: { id: true },
    });
    if (defaulted) {
      return { eligible: false, reason: 'Guarantor has a defaulted loan' };
    }

    const activeGuarantees = await tx.loanGuarantor.count({
      where: {
        memberId: guarantorMemberId,
        tenantId,
        status: GuarantorStatus.ACCEPTED,
        loanId: { not: loanId },
        loan: {
          tenantId,
          status: { in: [LoanStatus.ACTIVE, LoanStatus.APPROVED, LoanStatus.DISBURSED] },
        },
      },
    });
    if (activeGuarantees >= 3) {
      return { eligible: false, reason: 'Guarantor has reached the maximum concurrent guarantee limit (3)' };
    }

    return { eligible: true };
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
   * Creates GuarantorRequest records with status PENDING_CONSENT and 72h expiry.
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
        member: { select: { user: { select: { firstName: true, lastName: true } } } },
      },
    });
    if (!loan) throw new NotFoundException('Loan not found');
    if (loan.status !== LoanStatus.DRAFT && loan.status !== LoanStatus.PENDING_GUARANTORS) {
      throw new BadRequestException(`Cannot add guarantors to a loan in "${loan.status}" status`);
    }

    const principal = new Decimal(loan.principalAmount.toString());
    // TODO: Replace with TenantGuaranteeConfig after schema migration
    const minCoverageRatio = new Decimal('1.00');
    const consentExpiryHours = 72;
    const minCoverageRequired = principal.times(minCoverageRatio);

    const results: Array<{
      memberId: string;
      guaranteedAmount: number;
      status: 'invited' | 'skipped';
      reason?: string;
    }> = [];

    for (const item of guarantors) {
      const eligibility = await this.validateGuarantorEligibility(
        item.memberId,
        loanId,
        tenantId,
        new Decimal(item.guaranteedAmount),
        loan.memberId,
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

      // Upsert GuarantorRequest (idempotent re-invite)
      await this.prisma.loanGuarantor.upsert({
        where: { loanId_memberId: { loanId, memberId: item.memberId } },
        create: {
          tenantId,
          loanId,
          memberId: item.memberId,
          guaranteedAmount: new Decimal(item.guaranteedAmount).toDecimalPlaces(4).toString(),
          status: GuarantorStatus.PENDING,
        },
        update: {
          guaranteedAmount: new Decimal(item.guaranteedAmount).toDecimalPlaces(4).toString(),
          status: GuarantorStatus.PENDING,
          respondedAt: null,
        },
      });

      results.push({ memberId: item.memberId, guaranteedAmount: item.guaranteedAmount, status: 'invited' });

      // Notify guarantor
      const guarantorMember = await this.prisma.member.findFirst({
        where: { id: item.memberId, tenantId },
        select: { user: { select: { email: true, firstName: true } } },
      });

      const borrowerName = [loan.member?.user?.firstName, loan.member?.user?.lastName]
        .filter(Boolean)
        .join(' ') || 'A fellow member';

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

      // Schedule reminder
      this.guarantorReminderQueue
        .add(
          'send-reminder',
          {
            loanId,
            guarantorId: item.memberId,
            tenantId,
            memberId: item.memberId,
            loanNumber: loan.loanNumber,
          },
          { delay: 24 * 60 * 60 * 1000, attempts: 2 },
        )
        .catch((e: unknown) => this.logger.error('Failed to enqueue guarantor reminder', e));
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

  // ─── GUARANTOR CONSENT RESPONSE ────────────────────────────────────────────

  /**
   * A guarantor member responds to their guarantee request.
   * Critical security requirements:
   *   1. Only the targeted guarantor (by JWT) can respond
   *   2. Must be within 72h expiry window
   *   3. Idempotency via Redis (guarantor:consent:{loanId}:{memberId})
   *   4. Digital acknowledgment required
   *   5. Immutable consent log created on every action
   */
  async guarantorResponse(
    loanId: string,
    guarantorMemberId: string,
    dto: GuarantorConsentResponseDto,
    tenantId: string,
    userId: string,
    req: Request,
    idempotencyHeader?: string,
  ) {
    const correlationId = (req.headers['x-request-id'] as string) ?? uuidv4();
    const headerKey = idempotencyHeader?.trim();
    if (!headerKey) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    const idemKey = `guarantor:response:${loanId}:${guarantorMemberId}:${headerKey}`;
    const idemCheck = await this.idempotency.checkAndReserve(idemKey, tenantId, 72 * 60 * 60);
    if (idemCheck.status === 'COMPLETED') {
      return idemCheck.result as { loanId: string; memberId: string; status: string };
    }
    if (idemCheck.status === 'PROCESSING') {
      throw new ConflictException('Your consent response is already being processed. Please wait.');
    }

    // 1. Consent spoofing prevention: only the targeted guarantor can respond
    const member = await this.prisma.member.findFirst({
      where: { id: guarantorMemberId, tenantId, isActive: true },
      select: { userId: true },
    });
    if (!member || member.userId !== userId) {
      throw new ForbiddenException('You are not authorized to respond to this guarantor request');
    }

    if (!dto.digitalAcknowledgment) {
      await this.idempotency.release(idemKey, tenantId);
      throw new BadRequestException('Digital acknowledgment is required to proceed. Please confirm explicitly.');
    }

    try {
      const txResult = await this.prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<
          Array<{
            id: string;
            status: GuarantorStatus;
            invitedAt: Date;
            guaranteedAmount: string;
          }>
        >`
          SELECT id, status, "invitedAt", "guaranteedAmount"
          FROM "Guarantor"
          WHERE "loanId" = ${loanId}
            AND "memberId" = ${guarantorMemberId}
            AND "tenantId" = ${tenantId}
          FOR UPDATE
        `;
        if (!locked) throw new NotFoundException('Guarantor request not found for this loan');
        if (locked.status !== GuarantorStatus.PENDING) {
          throw new ConflictException(`You have already ${locked.status.toLowerCase()} this guarantee request`);
        }

        const expiresAt = new Date(locked.invitedAt);
        expiresAt.setHours(expiresAt.getHours() + 72);
        const newStatus =
          new Date() > expiresAt
            ? GuarantorStatus.EXPIRED
            : dto.action === GuarantorConsentAction.ACCEPT
              ? GuarantorStatus.ACCEPTED
              : GuarantorStatus.REJECTED;

        const auditMetadata = {
          ipAddress: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          deviceId: (req.headers['x-device-id'] as string) ?? null,
          digitalAcknowledgment: dto.digitalAcknowledgment,
          correlationId,
          jurisdiction: 'KE',
          retentionYears: 7,
        };

        const updatedGuarantor = await tx.loanGuarantor.update({
          where: { id: locked.id },
          data: {
            status: newStatus,
            respondedAt: new Date(),
            notes: newStatus === GuarantorStatus.EXPIRED ? 'Consent window expired (72h)' : dto.notes,
            auditMetadata,
          },
        });

        const loanForGuarantor = await tx.loan.findFirst({
          where: { id: loanId, tenantId },
          select: {
            id: true,
            status: true,
            principalAmount: true,
            loanProduct: {
              select: {
                minGuarantors: true,
                guarantorCoverageRatio: true,
                requiredAccountType: true,
              },
            },
          },
        });
        if (!loanForGuarantor) {
          throw new NotFoundException('Loan not found');
        }

        if (newStatus === GuarantorStatus.REJECTED || newStatus === GuarantorStatus.EXPIRED) {
          const guarantorAccountType = this.guarantorValidation.resolveAccountType(loanForGuarantor.loanProduct);
          await this.guarantorValidation.releaseGuarantorHolds(
            tx,
            tenantId,
            [{ memberId: guarantorMemberId, guaranteedAmount: locked.guaranteedAmount }],
            guarantorAccountType,
          );
          await this.createAuditLogInTransaction(tx, {
            tenantId,
            actorId: userId,
            action: 'GUARANTOR.HOLD_RELEASED',
            entityType: 'LoanGuarantor',
            entityId: locked.id,
            oldValue: { status: locked.status },
            newValue: { status: newStatus },
            metadata: {
              loanId,
              guarantorMemberId,
              accountType: guarantorAccountType,
              guaranteedAmount: new Decimal(locked.guaranteedAmount).toNumber(),
              reason: newStatus,
              correlationId,
            },
            ipAddress: req.ip ?? null,
            userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
            requestId: `${correlationId}:hold-release:${locked.id}`,
          });
        }

        await this.createAuditLogInTransaction(tx, {
          tenantId,
          actorId: userId,
          action: 'GUARANTOR.RESPOND',
          entityType: 'Guarantor',
          entityId: locked.id,
          oldValue: { status: locked.status },
          newValue: { status: newStatus },
          metadata: { loanId, notes: dto.notes, auditMetadata },
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });

        if (newStatus === GuarantorStatus.ACCEPTED) {
          if (loanForGuarantor.status === LoanStatus.PENDING_GUARANTORS) {
            const accepted = await tx.loanGuarantor.findMany({
              where: { loanId, tenantId, status: GuarantorStatus.ACCEPTED },
              select: { guaranteedAmount: true },
            });
            const totalAccepted = accepted.reduce(
              (sum, g) => sum.plus(new Decimal(g.guaranteedAmount.toString())),
              new Decimal(0),
            );
            const principal = new Decimal(loanForGuarantor.principalAmount.toString());
            const requiredCoverage = principal
              .times(new Decimal(loanForGuarantor.loanProduct.guarantorCoverageRatio.toString()))
              .toDecimalPlaces(4);
            const acceptedCount = accepted.length;
            if (
              acceptedCount >= loanForGuarantor.loanProduct.minGuarantors &&
              totalAccepted.greaterThanOrEqualTo(requiredCoverage)
            ) {
              await tx.loan.updateMany({
                where: { id: loanId, tenantId },
                data: { status: LoanStatus.PENDING_REVIEW },
              });
              await this.createAuditLogInTransaction(tx, {
                tenantId,
                actorId: userId,
                action: 'LOAN.AUTO_ADVANCE_PENDING_REVIEW',
                entityType: 'Loan',
                entityId: loanId,
                oldValue: { status: loanForGuarantor.status },
                newValue: { status: LoanStatus.PENDING_REVIEW },
                metadata: {
                  acceptedCount,
                  minGuarantors: loanForGuarantor.loanProduct.minGuarantors,
                  totalAccepted: totalAccepted.toNumber(),
                  requiredCoverage: requiredCoverage.toNumber(),
                  correlationId,
                },
                ipAddress: req.ip ?? null,
                userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
              });
            }
          }
        }

        return {
          loanId,
          memberId: guarantorMemberId,
          status: newStatus,
          guarantorId: updatedGuarantor.id,
          guaranteedAmount: new Decimal(updatedGuarantor.guaranteedAmount.toString()).toNumber(),
        };
      });

      if (txResult.status === GuarantorStatus.EXPIRED) {
        await this.idempotency.complete(idemKey, tenantId, txResult, 72 * 60 * 60);
        throw new BadRequestException('Consent window has expired. Please request a new guarantor invitation.');
      }

      if (txResult.status === GuarantorStatus.ACCEPTED) {
        await this.publishEvent({
          type: 'GuarantorConsented',
          payload: {
            loanId,
            tenantId,
            guarantorMemberId,
            guaranteedAmount: txResult.guaranteedAmount,
            ipAddress: req.ip ?? undefined,
            userAgent: req.headers['user-agent'] ?? undefined,
            deviceId: (req.headers['x-device-id'] as string) ?? undefined,
            digitalAcknowledgment: dto.digitalAcknowledgment,
            correlationId,
          },
        });
      } else {
        await this.publishEvent({
          type: 'GuarantorDeclined',
          payload: {
            loanId,
            tenantId,
            guarantorMemberId,
            reason: dto.notes,
            correlationId,
          },
        });
      }

      await this.guarantorValidationQueue.add(
        'validate',
        {
          guarantorId: txResult.guarantorId,
          loanId,
          tenantId,
          memberId: guarantorMemberId,
          status: txResult.status,
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 1000,
          removeOnFail: false,
        },
      );

      const result = { loanId, memberId: guarantorMemberId, status: txResult.status };
      await this.idempotency.complete(idemKey, tenantId, result, 72 * 60 * 60);
      return result;
    } catch (err) {
      await this.idempotency.release(idemKey, tenantId);
      throw err;
    }
  }

  // ─── CONSENT LOG (IMMUTABLE) ───────────────────────────────────────────────

  private async createConsentLog(
    guarantorId: string,
    tenantId: string,
    memberId: string,
    action: string,
    req: Request,
    correlationId: string,
    digitalAck: boolean,
  ): Promise<void> {
    // Note: In the MVP we log via the AuditService with a specific action.
    // A full implementation would have a separate GuarantorConsentLog table.
    // For now, we create a detailed audit record that serves as the consent evidence.
    await this.audit.create({
      tenantId,
      actorId: memberId,
      action: `GUARANTOR.CONSENT.${action}`,
      entityType: 'GuarantorConsentLog',
      entityId: guarantorId,
      metadata: {
        action,
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        deviceId: (req.headers['x-device-id'] as string) ?? null,
        digitalAcknowledgment: digitalAck,
        correlationId,
        jurisdiction: 'KE',
        retentionYears: 7,
        timestamp: new Date().toISOString(),
      },
      ipAddress: req.ip ?? undefined,
      userAgent: req.headers['user-agent'] ?? undefined,
      requestId: correlationId,
    });
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
    const minCoverage = principal.times(new Decimal(loan.loanProduct.guarantorCoverageRatio.toString()));

    if (
      acceptedGuarantors.length >= loan.loanProduct.minGuarantors &&
      totalAccepted.greaterThanOrEqualTo(minCoverage)
    ) {
      await this.prisma.loan.updateMany({
        where: { id: loanId, tenantId },
        data: { status: LoanStatus.PENDING_REVIEW },
      });
      this.logger.log(
        `Loan ${loanId} advanced to PENDING_REVIEW — coverage ${totalAccepted.toNumber()} >= ${minCoverage.toNumber()}`,
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
    const allowedRoles = new Set<string>([UserRole.MANAGER, UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN]);
    if (!allowedRoles.has(actor.role)) {
      throw new ForbiddenException('Only managers and above can update loan status');
    }

    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, tenantId },
      select: {
        id: true,
        status: true,
        loanNumber: true,
        memberId: true,
        member: { select: { user: { select: { email: true, firstName: true } } } },
      },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    const oldStatus = loan.status;
    const correlationId = (req.headers['x-request-id'] as string) ?? uuidv4();
    const targetStatus = dto.status as unknown as LoanStatus;

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

    // Validate state transitions (workflow-only — no financial operations)
    const validTransitions: Record<string, string[]> = {
      [LoanStatus.DRAFT]: [LoanStatus.PENDING_GUARANTORS, LoanStatus.REJECTED],
      [LoanStatus.PENDING_GUARANTORS]: [LoanStatus.PENDING_REVIEW, LoanStatus.UNDER_REVIEW, LoanStatus.REJECTED, LoanStatus.REJECTED_GUARANTOR_DECLINE],
      [LoanStatus.PENDING_REVIEW]: [LoanStatus.APPROVED, LoanStatus.REJECTED],
      [LoanStatus.UNDER_REVIEW]: [LoanStatus.APPROVED, LoanStatus.REJECTED],
      [LoanStatus.PENDING_APPROVAL]: [LoanStatus.APPROVED, LoanStatus.REJECTED],
      // APPROVED → DISBURSED is intentionally absent: handled by LoansService.disburse()
    };

    const allowedNext = validTransitions[oldStatus] ?? [];
    if (!allowedNext.includes(targetStatus)) {
      throw new BadRequestException(
        `Cannot transition from "${oldStatus}" to "${dto.status}". Valid transitions: ${allowedNext.join(', ')}`,
      );
    }

    // Reason required for rejection
    if (targetStatus === LoanStatus.REJECTED && !dto.reason) {
      throw new BadRequestException('Reason is required when rejecting a loan');
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

    // Domain event
    await this.publishEvent({
      type: dto.status === 'APPROVED' ? 'LoanApproved' : dto.status === 'REJECTED' ? 'LoanRejected' : 'LoanDisbursed',
      payload: {
        loanId,
        tenantId,
        oldStatus,
        newStatus: dto.status,
        actorId: actor.id,
        reason: dto.reason,
        correlationId,
      },
    });

    // Notify member
    if (loan.member?.user?.email) {
      const emailType =
        targetStatus === LoanStatus.APPROVED
          ? 'LOAN_APPROVED'
          : targetStatus === LoanStatus.REJECTED
            ? 'LOAN_REJECTED'
            : null;
      if (emailType) {
        this.enqueueEmail(
          {
            type: emailType,
            to: loan.member.user.email,
            firstName: loan.member.user.firstName,
            loanNumber: loan.loanNumber,
            ...(targetStatus === LoanStatus.REJECTED && { reason: dto.reason }),
          } as EmailJobPayload,
          `loan.statusChange:${loanId}`,
        );
      }
    }

    return updated;
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

    // TODO: Replace with TenantGuaranteeConfig after schema migration
    const maxGuarantees = 3;

    const activeGuarantees = await this.prisma.loanGuarantor.findMany({
      where: {
        memberId,
        tenantId,
        status: GuarantorStatus.ACCEPTED,
        loan: { status: { in: [LoanStatus.ACTIVE, LoanStatus.APPROVED, LoanStatus.DISBURSED, LoanStatus.PENDING_GUARANTORS, LoanStatus.PENDING_REVIEW, LoanStatus.UNDER_REVIEW] } },
      },
      include: {
        loan: {
          select: {
            id: true,
            loanNumber: true,
            status: true,
            member: { select: { user: { select: { firstName: true, lastName: true } } } },
          },
        },
      },
    });

    const totalGuaranteedAmount = activeGuarantees.reduce(
      (sum, g) => sum.plus(new Decimal(g.guaranteedAmount.toString())),
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
