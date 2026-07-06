import {
  Injectable, Logger, NotFoundException, ConflictException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { JournalEntryType } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../accounting/ledger.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { TransferFundsDto } from './dto/transfer-funds.dto';

/**
 * Accounts Service
 *
 * Handles BOSA (savings) and FOSA (transactional) accounts.
 * All monetary arithmetic uses Decimal from decimal.js — never native number.
 * deposit()/withdraw() delegate balance updates + GL posting to LedgerService —
 * see ledger.service.ts for the atomicity/idempotency/minimum-balance-floor logic.
 *
 * TODO: Phase 3 – interest accrual engine (monthly BOSA interest)
 * TODO: Phase 4 – dividend distribution to BOSA accounts
 * TODO: snapshot minimumBalance/allowsNegative from AccountTypePolicy onto new
 *       Account rows in create() below — currently every new account gets the
 *       column defaults (0 / false) regardless of the tenant's configured policy.
 */
@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
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
   * Post a DEPOSIT via LedgerService.postEntry() — writes the operational
   * Transaction row and the paired GL JournalEntry/GLPosting atomically.
   * Idempotent on (tenantId, reference); duplicate-reference resubmission
   * returns the original result instead of throwing ConflictException, since
   * postEntry() replays rather than rejects (a behavior change from the old
   * manual implementation — see Phase 3 notes).
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
    const amount = new Decimal(amountKes);

    const { transaction } = await this.ledger.postEntry({
      tenantId,
      reference,
      journalType: JournalEntryType.DEPOSIT,
      accountId,
      amount,
      direction: 'CREDIT',
      actorId: processedBy,
      description,
    });

    const balanceBefore = new Decimal(transaction.balanceBefore.toString());
    const balanceAfter = new Decimal(transaction.balanceAfter.toString());

    this.audit.create({
      tenantId,
      userId: processedBy,
      action: 'ACCOUNT.DEPOSIT',
      resource: 'Transaction',
      resourceId: transaction.id,
      metadata: {
        accountId,
        amount: amount.toNumber(),
        balanceBefore: balanceBefore.toNumber(),
        balanceAfter: balanceAfter.toNumber(),
        reference,
      },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    return { transaction, newBalance: balanceAfter.toNumber() };
  }

  // ─── WITHDRAWAL ──────────────────────────────────────────────

  /**
   * Post a WITHDRAWAL via LedgerService.postEntry(). The minimum-balance floor
   * (Account.minimumBalance / allowsNegative) is enforced inside postEntry()'s
   * atomic conditional update — see LedgerService.applyBalanceChange().
   */
  async withdraw(
    accountId: string,
    amountKes: number,
    reference: string,
    description: string,
    tenantId: string,
    processedBy: string,
    ipAddress?: string,
  ) {
    const amount = new Decimal(amountKes);

    const { transaction } = await this.ledger.postEntry({
      tenantId,
      reference,
      journalType: JournalEntryType.WITHDRAWAL,
      accountId,
      amount,
      direction: 'DEBIT',
      actorId: processedBy,
      description,
    });

    const balanceBefore = new Decimal(transaction.balanceBefore.toString());
    const balanceAfter = new Decimal(transaction.balanceAfter.toString());

    this.audit.create({
      tenantId,
      userId: processedBy,
      action: 'ACCOUNT.WITHDRAW',
      resource: 'Transaction',
      resourceId: transaction.id,
      metadata: {
        accountId,
        amount: amount.toNumber(),
        balanceBefore: balanceBefore.toNumber(),
        balanceAfter: balanceAfter.toNumber(),
        reference,
      },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    return { transaction, newBalance: balanceAfter.toNumber() };
  }

  // ─── INTERNAL TRANSFER (FOSA <-> BOSA) ────────────────────────

  /**
   * Transfer funds between two of the SAME member's accounts (e.g. FOSA -> BOSA).
   * Delegates the atomic double-entry work to LedgerService.postInternalTransfer();
   * this method's own job is just ownership validation (both accounts must belong
   * to the same member) before handing off.
   */
  async transfer(
    sourceAccountId: string,
    dto: TransferFundsDto,
    tenantId: string,
    actorId: string,
    ipAddress?: string,
  ) {
    if (sourceAccountId === dto.destinationAccountId) {
      throw new BadRequestException('Cannot transfer an account to itself');
    }

    const [source, destination] = await Promise.all([
      this.prisma.account.findFirst({
        where: { id: sourceAccountId, tenantId, isActive: true },
        select: { id: true, memberId: true },
      }),
      this.prisma.account.findFirst({
        where: { id: dto.destinationAccountId, tenantId, isActive: true },
        select: { id: true, memberId: true },
      }),
    ]);

    if (!source) throw new NotFoundException('Source account not found or inactive');
    if (!destination) throw new NotFoundException('Destination account not found or inactive');
    if (source.memberId !== destination.memberId) {
      throw new ForbiddenException('Internal transfers are only allowed between accounts of the same member');
    }

    const reference = `XFER-${uuidv4()}`;
    const { fromTransaction, toTransaction, journalEntry } = await this.ledger.postInternalTransfer({
      tenantId,
      fromAccountId: sourceAccountId,
      toAccountId: dto.destinationAccountId,
      amount: new Decimal(dto.amount),
      reference,
      actorId,
      description: dto.description,
    });

    this.audit.create({
      tenantId,
      userId: actorId,
      action: 'ACCOUNT.TRANSFER',
      resource: 'Transaction',
      resourceId: fromTransaction.id,
      metadata: {
        sourceAccountId,
        destinationAccountId: dto.destinationAccountId,
        amount: dto.amount,
        reference,
        journalEntryId: journalEntry.id,
      },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    return {
      fromTransaction,
      toTransaction,
      newSourceBalance: new Decimal(fromTransaction.balanceAfter.toString()).toNumber(),
      newDestinationBalance: new Decimal(toTransaction.balanceAfter.toString()).toNumber(),
    };
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
