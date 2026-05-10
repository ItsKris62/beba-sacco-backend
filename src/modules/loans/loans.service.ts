import {
  Injectable, Logger, NotFoundException, BadRequestException,
  ConflictException, ForbiddenException, UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Decimal } from 'decimal.js';
import { AccountType, GuarantorStatus, LoanStatus, Prisma, TransactionType, TransactionStatus, InterestType } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RedisService } from '../../common/services/redis.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { CreateLoanProductDto } from './dto/create-loan-product.dto';
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
    private readonly idempotency: IdempotencyService,
    @InjectQueue(QUEUE_NAMES.LOAN_GUARANTOR_REMINDER)
    private readonly guarantorReminderQueue: Queue<GuarantorReminderJobPayload>,
    @InjectQueue(QUEUE_NAMES.EMAIL)
    private readonly emailQueue: Queue<EmailJobPayload>,
    private readonly disbursementGate: DisbursementGateService,
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
        removeOnFail: false,
      })
      .catch((e: unknown) =>
        this.logger.error(
          `[EmailQueue] enqueue failed [${ctx}]: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
  }

  // ─── LOAN PRODUCTS ───────────────────────────────────────────

  async createProduct(dto: CreateLoanProductDto, tenantId: string, createdBy: string, ipAddress?: string) {
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
        maxGuarantors: dto.maxGuarantors ?? 5,
        guarantorCoverageRatio: new Decimal(dto.guarantorCoverageRatio ?? 1).toDecimalPlaces(4).toString(),
        requiresPayslip: dto.requiresPayslip ?? false,
        minActiveMonths: dto.minActiveMonths ?? 0,
        gracePeriodMonths: dto.gracePeriodMonths ?? 0,
      },
    });

    await this.audit.create({
      tenantId,
      userId: createdBy,
      action: 'LOAN_PRODUCT.CREATE',
      resource: 'LoanProduct',
      resourceId: product.id,
      metadata: { name: product.name },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    return product;
  }

  async findAllProducts(tenantId: string, includeInactive = false) {
    const cacheKey = `loan:products:${tenantId}:${includeInactive}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch { /* fallthrough */ }
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

  // ─── LOAN APPLICATION ────────────────────────────────────────

  async apply(
    dto: ApplyLoanDto,
    tenantId: string,
    appliedBy: string,
    ipAddress?: string,
    idempotencyKey?: string,
  ) {
    // Phase 2: Idempotency guard — prevent duplicate loan applications
    if (idempotencyKey) {
      const idemKey = `loan:apply:${appliedBy}:${dto.memberId}:${dto.loanProductId}:${idempotencyKey}`;
      const check = await this.idempotency.checkAndReserve(idemKey, tenantId, 24 * 60 * 60);
      if (check.status === 'COMPLETED') {
        this.logger.log(`Idempotency cache hit for loan apply: ${idemKey}`);
        return check.result as Awaited<ReturnType<LoansService['_doApply']>>;
      }
      if (check.status === 'PROCESSING') {
        throw new ConflictException('Loan application is already being processed. Please wait.');
      }
    }

    try {
      const result = await this._doApply(dto, tenantId, appliedBy, ipAddress);
      if (idempotencyKey) {
        const idemKey = `loan:apply:${appliedBy}:${dto.memberId}:${dto.loanProductId}:${idempotencyKey}`;
        await this.idempotency.complete(idemKey, tenantId, result, 24 * 60 * 60);
      }
      return result;
    } catch (err) {
      // Only release on validation errors (deterministic). Don't release on transient DB errors.
      if (idempotencyKey && (err instanceof BadRequestException || err instanceof ConflictException)) {
        const idemKey = `loan:apply:${appliedBy}:${dto.memberId}:${dto.loanProductId}:${idempotencyKey}`;
        await this.idempotency.release(idemKey, tenantId);
      }
      throw err;
    }
  }

  private async _doApply(dto: ApplyLoanDto, tenantId: string, appliedBy: string, ipAddress?: string) {
    const member = await this.prisma.member.findFirst({
      where: { id: dto.memberId, tenantId, isActive: true },
      select: { id: true, memberNumber: true, kycStatus: true },
    });
    if (!member) throw new NotFoundException('Active member not found in this tenant');

    // KYC must be verified before loan application
    if (member.kycStatus !== 'APPROVED') {
      throw new BadRequestException(
        'KYC verification is required before applying for a loan. Please complete your KYC.',
      );
    }

    const product = await this.prisma.loanProduct.findFirst({
      where: { id: dto.loanProductId, tenantId, isActive: true },
    });
    if (!product) throw new NotFoundException('Loan product not found or inactive');

    const principal = new Decimal(dto.principalAmount);
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

    // Max loan limit: 3× BOSA balance + 1.5× FOSA balance
    const accounts = await this.prisma.account.findMany({
      where: { memberId: dto.memberId, tenantId, isActive: true },
      select: { balance: true, accountType: true },
    });
    
    let maxLoanLimit = new Decimal(0);
    for (const acc of accounts) {
      const bal = new Decimal(acc.balance.toString());
      if (acc.accountType === 'BOSA') {
        maxLoanLimit = maxLoanLimit.plus(bal.times(3));
      } else if (acc.accountType === 'FOSA') {
        maxLoanLimit = maxLoanLimit.plus(bal.times(1.5));
      }
    }

    if (principal.greaterThan(maxLoanLimit)) {
      throw new BadRequestException(
        `Loan amount exceeds your maximum eligible limit of KES ${maxLoanLimit.toFixed(2)} ` +
          `(3× your BOSA + 1.5× your FOSA balance)`,
      );
    }

    // Calculate processing fee and instalment
    const annualRate = new Decimal(product.interestRate.toString());
    const processingFeeRate = new Decimal(product.processingFeeRate.toString());
    const processingFee = principal.times(processingFeeRate).toDecimalPlaces(4);
    const monthlyInstalment = this.calculateInstalment(
      principal,
      annualRate,
      dto.tenureMonths,
      product.interestType,
    );

    // Auto-generate loan number: LN-YYYY-000001
    // Counter upsert and loan create are wrapped in a single transaction so a
    // failed loan.create() does not leave an orphaned incremented counter.
    const year = new Date().getFullYear();
    const loan = await this.prisma.$transaction(async (tx) => {
      const counter = await tx.tenantCounter.upsert({
        where: { tenantId },
        create: { tenantId, loanSeq: 1 },
        update: { loanSeq: { increment: 1 } },
      });
      const loanNumber = `LN-${year}-${String(counter.loanSeq).padStart(6, '0')}`;

      return tx.loan.create({
        data: {
          tenantId,
          memberId: dto.memberId,
          loanProductId: dto.loanProductId,
          loanNumber,
          status: LoanStatus.DRAFT,
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
          member: { select: { memberNumber: true, user: { select: { firstName: true, lastName: true } } } },
          loanProduct: { select: { name: true, interestType: true } },
        },
      });
    });
    const loanNumber = loan.loanNumber;

    await this.audit.create({
      tenantId,
      userId: appliedBy,
      action: 'LOAN.APPLY',
      resource: 'Loan',
      resourceId: loan.id,
      metadata: {
        loanNumber,
        memberId: dto.memberId,
        principalAmount: principal.toNumber(),
        tenureMonths: dto.tenureMonths,
        monthlyInstalment: monthlyInstalment.toNumber(),
      },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    return loan;
  }

  // ─── LIST LOANS ───────────────────────────────────────────────

  async findAll(
    tenantId: string,
    opts: { memberId?: string; status?: LoanStatus; page?: number; limit?: number } = {},
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const skip = (page - 1) * limit;

    const where = {
      tenantId,
      ...(opts.memberId && { memberId: opts.memberId }),
      ...(opts.status && { status: opts.status }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.loan.findMany({
        where,
        include: {
          member: { select: { memberNumber: true, user: { select: { firstName: true, lastName: true } } } },
          loanProduct: { select: { name: true } },
        },
        skip,
        take: limit,
        orderBy: { appliedAt: 'desc' },
      }),
      this.prisma.loan.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // ─── FIND ONE ─────────────────────────────────────────────────

  async findOne(id: string, tenantId: string) {
    const loan = await this.prisma.loan.findFirst({
      where: { id, tenantId },
      include: {
        member: { select: { memberNumber: true, user: { select: { firstName: true, lastName: true, email: true } } } },
        loanProduct: true,
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });
    if (!loan) throw new NotFoundException('Loan not found');
    return loan;
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
  async approve(id: string, tenantId: string, approvedBy: string, comment?: string, ipAddress?: string) {
    const loan = await this.prisma.loan.findFirst({
      where: { id, tenantId },
      select: {
        id: true, status: true, loanNumber: true, memberId: true,
        principalAmount: true, monthlyInstalment: true, tenureMonths: true,
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

    const updated = await this.prisma.loan.update({
      where: { id },
      data: {
        status: LoanStatus.APPROVED,
        approvedAt: new Date(),
        approvedBy,
        ...(comment && { notes: comment }),
      },
    });

    await this.audit.create({
      tenantId,
      userId: approvedBy,
      action: 'LOAN.APPROVE',
      resource: 'Loan',
      resourceId: id,
      metadata: { loanNumber: loan.loanNumber, memberId: loan.memberId, comment },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    // Notify member of approval
    const memberUser = loan.member?.user;
    if (memberUser?.email) {
      this.enqueueEmail({
        type: 'LOAN_APPROVED',
        to: memberUser.email,
        firstName: memberUser.firstName,
        loanNumber: loan.loanNumber,
        principalAmount: new Decimal(loan.principalAmount.toString()).toNumber(),
        monthlyInstalment: new Decimal(loan.monthlyInstalment?.toString() ?? '0').toNumber(),
        tenureMonths: loan.tenureMonths,
      }, `loan.approve:${id}`);
    }

    return updated;
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
  async disburse(id: string, tenantId: string, disbursedBy: string, ipAddress?: string) {
    const loan = await this.prisma.loan.findFirst({
      where: { id, tenantId },
      select: {
        id: true, status: true, loanNumber: true,
        principalAmount: true, memberId: true, tenureMonths: true,
        gracePeriodMonths: true, monthlyInstalment: true,
        repaymentScheduleGenerated: true,
        member: { select: { user: { select: { email: true, firstName: true } } } },
      },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    // 409 for idempotent retry: if the loan is already ACTIVE it was successfully
    // disbursed by an earlier request. Clients can safely treat 409 as a success
    // indicator and proceed to fetch the loan details.
    if (loan.status === LoanStatus.ACTIVE) {
      throw new ConflictException(
        `Loan ${loan.loanNumber} has already been disbursed and is ACTIVE. ` +
        'Retrieve the current loan details for the disbursement record.',
      );
    }
    if (loan.status !== LoanStatus.APPROVED) {
      throw new BadRequestException(
        `Cannot disburse a loan in "${loan.status}" status. Expected APPROVED.`,
      );
    }

    // Verify member KYC is approved before disbursement
    const member = await this.prisma.member.findFirst({
      where: { id: loan.memberId, tenantId },
      select: { kycStatus: true },
    });
    if (member?.kycStatus !== 'APPROVED') {
      throw new BadRequestException(
        'KYC must be approved before loan disbursement.',
      );
    }

    // Locate the member's FOSA account for disbursement
    const fosaAccount = await this.prisma.account.findFirst({
      where: { memberId: loan.memberId, tenantId, accountType: 'FOSA', isActive: true },
      select: { id: true, balance: true, version: true },
    });
    if (!fosaAccount) {
      throw new BadRequestException(
        'Member has no active FOSA account. Please open a FOSA account before disbursing.',
      );
    }

    const principal = new Decimal(loan.principalAmount.toString());
    const reference = `DISB-${uuidv4()}`;

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
            tenureMonths: number;
            gracePeriodMonths: number | null;
            monthlyInstalment: string;
            repaymentScheduleGenerated: boolean;
          }>
        >`
          SELECT id, status, "principalAmount", "tenureMonths", "gracePeriodMonths",
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

        // Lock account row with FOR UPDATE via raw query to get current balance + version
        const lockedRows = await tx.$queryRaw`
          SELECT id, balance, version FROM "Account"
          WHERE id = ${fosaAccount.id} AND "tenantId" = ${tenantId}
          FOR UPDATE
        `;
        const account = Array.isArray(lockedRows)
          ? (lockedRows[0] as { id: string; balance: string; version: number } | undefined)
          : undefined;
        if (!account) throw new NotFoundException('FOSA account not found or inactive');

        // Optimistic locking: ensure version hasn't changed since we read it
        if (account.version !== fosaAccount.version) {
          throw new ConflictException('Account was modified by another transaction. Please retry.');
        }

        // Duplicate reference guard
        const dupRef = await tx.transaction.findUnique({ where: { reference } });
        if (dupRef) throw new ConflictException(`Reference ${reference} already posted`);

        const balanceBefore = new Decimal(account.balance.toString());
        const balanceAfter = balanceBefore.plus(txPrincipal);
        const newVersion = account.version + 1;

        const txn = await tx.transaction.create({
          data: {
            tenantId,
            accountId: fosaAccount.id,
            loanId: id,
            type: TransactionType.LOAN_DISBURSEMENT,
            status: TransactionStatus.COMPLETED,
            amount: txPrincipal.toDecimalPlaces(4).toString(),
            balanceBefore: balanceBefore.toDecimalPlaces(4).toString(),
            balanceAfter: balanceAfter.toDecimalPlaces(4).toString(),
            reference,
            description: `Loan disbursement – ${loan.loanNumber}`,
            processedBy: disbursedBy,
          },
        });

        // Update balance AND version atomically
        await tx.account.update({
          where: { id: fosaAccount.id, version: account.version },
          data: {
            balance: balanceAfter.toDecimalPlaces(4).toString(),
            version: newVersion,
          },
        });

        const disbursedAt = new Date();
        // dueDate = disbursement + grace period + repayment tenure
        const dueDate = new Date(disbursedAt);
        dueDate.setMonth(dueDate.getMonth() + (lockedLoan.gracePeriodMonths ?? 0) + lockedLoan.tenureMonths);

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
              fosaAccountId: fosaAccount.id,
              reference,
              gracePeriodMonths: lockedLoan.gracePeriodMonths ?? 0,
              disbursedAt,
              dueDate,
            },
            ipAddress: ipAddress ?? null,
          },
        });

        return {
          loan: updatedLoan,
          transaction: txn,
          newBalance: balanceAfter.toNumber(),
          dueDate,
          disbursement_status: 'COMPLETED' as const,
          estimated_settlement: disbursedAt.toISOString(),
        };
      },
      { isolationLevel: 'Serializable' as const },
    );

    // Notify member of disbursement (after transaction commits)
    const memberUser = loan.member?.user;
    if (memberUser?.email) {
      this.enqueueEmail({
        type: 'LOAN_DISBURSED',
        to: memberUser.email,
        firstName: memberUser.firstName,
        loanNumber: loan.loanNumber,
        principalAmount: new Decimal(loan.principalAmount.toString()).toNumber(),
        monthlyInstalment: new Decimal(loan.monthlyInstalment?.toString() ?? '0').toNumber(),
        dueDate: disbursalResult.dueDate.toISOString().split('T')[0],
        accountNumber: fosaAccount.id,
      }, `loan.disburse:${id}`);
    }

    return disbursalResult;
  }

  // ─── REJECT ──────────────────────────────────────────────────

  async reject(id: string, dto: RejectLoanDto, tenantId: string, rejectedBy: string, ipAddress?: string) {
    const loan = await this.prisma.loan.findFirst({
      where: { id, tenantId },
      select: {
        id: true, status: true, loanNumber: true, memberId: true,
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
      throw new BadRequestException(
        `Cannot reject a loan in "${loan.status}" status`,
      );
    }

    const txClient = this.prisma.direct ?? this.prisma;
    const updated = await txClient.$transaction(async (tx) => {
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
      const releasedHolds: Array<{ guarantorId: string; memberId: string; releasedAmount: string }> = [];

      for (const guarantor of acceptedGuarantors) {
        const accounts = await tx.$queryRaw<Array<{ id: string; lockedBalance: string }>>`
          SELECT id, "lockedBalance"
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
          new Decimal(account.lockedBalance.toString()),
          new Decimal(guarantor.guaranteedAmount.toString()),
        ).toDecimalPlaces(4);
        if (releaseAmount.lessThanOrEqualTo(0)) continue;

        await tx.account.updateMany({
          where: { id: account.id, tenantId, isActive: true },
          data: { lockedBalance: { decrement: releaseAmount.toString() }, version: { increment: 1 } },
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

      const timestamp = new Date();
      const prev = await tx.auditLog.findFirst({
        where: { tenantId },
        orderBy: { timestamp: 'desc' },
        select: { entryHash: true },
      });
      const payload = {
        loanNumber: loan.loanNumber,
        reason: dto.reason,
        releasedHolds,
        oldStatus: lockedLoan.status,
        newStatus: LoanStatus.REJECTED,
      };
      const prevHash = prev?.entryHash ?? null;
      const entryHash = createHash('sha256')
        .update(JSON.stringify({ tenantId, actorId: rejectedBy, action: 'LOAN.REJECT', entityType: 'Loan', entityId: id, payload, prevHash, timestamp: timestamp.toISOString() }), 'utf8')
        .digest('hex');

      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: rejectedBy,
          action: 'LOAN.REJECT',
          entityType: 'Loan',
          entityId: id,
          oldValue: { status: lockedLoan.status },
          newValue: { status: LoanStatus.REJECTED },
          metadata: { ...payload, ipAddress },
          payload,
          ipAddress,
          prevHash,
          entryHash,
          timestamp,
        },
      });

      return rejectedLoan;
    }, { isolationLevel: 'Serializable' as const });

    // Notify member of rejection
    const rejectMemberUser = loan.member?.user;
    if (rejectMemberUser?.email) {
      this.enqueueEmail({
        type: 'LOAN_REJECTED',
        to: rejectMemberUser.email,
        firstName: rejectMemberUser.firstName,
        loanNumber: loan.loanNumber,
        reason: dto.reason,
      }, `loan.reject:${id}`);
    }

    return updated;
  }

  // ─── GUARANTORS ──────────────────────────────────────────────

  /**
   * Invite guarantors for a DRAFT loan.
   * Validates each guarantor's eligibility and records PENDING guarantor rows.
   * Loan status moves to PENDING_GUARANTORS.
   *
   * Eligibility rules:
   *   - Must be an active member in the same tenant
   *   - Must have an active FOSA account
   *   - Must not have any ACTIVE defaulted loans
   *   - Must not already be guaranteeing this loan
   */
  async inviteGuarantors(
    loanId: string,
    dto: InviteGuarantorsDto,
    tenantId: string,
    invitedBy: string,
    ipAddress?: string,
  ) {
    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, tenantId },
      select: {
        id: true, status: true, loanNumber: true, memberId: true, principalAmount: true,
        member: { select: { user: { select: { firstName: true, lastName: true } } } },
      },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    if (loan.status !== LoanStatus.DRAFT && loan.status !== LoanStatus.PENDING_GUARANTORS) {
      throw new BadRequestException(
        `Cannot add guarantors to a loan in "${loan.status}" status`,
      );
    }

    const principal = new Decimal(loan.principalAmount.toString());
    const MIN_COVERAGE_RATIO = new Decimal('1.00'); // 100%
    const minCoverageRequired = principal.times(MIN_COVERAGE_RATIO);

    const results: Array<{
      memberId: string;
      guaranteedAmount: number;
      status: 'invited' | 'skipped';
      reason?: string;
    }> = [];

    for (const item of dto.guarantors) {
      // Cannot guarantee own loan
      if (item.memberId === loan.memberId) {
        results.push({ memberId: item.memberId, guaranteedAmount: item.guaranteedAmount, status: 'skipped', reason: 'Member cannot guarantee their own loan' });
        continue;
      }

      const guarantorMember = await this.prisma.member.findFirst({
        where: { id: item.memberId, tenantId, isActive: true },
        select: { id: true, user: { select: { email: true, firstName: true } } },
      });
      if (!guarantorMember) {
        results.push({ memberId: item.memberId, guaranteedAmount: item.guaranteedAmount, status: 'skipped', reason: 'LoanGuarantor not found or inactive' });
        continue;
      }

      const fosaAccount = await this.prisma.account.findFirst({
        where: { memberId: item.memberId, tenantId, accountType: 'FOSA', isActive: true },
        select: { id: true, balance: true },
      });
      if (!fosaAccount) {
        results.push({ memberId: item.memberId, guaranteedAmount: item.guaranteedAmount, status: 'skipped', reason: 'LoanGuarantor has no active FOSA account' });
        continue;
      }

      // LoanGuarantor's FOSA balance must cover their committed guaranteed amount.
      // This protects the SACCO from guarantors who pledge more than they hold.
      const fosaBalance = new Decimal(fosaAccount.balance.toString());
      const committedAmount = new Decimal(item.guaranteedAmount);
      if (fosaBalance.lessThan(committedAmount)) {
        results.push({
          memberId: item.memberId,
          guaranteedAmount: item.guaranteedAmount,
          status: 'skipped',
          reason: `Insufficient FOSA balance: holds KES ${fosaBalance.toFixed(2)}, committing KES ${committedAmount.toFixed(2)}`,
        });
        continue;
      }

      const defaultedLoan = await this.prisma.loan.findFirst({
        where: { memberId: item.memberId, tenantId, status: LoanStatus.DEFAULTED },
        select: { id: true },
      });
      if (defaultedLoan) {
        results.push({ memberId: item.memberId, guaranteedAmount: item.guaranteedAmount, status: 'skipped', reason: 'LoanGuarantor has a defaulted loan' });
        continue;
      }

      // Upsert guarantor (idempotent re-invite)
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

      // Notify guarantor by email
      const borrowerName = [
        loan.member?.user?.firstName,
        loan.member?.user?.lastName,
      ].filter(Boolean).join(' ') || 'A fellow member';

      if (guarantorMember.user?.email) {
        this.enqueueEmail({
          type: 'GUARANTOR_INVITE',
          to: guarantorMember.user.email,
          firstName: guarantorMember.user.firstName,
          borrowerName,
          loanNumber: loan.loanNumber,
          guaranteedAmount: item.guaranteedAmount,
          loanPrincipal: principal.toNumber(),
        }, `loan.inviteGuarantor:${loanId}:${item.memberId}`);
      }

      // Enqueue a 24-hour reminder for this guarantor
      this.guarantorReminderQueue.add(
        'send-reminder',
        {
          loanId,
          guarantorId: item.memberId,
          tenantId,
          memberId: item.memberId,
          loanNumber: loan.loanNumber,
        },
        { delay: 24 * 60 * 60 * 1000, attempts: 2 },
      ).catch((e: unknown) => this.logger.error('Failed to enqueue guarantor reminder', e));
    }

    // Update loan status to PENDING_GUARANTORS
    await this.prisma.loan.update({
      where: { id: loanId },
      data: { status: LoanStatus.PENDING_GUARANTORS },
    });

    const invitedCount = results.filter((r) => r.status === 'invited').length;
    const totalGuaranteed = results
      .filter((r) => r.status === 'invited')
      .reduce((sum, r) => sum.plus(r.guaranteedAmount), new Decimal(0));

    await this.audit.create({
      tenantId,
      userId: invitedBy,
      action: 'LOAN.GUARANTORS_INVITED',
      resource: 'Loan',
      resourceId: loanId,
      metadata: {
        loanNumber: loan.loanNumber,
        invitedCount,
        totalGuaranteed: totalGuaranteed.toNumber(),
        minCoverageRequired: minCoverageRequired.toNumber(),
      },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    return {
      loanId,
      invitedCount,
      totalGuaranteedAmount: totalGuaranteed.toNumber(),
      minimumCoverageRequired: minCoverageRequired.toNumber(),
      coverageMet: totalGuaranteed.greaterThanOrEqualTo(minCoverageRequired),
      results,
    };
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
    });
    if (!guarantor) throw new NotFoundException('LoanGuarantor record not found for this loan');

    if (guarantor.status !== GuarantorStatus.PENDING) {
      throw new BadRequestException(
        `You have already ${guarantor.status.toLowerCase()} this guarantee request`,
      );
    }

    const newStatus = dto.action === GuarantorAction.ACCEPT
      ? GuarantorStatus.ACCEPTED
      : GuarantorStatus.REJECTED;

    await this.prisma.loanGuarantor.update({
      where: { id: guarantor.id },
      data: { status: newStatus, respondedAt: new Date(), notes: dto.notes },
    });

    await this.audit.create({
      tenantId,
      userId: memberId,
      action: `LOAN.GUARANTOR_${newStatus}`,
      resource: 'LoanGuarantor',
      resourceId: guarantor.id,
      metadata: { loanId, notes: dto.notes },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

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
        data: { status: LoanStatus.PENDING_REVIEW },
      });
      this.logger.log(`Loan ${loanId} advanced to PENDING_REVIEW — coverage ${totalAccepted.toNumber()} ≥ ${minCoverage.toNumber()}`);
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

    const repayResult = await txClient.$transaction(
      async (tx) => {
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
          tx.$queryRaw<{ id: string; outstandingBalance: string; status: string; accruedInterest: string; arrearsAmount: string }[]>`
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
        const reference = `REPAY-${uuidv4()}`;

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

        await this.audit.create({
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
        }).catch((e: unknown) => this.logger.error('Audit write failed', e));

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
    for (const guarantor of loan.guarantors) {
      const account = await tx.account.findFirst({
        where: { tenantId, memberId: guarantor.memberId, accountType, isActive: true },
        select: { id: true, lockedBalance: true },
      });
      if (!account) continue;

      const releaseAmount = Decimal.min(
        new Decimal(account.lockedBalance.toString()),
        new Decimal(guarantor.guaranteedAmount.toString()),
      ).toDecimalPlaces(4);
      if (releaseAmount.lessThanOrEqualTo(0)) continue;

      await tx.account.updateMany({
        where: { id: account.id, tenantId, isActive: true },
        data: { lockedBalance: { decrement: releaseAmount.toString() }, version: { increment: 1 } },
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
      const auditPayload = { loanId, guarantorMemberId: guarantor.memberId, releasedAmount: releaseAmount.toString(), reason: 'LOAN_FULLY_PAID' };
      const prevHash = prevAudit?.entryHash ?? null;
      const entryHash = createHash('sha256')
        .update(JSON.stringify({ tenantId, actorId, action: 'GUARANTOR.HOLD_RELEASED_LOAN_REPAID', entityType: 'LoanGuarantor', entityId: guarantor.id, payload: auditPayload, prevHash, timestamp: auditTimestamp }), 'utf8')
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
