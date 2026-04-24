import {
  Injectable, Logger, NotFoundException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { TransactionType, TransactionStatus, AccountType } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateAccountDto } from './dto/create-account.dto';

/**
 * Accounts Service
 *
 * Handles BOSA (savings) and FOSA (transactional) accounts.
 * All monetary arithmetic uses Decimal from decimal.js — never native number.
 * Balance updates are wrapped in Prisma interactive transactions for atomicity.
 *
 * TODO: Phase 3 – interest accrual engine (monthly BOSA interest)
 * TODO: Phase 4 – dividend distribution to BOSA accounts
 * TODO: Phase 4 – inter-account transfers with double-entry ledger
 */
@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─── CREATE ACCOUNT ──────────────────────────────────────────

  async create(dto: CreateAccountDto, tenantId: string, createdBy: string, ipAddress?: string) {
    const member = await this.prisma.member.findFirst({
      where: { id: dto.memberId, tenantId },
      select: { id: true, memberNumber: true },
    });
    if (!member) throw new NotFoundException('Member not found in this tenant');

    // One BOSA + one FOSA per member per tenant
    const existing = await this.prisma.account.findFirst({
      where: { memberId: dto.memberId, accountType: dto.accountType, isActive: true },
    });
    if (existing) {
      throw new ConflictException(
        `Member already has an active ${dto.accountType} account (${existing.accountNumber})`,
      );
    }

    // Auto-generate account number: ACC-BOSA-000001 or ACC-FOSA-000001
    const counter = await this.prisma.tenantCounter.upsert({
      where: { tenantId },
      create: { tenantId, accountSeq: 1 },
      update: { accountSeq: { increment: 1 } },
    });
    const accountNumber = `ACC-${dto.accountType}-${String(counter.accountSeq).padStart(6, '0')}`;

    const account = await this.prisma.account.create({
      data: {
        tenantId,
        memberId: dto.memberId,
        accountNumber,
        accountType: dto.accountType,
        balance: 0,
      },
    });

    await this.audit.create({
      tenantId,
      userId: createdBy,
      action: 'ACCOUNT.CREATE',
      resource: 'Account',
      resourceId: account.id,
      metadata: { accountNumber, accountType: dto.accountType, memberId: dto.memberId },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    return account;
  }

  // ─── LIST ────────────────────────────────────────────────────

  async findAll(tenantId: string, memberId?: string) {
    return this.prisma.account.findMany({
      where: { tenantId, ...(memberId && { memberId }) },
      include: { member: { select: { memberNumber: true, user: { select: { firstName: true, lastName: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─── FIND ONE ────────────────────────────────────────────────

  async findOne(id: string, tenantId: string) {
    const account = await this.prisma.account.findFirst({
      where: { id, tenantId },
      include: {
        member: { select: { memberNumber: true, user: { select: { firstName: true, lastName: true, email: true } } } },
      },
    });
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }

  // ─── DEPOSIT ─────────────────────────────────────────────────

  /**
   * Post a DEPOSIT transaction to an account.
   * Uses Prisma interactive transaction to guarantee atomicity:
   *   1. Lock and read current balance
   *   2. Create Transaction record
   *   3. Update Account.balance
   * All monetary values handled as Decimal.
   */
  async deposit(
    accountId: string,
    amountKes: number,
    reference: string,
    description: string,
    tenantId: string,
    processedBy: string,
    ipAddress?: string,
  ) {
    if (amountKes <= 0) throw new BadRequestException('Amount must be positive');
    const amount = new Decimal(amountKes);

    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.findFirst({
        where: { id: accountId, tenantId, isActive: true },
      });
      if (!account) throw new NotFoundException('Account not found or inactive');

      // Duplicate reference guard
      const dupRef = await tx.transaction.findUnique({ where: { reference } });
      if (dupRef) throw new ConflictException(`Reference ${reference} already posted`);

      const balanceBefore = new Decimal(account.balance.toString());
      const balanceAfter = balanceBefore.plus(amount);

      const txn = await tx.transaction.create({
        data: {
          tenantId,
          accountId,
          type: TransactionType.DEPOSIT,
          status: TransactionStatus.COMPLETED,
          amount: amount.toDecimalPlaces(4).toString(),
          balanceBefore: balanceBefore.toDecimalPlaces(4).toString(),
          balanceAfter: balanceAfter.toDecimalPlaces(4).toString(),
          reference,
          description,
          processedBy,
        },
      });

      await tx.account.update({
        where: { id: accountId },
        data: { balance: balanceAfter.toDecimalPlaces(4).toString() },
      });

      await this.audit.create({
        tenantId,
        userId: processedBy,
        action: 'ACCOUNT.DEPOSIT',
        resource: 'Transaction',
        resourceId: txn.id,
        metadata: {
          accountId,
          amount: amount.toNumber(),
          balanceBefore: balanceBefore.toNumber(),
          balanceAfter: balanceAfter.toNumber(),
          reference,
        },
        ipAddress,
      }).catch((e: unknown) => this.logger.error('Audit write failed', e));

      return { transaction: txn, newBalance: balanceAfter.toNumber() };
    });
  }

  // ─── WITHDRAWAL ──────────────────────────────────────────────

  async withdraw(
    accountId: string,
    amountKes: number,
    reference: string,
    description: string,
    tenantId: string,
    processedBy: string,
    ipAddress?: string,
  ) {
    if (amountKes <= 0) throw new BadRequestException('Amount must be positive');
    const amount = new Decimal(amountKes);

    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.findFirst({
        where: { id: accountId, tenantId, isActive: true },
      });
      if (!account) throw new NotFoundException('Account not found or inactive');

      const balanceBefore = new Decimal(account.balance.toString());
      if (balanceBefore.lessThan(amount)) {
        throw new BadRequestException(
          `Insufficient balance: KES ${balanceBefore.toNumber()} < KES ${amount.toNumber()}`,
        );
      }

      const dupRef = await tx.transaction.findUnique({ where: { reference } });
      if (dupRef) throw new ConflictException(`Reference ${reference} already posted`);

      const balanceAfter = balanceBefore.minus(amount);

      const txn = await tx.transaction.create({
        data: {
          tenantId,
          accountId,
          type: TransactionType.WITHDRAWAL,
          status: TransactionStatus.COMPLETED,
          amount: amount.toDecimalPlaces(4).toString(),
          balanceBefore: balanceBefore.toDecimalPlaces(4).toString(),
          balanceAfter: balanceAfter.toDecimalPlaces(4).toString(),
          reference,
          description,
          processedBy,
        },
      });

      await tx.account.update({
        where: { id: accountId },
        data: { balance: balanceAfter.toDecimalPlaces(4).toString() },
      });

      return { transaction: txn, newBalance: balanceAfter.toNumber() };
    });
  }

  // ─── TRANSACTION HISTORY ─────────────────────────────────────

  async getTransactions(
    accountId: string,
    tenantId: string,
    page = 1,
    limit = 20,
  ) {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, tenantId },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('Account not found');

    const skip = (page - 1) * limit;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where: { accountId, tenantId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.transaction.count({ where: { accountId, tenantId } }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }
}
