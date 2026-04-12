import {
  Injectable, Logger, NotFoundException, BadRequestException,
  ConflictException, ForbiddenException,
} from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { LoanStatus, TransactionType, TransactionStatus, InterestType } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateLoanProductDto } from './dto/create-loan-product.dto';
import { ApplyLoanDto } from './dto/apply-loan.dto';

/**
 * Loans Service
 *
 * Instalment calculation:
 *  FLAT:             instalment = P * (1 + r_annual * n/12) / n
 *  REDUCING_BALANCE: instalment = P * r_monthly * (1+r_monthly)^n / ((1+r_monthly)^n - 1)
 *
 * All monetary arithmetic uses Decimal — never native number.
 *
 * Loan lifecycle:
 *   DRAFT → PENDING_APPROVAL → APPROVED → DISBURSED → ACTIVE → FULLY_PAID | DEFAULTED
 */
@Injectable()
export class LoansService {
  private readonly logger = new Logger(LoansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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
    return this.prisma.loanProduct.findMany({
      where: { tenantId, ...(!includeInactive && { isActive: true }) },
      orderBy: { name: 'asc' },
    });
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

  async apply(dto: ApplyLoanDto, tenantId: string, appliedBy: string, ipAddress?: string) {
    const member = await this.prisma.member.findFirst({
      where: { id: dto.memberId, tenantId, isActive: true },
      select: { id: true, memberNumber: true },
    });
    if (!member) throw new NotFoundException('Active member not found in this tenant');

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
    const year = new Date().getFullYear();
    const counter = await this.prisma.tenantCounter.upsert({
      where: { tenantId },
      create: { tenantId, loanSeq: 1 },
      update: { loanSeq: { increment: 1 } },
    });
    const loanNumber = `LN-${year}-${String(counter.loanSeq).padStart(6, '0')}`;

    const loan = await this.prisma.loan.create({
      data: {
        tenantId,
        memberId: dto.memberId,
        loanProductId: dto.loanProductId,
        loanNumber,
        status: LoanStatus.PENDING_APPROVAL,
        principalAmount: principal.toDecimalPlaces(4).toString(),
        interestRate: annualRate.toDecimalPlaces(4).toString(),
        processingFee: processingFee.toString(),
        tenureMonths: dto.tenureMonths,
        monthlyInstalment: monthlyInstalment.toDecimalPlaces(4).toString(),
        outstandingBalance: principal.toDecimalPlaces(4).toString(),
        notes: dto.notes,
      },
      include: {
        member: { select: { memberNumber: true, user: { select: { firstName: true, lastName: true } } } },
        loanProduct: { select: { name: true, interestType: true } },
      },
    });

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

  async approve(id: string, tenantId: string, approvedBy: string, ipAddress?: string) {
    const loan = await this.prisma.loan.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true, loanNumber: true, memberId: true },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    if (loan.status !== LoanStatus.PENDING_APPROVAL) {
      throw new BadRequestException(
        `Cannot approve a loan in "${loan.status}" status. Expected PENDING_APPROVAL.`,
      );
    }

    const updated = await this.prisma.loan.update({
      where: { id },
      data: {
        status: LoanStatus.APPROVED,
        approvedAt: new Date(),
        approvedBy,
      },
    });

    await this.audit.create({
      tenantId,
      userId: approvedBy,
      action: 'LOAN.APPROVE',
      resource: 'Loan',
      resourceId: id,
      metadata: { loanNumber: loan.loanNumber, memberId: loan.memberId },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    return updated;
  }

  // ─── DISBURSE ────────────────────────────────────────────────

  /**
   * Disburse a loan: credit the member's FOSA account and mark loan as DISBURSED/ACTIVE.
   * Uses a Prisma interactive transaction for atomicity.
   */
  async disburse(id: string, tenantId: string, disbursedBy: string, ipAddress?: string) {
    const loan = await this.prisma.loan.findFirst({
      where: { id, tenantId },
      select: {
        id: true, status: true, loanNumber: true,
        principalAmount: true, memberId: true, tenureMonths: true,
      },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    if (loan.status !== LoanStatus.APPROVED) {
      throw new BadRequestException(
        `Cannot disburse a loan in "${loan.status}" status. Expected APPROVED.`,
      );
    }

    // Locate the member's FOSA account for disbursement
    const fosaAccount = await this.prisma.account.findFirst({
      where: { memberId: loan.memberId, tenantId, accountType: 'FOSA', isActive: true },
      select: { id: true, balance: true },
    });
    if (!fosaAccount) {
      throw new BadRequestException(
        'Member has no active FOSA account. Please open a FOSA account before disbursing.',
      );
    }

    const principal = new Decimal(loan.principalAmount.toString());
    const reference = `DISB-${uuidv4()}`;

    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.findFirst({
        where: { id: fosaAccount.id, isActive: true },
      });
      if (!account) throw new NotFoundException('FOSA account not found or inactive');

      // Duplicate reference guard
      const dupRef = await tx.transaction.findUnique({ where: { reference } });
      if (dupRef) throw new ConflictException(`Reference ${reference} already posted`);

      const balanceBefore = new Decimal(account.balance.toString());
      const balanceAfter = balanceBefore.plus(principal);

      const txn = await tx.transaction.create({
        data: {
          tenantId,
          accountId: fosaAccount.id,
          loanId: id,
          type: TransactionType.LOAN_DISBURSEMENT,
          status: TransactionStatus.COMPLETED,
          amount: principal.toDecimalPlaces(4).toString(),
          balanceBefore: balanceBefore.toDecimalPlaces(4).toString(),
          balanceAfter: balanceAfter.toDecimalPlaces(4).toString(),
          reference,
          description: `Loan disbursement – ${loan.loanNumber}`,
          processedBy: disbursedBy,
        },
      });

      await tx.account.update({
        where: { id: fosaAccount.id },
        data: { balance: balanceAfter.toDecimalPlaces(4).toString() },
      });

      const dueDate = new Date();
      dueDate.setMonth(dueDate.getMonth() + loan.tenureMonths);

      const updatedLoan = await tx.loan.update({
        where: { id },
        data: {
          status: LoanStatus.ACTIVE,
          disbursedAt: new Date(),
          disbursedBy,
          dueDate,
        },
      });

      await this.audit.create({
        tenantId,
        userId: disbursedBy,
        action: 'LOAN.DISBURSE',
        resource: 'Loan',
        resourceId: id,
        metadata: {
          loanNumber: loan.loanNumber,
          principalAmount: principal.toNumber(),
          fosaAccountId: fosaAccount.id,
          reference,
          dueDate,
        },
        ipAddress,
      }).catch((e: unknown) => this.logger.error('Audit write failed', e));

      return { loan: updatedLoan, transaction: txn, newBalance: balanceAfter.toNumber() };
    });
  }

  // ─── HELPERS ─────────────────────────────────────────────────

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
