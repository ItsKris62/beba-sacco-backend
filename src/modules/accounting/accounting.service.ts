import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Decimal } from 'decimal.js';
import {
  Prisma,
  AccountType,
  GLAccountType,
  JournalEntryStatus,
  JournalEntryType,
  MpesaTxType,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ReconciliationService } from '../financial/reconciliation.service';
import { AuditService } from '../audit/audit.service';
import {
  GetPendingReconQueryDto,
  LedgerQueryDto,
  ReconQueryDto,
  ReportsQueryDto,
} from './dto/accounting-query.dto';
import { CreateJournalEntryDto } from './dto/create-journal-entry.dto';
import { JournalEntryQueryDto } from './dto/journal-entry-query.dto';
import { ExportGLQueryDto } from './dto/export-gl.dto';

/**
 * Approval threshold in KES.
 * Manual journal entries with totalAmount >= this value require MANAGER approval.
 * Entries below this can be auto-approved by ACCOUNTANT role.
 *
 * TODO: Move to TenantSettings table for per-tenant configuration.
 */
const APPROVAL_THRESHOLD = 100_000;

/**
 * Default SACCO chart of accounts, seeded for every tenant.
 * Kept as the single source of truth — prisma/seed-gl-accounts.ts (CLI) calls
 * AccountingService.seedDefaultChartOfAccounts() rather than duplicating this list.
 */
interface GLAccountSeed {
  code: string;
  name: string;
  type: GLAccountType;
  isSystemAccount: boolean;
}

const DEFAULT_GL_ACCOUNTS: GLAccountSeed[] = [
  // ASSET accounts
  { code: '1000', name: 'Cash at Bank - M-Pesa', type: 'ASSET', isSystemAccount: true },
  { code: '1010', name: 'Cash at Bank - Commercial', type: 'ASSET', isSystemAccount: true },
  { code: '1100', name: 'Accounts Receivable', type: 'ASSET', isSystemAccount: true },
  { code: '1300', name: 'Loan Portfolio - Development', type: 'ASSET', isSystemAccount: true },
  { code: '1301', name: 'Loan Portfolio - Jipange', type: 'ASSET', isSystemAccount: true },
  { code: '1302', name: 'Loan Portfolio - Emergency', type: 'ASSET', isSystemAccount: true },
  { code: '1400', name: 'Provision for Bad Debts', type: 'ASSET', isSystemAccount: true },

  // LIABILITY accounts
  { code: '2000', name: 'Member Savings', type: 'LIABILITY', isSystemAccount: true },
  { code: '2100', name: 'Member Shares', type: 'LIABILITY', isSystemAccount: true },
  { code: '2200', name: 'Accounts Payable', type: 'LIABILITY', isSystemAccount: true },
  { code: '2300', name: 'Member Deposits - FOSA', type: 'LIABILITY', isSystemAccount: true },
  { code: '2400', name: 'Member Deposits - BOSA', type: 'LIABILITY', isSystemAccount: true },

  // EQUITY accounts
  { code: '3000', name: 'Share Capital', type: 'EQUITY', isSystemAccount: true },
  { code: '3100', name: 'Retained Earnings', type: 'EQUITY', isSystemAccount: true },
  { code: '3200', name: 'Statutory Reserve', type: 'EQUITY', isSystemAccount: true },

  // REVENUE accounts
  { code: '4000', name: 'Interest Income - Loans', type: 'REVENUE', isSystemAccount: true },
  { code: '4100', name: 'Fee Income', type: 'REVENUE', isSystemAccount: true },
  { code: '4200', name: 'Penalty Income', type: 'REVENUE', isSystemAccount: true },
  { code: '4300', name: 'Processing Fee Income', type: 'REVENUE', isSystemAccount: true },

  // EXPENSE accounts
  { code: '5000', name: 'Operating Expenses', type: 'EXPENSE', isSystemAccount: true },
  { code: '5100', name: 'Staff Costs', type: 'EXPENSE', isSystemAccount: true },
  { code: '5200', name: 'M-Pesa Transaction Fees', type: 'EXPENSE', isSystemAccount: true },
  { code: '5300', name: 'Bad Debt Write-off', type: 'EXPENSE', isSystemAccount: true },
  { code: '5400', name: 'Interest Expense', type: 'EXPENSE', isSystemAccount: true },
];

/** MVP default balance policy per account type, seeded for every new tenant. */
const DEFAULT_ACCOUNT_TYPE_POLICIES: Array<{
  accountType: AccountType;
  minimumBalance: number;
  allowsNegative: boolean;
}> = [
  { accountType: AccountType.FOSA, minimumBalance: 0, allowsNegative: false },
  { accountType: AccountType.BOSA, minimumBalance: 0, allowsNegative: false },
];

/**
 * AccountingService
 *
 * Dual-purpose service:
 *   1. Operational Ledger queries (getLedger, getReconciliation, matchMpesaTransaction)
 *      — aggregates over existing Transaction, Account, Loan, and MpesaTransaction records.
 *   2. Accounting Ledger management (journal entries, GL postings, chart of accounts)
 *      — uses the new JournalEntry, GLAccount, and GLPosting models.
 *
 * All queries enforce tenantId isolation.
 */
@Injectable()
export class AccountingService {
  private readonly logger = new Logger(AccountingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recon: ReconciliationService,
    private readonly audit: AuditService,
  ) {}

  // ─── DASHBOARD STATS ──────────────────────────────────────────────────────────

  /**
   * Aggregate overview stats for the accounting dashboard.
   */
  async getDashboardStats(tenantId: string) {
    const [
      pendingApprovalCount,
      unmatchedMpesaCount,
      postedJournalCount,
      totalGLAccounts,
    ] = await Promise.all([
      this.prisma.journalEntry.count({
        where: { tenantId, status: JournalEntryStatus.PENDING_APPROVAL },
      }),
      this.prisma.mpesaTransaction.count({
        where: { tenantId, status: TransactionStatus.RECON_PENDING, transactionId: null },
      }),
      this.prisma.journalEntry.count({
        where: { tenantId, status: JournalEntryStatus.POSTED },
      }),
      this.prisma.gLAccount.count({
        where: { tenantId, isActive: true },
      }),
    ]);

    return {
      pendingApprovalCount,
      unmatchedMpesaCount,
      postedJournalCount,
      totalGLAccounts,
    };
  }

  // ─── GL ACCOUNTS ──────────────────────────────────────────────────────────────

  /**
   * Return all active GL accounts for a tenant, ordered by code.
   */
  async getGLAccounts(tenantId: string) {
    const accounts = await this.prisma.gLAccount.findMany({
      where: { tenantId, isActive: true },
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        parentId: true,
        isSystemAccount: true,
        isActive: true,
      },
    });

    return { data: accounts };
  }

  // ─── JOURNAL ENTRIES ──────────────────────────────────────────────────────────

  /**
   * List journal entries with pagination and optional filters.
   */
  async getJournalEntries(tenantId: string, query: JournalEntryQueryDto) {
    const page = Math.max(1, Number(query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
    const skip = (page - 1) * limit;
    const dateFilter = this.buildDateFilter(query.startDate, query.endDate);

    const where: Record<string, unknown> = {
      tenantId,
      ...(query.status && { status: query.status }),
      ...(query.type && { type: query.type }),
      ...(dateFilter && { createdAt: dateFilter }),
    };

    if (query.search) {
      where.OR = [
        { entryNumber: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [entries, total] = await Promise.all([
      this.prisma.journalEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          entryNumber: true,
          type: true,
          status: true,
          description: true,
          totalAmount: true,
          referenceType: true,
          referenceId: true,
          approvalNotes: true,
          postedAt: true,
          createdAt: true,
          createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
          approvedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
          rejectedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
          postings: {
            select: {
              id: true,
              amount: true,
              description: true,
              postingDate: true,
              debitAccount: { select: { id: true, code: true, name: true, type: true } },
              creditAccount: { select: { id: true, code: true, name: true, type: true } },
            },
          },
        },
      }),
      this.prisma.journalEntry.count({ where }),
    ]);

    return {
      data: entries.map((e) => ({
        ...e,
        totalAmount: new Decimal(e.totalAmount.toString()).toNumber(),
        postings: e.postings.map((p) => ({
          ...p,
          amount: new Decimal(p.amount.toString()).toNumber(),
        })),
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get a single journal entry by ID with full details.
   */
  async getJournalEntry(tenantId: string, id: string) {
    const entry = await this.prisma.journalEntry.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        entryNumber: true,
        type: true,
        status: true,
        description: true,
        totalAmount: true,
        referenceType: true,
        referenceId: true,
        approvalNotes: true,
        postedAt: true,
        createdAt: true,
        updatedAt: true,
        createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        approvedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        rejectedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        postings: {
          select: {
            id: true,
            amount: true,
            description: true,
            postingDate: true,
            createdAt: true,
            debitAccount: { select: { id: true, code: true, name: true, type: true } },
            creditAccount: { select: { id: true, code: true, name: true, type: true } },
          },
        },
      },
    });

    if (!entry) {
      throw new NotFoundException(`Journal entry ${id} not found in this tenant`);
    }

    return {
      ...entry,
      totalAmount: new Decimal(entry.totalAmount.toString()).toNumber(),
      postings: entry.postings.map((p) => ({
        ...p,
        amount: new Decimal(p.amount.toString()).toNumber(),
      })),
    };
  }

  /**
   * Create a new journal entry with double-entry validation.
   *
   * Auto-generates entry number: JE-{YYYY}-{seq}
   * Validates that sum(posting amounts) equals the computed totalAmount.
   * Validates that debit and credit accounts exist and belong to the tenant.
   * Sets status to PENDING_APPROVAL if totalAmount >= APPROVAL_THRESHOLD,
   * otherwise sets to APPROVED (auto-approved).
   */
  async createJournalEntry(
    tenantId: string,
    dto: CreateJournalEntryDto,
    actorId: string,
  ) {
    // 1. Validate posting amounts are positive
    const totalAmount = dto.postings.reduce(
      (sum, p) => sum.plus(new Decimal(p.amount)),
      new Decimal(0),
    );

    if (totalAmount.lte(0)) {
      throw new BadRequestException('Total posting amount must be positive');
    }

    // 2. Validate all accounts exist and belong to tenant
    const accountIds = new Set<string>();
    for (const posting of dto.postings) {
      accountIds.add(posting.debitAccountId);
      accountIds.add(posting.creditAccountId);
    }

    const accounts = await this.prisma.gLAccount.findMany({
      where: { id: { in: [...accountIds] }, tenantId, isActive: true },
      select: { id: true },
    });

    const foundIds = new Set(accounts.map((a) => a.id));
    for (const id of accountIds) {
      if (!foundIds.has(id)) {
        throw new BadRequestException(`GL account ${id} not found or inactive in this tenant`);
      }
    }

    // 3. Validate no posting has debit == credit (same account)
    for (const posting of dto.postings) {
      if (posting.debitAccountId === posting.creditAccountId) {
        throw new BadRequestException(
          'Debit and credit accounts must be different in each posting line',
        );
      }
    }

    // 4. Generate entry number: JE-{YYYY}-{seq}
    const year = new Date().getFullYear();
    const lastEntry = await this.prisma.journalEntry.findFirst({
      where: {
        tenantId,
        entryNumber: { startsWith: `JE-${year}-` },
      },
      orderBy: { entryNumber: 'desc' },
      select: { entryNumber: true },
    });

    let seq = 1;
    if (lastEntry) {
      const parts = lastEntry.entryNumber.split('-');
      const lastSeq = parseInt(parts[2], 10);
      if (!isNaN(lastSeq)) seq = lastSeq + 1;
    }
    const entryNumber = `JE-${year}-${String(seq).padStart(6, '0')}`;

    // 5. Determine initial status based on threshold
    const status = totalAmount.gte(APPROVAL_THRESHOLD)
      ? JournalEntryStatus.PENDING_APPROVAL
      : JournalEntryStatus.APPROVED;

    // 6. Create entry + postings in a transaction
    const entry = await this.prisma.journalEntry.create({
      data: {
        tenantId,
        entryNumber,
        type: dto.type,
        status,
        description: dto.description,
        totalAmount: totalAmount.toDecimalPlaces(4).toString(),
        referenceType: dto.referenceType,
        referenceId: dto.referenceId,
        createdById: actorId,
        // If auto-approved (below threshold), mark as approved by creator
        ...(status === JournalEntryStatus.APPROVED && {
          approvedById: actorId,
          approvalNotes: 'Auto-approved: amount below approval threshold',
        }),
        postings: {
          create: dto.postings.map((p) => ({
            debitAccountId: p.debitAccountId,
            creditAccountId: p.creditAccountId,
            amount: new Decimal(p.amount).toDecimalPlaces(4).toString(),
            description: p.description,
          })),
        },
      },
      include: {
        postings: {
          select: {
            id: true,
            amount: true,
            description: true,
            debitAccount: { select: { id: true, code: true, name: true } },
            creditAccount: { select: { id: true, code: true, name: true } },
          },
        },
        createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    // 7. Audit log
    this.audit
      .create({
        tenantId,
        actorId,
        action: 'JOURNAL_ENTRY.CREATED',
        entityType: 'JournalEntry',
        entityId: entry.id,
        newValue: {
          entryNumber,
          type: dto.type,
          status,
          totalAmount: totalAmount.toNumber(),
          postingCount: dto.postings.length,
        },
        metadata: {
          autoApproved: status === JournalEntryStatus.APPROVED,
          approvalThreshold: APPROVAL_THRESHOLD,
        },
      })
      .catch(() => { /* audit failures are non-fatal */ });

    return {
      ...entry,
      totalAmount: totalAmount.toNumber(),
      postings: entry.postings.map((p) => ({
        ...p,
        amount: new Decimal(p.amount.toString()).toNumber(),
      })),
    };
  }

  /**
   * Approve a pending journal entry.
   * Transitions PENDING_APPROVAL → APPROVED.
   * The caller must not be the same user who created the entry (maker-checker).
   */
  async approveJournalEntry(
    tenantId: string,
    id: string,
    actorId: string,
    notes?: string,
  ) {
    const entry = await this.prisma.journalEntry.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true, createdById: true, entryNumber: true },
    });

    if (!entry) {
      throw new NotFoundException(`Journal entry ${id} not found in this tenant`);
    }

    if (entry.status !== JournalEntryStatus.PENDING_APPROVAL) {
      throw new ConflictException(
        `Journal entry ${entry.entryNumber} is ${entry.status}, not PENDING_APPROVAL`,
      );
    }

    // Maker-checker: creator cannot approve their own entry
    if (entry.createdById === actorId) {
      throw new ForbiddenException(
        'Maker-checker violation: you cannot approve your own journal entry',
      );
    }

    const updated = await this.prisma.journalEntry.update({
      where: { id },
      data: {
        status: JournalEntryStatus.APPROVED,
        approvedById: actorId,
        approvalNotes: notes?.trim() || 'Approved',
      },
      select: {
        id: true,
        entryNumber: true,
        status: true,
        totalAmount: true,
        approvedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    this.audit
      .create({
        tenantId,
        actorId,
        action: 'JOURNAL_ENTRY.APPROVED',
        entityType: 'JournalEntry',
        entityId: id,
        oldValue: { status: JournalEntryStatus.PENDING_APPROVAL },
        newValue: { status: JournalEntryStatus.APPROVED, notes },
      })
      .catch(() => {});

    return {
      ...updated,
      totalAmount: new Decimal(updated.totalAmount.toString()).toNumber(),
    };
  }

  /**
   * Reject a pending journal entry.
   * Transitions PENDING_APPROVAL → REJECTED.
   */
  async rejectJournalEntry(
    tenantId: string,
    id: string,
    actorId: string,
    notes?: string,
  ) {
    const entry = await this.prisma.journalEntry.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true, entryNumber: true },
    });

    if (!entry) {
      throw new NotFoundException(`Journal entry ${id} not found in this tenant`);
    }

    if (entry.status !== JournalEntryStatus.PENDING_APPROVAL) {
      throw new ConflictException(
        `Journal entry ${entry.entryNumber} is ${entry.status}, not PENDING_APPROVAL`,
      );
    }

    const updated = await this.prisma.journalEntry.update({
      where: { id },
      data: {
        status: JournalEntryStatus.REJECTED,
        rejectedById: actorId,
        approvalNotes: notes?.trim() || 'Rejected',
      },
      select: {
        id: true,
        entryNumber: true,
        status: true,
        totalAmount: true,
        rejectedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    this.audit
      .create({
        tenantId,
        actorId,
        action: 'JOURNAL_ENTRY.REJECTED',
        entityType: 'JournalEntry',
        entityId: id,
        oldValue: { status: JournalEntryStatus.PENDING_APPROVAL },
        newValue: { status: JournalEntryStatus.REJECTED, notes },
      })
      .catch(() => {});

    return {
      ...updated,
      totalAmount: new Decimal(updated.totalAmount.toString()).toNumber(),
    };
  }

  // ─── PENDING APPROVALS ────────────────────────────────────────────────────────

  /**
   * Get all items awaiting approval: journal entries in PENDING_APPROVAL status.
   */
  async getPendingApprovals(tenantId: string) {
    const entries = await this.prisma.journalEntry.findMany({
      where: { tenantId, status: JournalEntryStatus.PENDING_APPROVAL },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        entryNumber: true,
        type: true,
        description: true,
        totalAmount: true,
        referenceType: true,
        referenceId: true,
        createdAt: true,
        createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    return {
      items: entries.map((e) => ({
        id: e.id,
        entryNumber: e.entryNumber,
        type: e.type,
        description: e.description,
        amount: new Decimal(e.totalAmount.toString()).toNumber(),
        createdBy: e.createdBy.email,
        createdByName: `${e.createdBy.firstName} ${e.createdBy.lastName}`,
        createdAt: e.createdAt,
        referenceType: e.referenceType,
        referenceId: e.referenceId,
      })),
      total: entries.length,
    };
  }

  // ─── GL EXPORT ────────────────────────────────────────────────────────────────

  /**
   * Export GL postings as CSV for the given date range.
   * Returns a string in CSV format.
   */
  async exportGL(tenantId: string, query: ExportGLQueryDto): Promise<string> {
    const dateFilter = this.buildDateFilter(query.startDate, query.endDate);

    const postings = await this.prisma.gLPosting.findMany({
      where: {
        journalEntry: {
          tenantId,
          status: { in: [JournalEntryStatus.APPROVED, JournalEntryStatus.POSTED] },
          ...(dateFilter && { createdAt: dateFilter }),
        },
      },
      orderBy: { postingDate: 'asc' },
      select: {
        id: true,
        amount: true,
        description: true,
        postingDate: true,
        debitAccount: { select: { code: true, name: true, type: true } },
        creditAccount: { select: { code: true, name: true, type: true } },
        journalEntry: {
          select: {
            entryNumber: true,
            type: true,
            description: true,
            createdBy: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });

    // Build CSV
    const headers = [
      'Posting Date',
      'Entry Number',
      'Entry Type',
      'Description',
      'Debit Account Code',
      'Debit Account Name',
      'Credit Account Code',
      'Credit Account Name',
      'Amount (KES)',
      'Created By',
    ];

    const rows = postings.map((p) => [
      p.postingDate.toISOString().split('T')[0],
      p.journalEntry.entryNumber,
      p.journalEntry.type,
      `"${(p.description || p.journalEntry.description).replace(/"/g, '""')}"`,
      p.debitAccount?.code ?? '',
      '"' + (p.debitAccount?.name ?? '').replace(/"/g, '""') + '"',
      p.creditAccount?.code ?? '',
      '"' + (p.creditAccount?.name ?? '').replace(/"/g, '""') + '"',
      new Decimal(p.amount.toString()).toFixed(2),
      `"${p.journalEntry.createdBy.firstName} ${p.journalEntry.createdBy.lastName}"`,
    ]);

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }

  // ─── LEDGER (existing) ────────────────────────────────────────────────────────

  /**
   * Return transaction ledger entries grouped by account × calendar day.
   *
   * Opening balance  = balanceBefore of the first transaction of the day.
   * Closing balance  = balanceAfter  of the last  transaction of the day.
   * totalIn  = sum of amounts where the net effect is a credit to the account
   *            (DEPOSIT, LOAN_DISBURSEMENT, INTEREST_EARNED, DIVIDEND_PAYOUT, INTEREST_ACCRUAL).
   * totalOut = sum of amounts for debits (WITHDRAWAL, LOAN_REPAYMENT, PENALTY, FEE_CHARGE).
   *
   * If accountId is supplied, results are limited to that account and include
   * the individual transaction list per day-group.
   */
  async getLedger(tenantId: string, query: LedgerQueryDto) {
    const { startDate, endDate, accountId } = query;
    const page = Math.max(1, Number(query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
    const skip = (page - 1) * limit;

    const dateFilter = this.buildDateFilter(startDate, endDate);
    const where = {
      tenantId,
      status: TransactionStatus.COMPLETED,
      ...(accountId && { accountId }),
      ...(dateFilter && { createdAt: dateFilter }),
    };

    const [txns, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        orderBy: [{ accountId: 'asc' }, { createdAt: 'asc' }],
        skip,
        take: limit,
        select: {
          id: true,
          accountId: true,
          type: true,
          amount: true,
          balanceBefore: true,
          balanceAfter: true,
          reference: true,
          description: true,
          createdAt: true,
          account: { select: { accountNumber: true, accountType: true } },
        },
      }),
      this.prisma.transaction.count({ where }),
    ]);

    // Group by accountId + YYYY-MM-DD
    const grouped = new Map<string, typeof txns>();
    for (const t of txns) {
      const day = t.createdAt.toISOString().split('T')[0];
      const key = `${t.accountId}::${day}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(t);
    }

    const CREDIT_TYPES = new Set([
      'DEPOSIT',
      'LOAN_DISBURSEMENT',
      'INTEREST_EARNED',
      'DIVIDEND_PAYOUT',
      'INTEREST_ACCRUAL',
    ]);

    const data = [...grouped.entries()].map(([key, entries]) => {
      const [, day] = key.split('::');
      const first = entries[0];
      const last = entries[entries.length - 1];

      let totalIn = new Decimal(0);
      let totalOut = new Decimal(0);
      for (const t of entries) {
        const amt = new Decimal(t.amount.toString());
        if (CREDIT_TYPES.has(t.type)) {
          totalIn = totalIn.plus(amt);
        } else {
          totalOut = totalOut.plus(amt);
        }
      }

      return {
        date: day,
        accountId: first.accountId,
        accountNumber: first.account.accountNumber,
        accountType: first.account.accountType,
        openingBalance: new Decimal(first.balanceBefore.toString()).toNumber(),
        closingBalance: new Decimal(last.balanceAfter.toString()).toNumber(),
        totalIn: totalIn.toNumber(),
        totalOut: totalOut.toNumber(),
        transactionCount: entries.length,
        // Include individual transactions only when drilling into a single account
        ...(accountId && {
          transactions: entries.map((t) => ({
            id: t.id,
            type: t.type,
            amount: new Decimal(t.amount.toString()).toNumber(),
            balanceBefore: new Decimal(t.balanceBefore.toString()).toNumber(),
            balanceAfter: new Decimal(t.balanceAfter.toString()).toNumber(),
            reference: t.reference,
            description: t.description,
            createdAt: t.createdAt,
          })),
        }),
      };
    });

    // Sort by date desc
    data.sort((a, b) => b.date.localeCompare(a.date));

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        startDate,
        endDate,
        accountId,
      },
    };
  }

  // ─── RECONCILIATION (existing) ────────────────────────────────────────────────

  /**
   * Return the cached reconciliation report for a settlement date plus
   * the current count of RECON_PENDING M-Pesa transactions in the DB.
   *
   * The cached report is written by ReconciliationService.runReconciliation()
   * (triggered nightly by the BullMQ cron job). If no cache exists for the
   * requested date the cachedReport field is null.
   */
  async getReconciliation(tenantId: string, query: ReconQueryDto) {
    const date = query.date ?? new Date().toISOString().split('T')[0];

    const [cachedReport, reconPendingCount, reconPendingTransactions] = await Promise.all([
      this.recon.getLatestReport(tenantId, date),
      this.prisma.mpesaTransaction.count({
        where: { tenantId, status: TransactionStatus.RECON_PENDING },
      }),
      this.prisma.mpesaTransaction.findMany({
        where: { tenantId, status: TransactionStatus.RECON_PENDING },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          checkoutRequestId: true,
          amount: true,
          phoneNumber: true,
          createdAt: true,
          updatedAt: true,
          mpesaReceiptNumber: true,
        },
      }),
    ]);

    return {
      settlementDate: date,
      cachedReport,
      reconPending: {
        count: reconPendingCount,
        transactions: reconPendingTransactions.map((t) => ({
          ...t,
          amount: new Decimal(t.amount.toString()).toNumber(),
        })),
      },
    };
  }

  // ─── PENDING RECONCILIATION (existing) ────────────────────────────────────────

  /**
   * Paginated RECON_PENDING M-Pesa transactions for the pending review queue.
   */
  async getPendingReconciliation(tenantId: string, query: GetPendingReconQueryDto) {
    const page = Math.max(1, Number(query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
    const skip = (page - 1) * limit;
    const startDate = query.startDate ?? query.dateFrom;
    const endDate = query.endDate ?? query.dateTo;
    const dateFilter = this.buildDateFilter(startDate, endDate);
    const typeFilter =
      query.type === 'STK'
        ? MpesaTxType.STK_PUSH
        : query.type === 'B2C'
          ? MpesaTxType.B2C
          : undefined;

    const where: Prisma.MpesaTransactionWhereInput = {
      tenantId,
      status: TransactionStatus.RECON_PENDING,
      transactionId: null, // only unlinked transactions need matching
      ...(typeFilter && { type: typeFilter }),
      ...(dateFilter && { createdAt: dateFilter }),
      ...(query.search && {
        OR: [
          { mpesaReceiptNumber: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
          { checkoutRequestId: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
          { conversationId: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
          { reference: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
          { phoneNumber: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
          { accountReference: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
        ],
      }),
    };

    type PendingReconRow = {
      id: string;
      reference: string;
      type: MpesaTxType;
      status: TransactionStatus;
      amount: { toString(): string };
      phoneNumber: string;
      accountReference: string | null;
      checkoutRequestId: string | null;
      conversationId: string | null;
      mpesaReceiptNumber: string | null;
      resultDesc: string | null;
      createdAt: Date;
      member: {
        id: string;
        memberNumber: string;
        user: { firstName: string; lastName: string; email: string };
      } | null;
      transaction: { reference: string; amount: { toString(): string } } | null;
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.mpesaTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          reference: true,
          type: true,
          status: true,
          amount: true,
          phoneNumber: true,
          accountReference: true,
          checkoutRequestId: true,
          conversationId: true,
          mpesaReceiptNumber: true,
          resultDesc: true,
          createdAt: true,
          member: {
            select: {
              id: true,
              memberNumber: true,
              user: { select: { firstName: true, lastName: true, email: true } },
            },
          },
          transaction: {
            select: {
              reference: true,
              amount: true,
            },
          },
        },
      }),
      this.prisma.mpesaTransaction.count({ where }),
    ]) as [PendingReconRow[], number];

    return {
      data: rows.map((row) => ({
        id: row.id,
        mpesaReference:
          row.mpesaReceiptNumber ??
          row.checkoutRequestId ??
          row.conversationId ??
          row.reference,
        type: row.type === MpesaTxType.STK_PUSH ? 'STK_PUSH' : row.type,
        amount: new Decimal(row.amount.toString()).toNumber(),
        phoneNumber: row.phoneNumber,
        accountReference: row.accountReference,
        mpesaReceipt: row.mpesaReceiptNumber,
        createdAt: row.createdAt,
        flagReason: row.resultDesc ?? 'Reconciliation mismatch requires manual review',
        reconciliationStatus: row.status,
        member: row.member
          ? {
              id: row.member.id,
              memberNumber: row.member.memberNumber,
              name: `${row.member.user.firstName} ${row.member.user.lastName}`,
              email: row.member.user.email,
            }
          : null,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        startDate,
        endDate,
        type: query.type,
      },
    };
  }

  // ─── MATCH MPESA (existing) ───────────────────────────────────────────────────

  /**
   * Manually match an unlinked RECON_PENDING M-Pesa transaction to a member account.
   *
   * Posts a credit (DEPOSIT) to the target account inside a SERIALIZABLE transaction,
   * then marks the MpesaTransaction as COMPLETED with the new ledger reference.
   * Idempotent: if the MPESA-RECON-{id} reference already exists the match is skipped
   * and the existing transaction is returned.
   */
  async matchMpesaTransaction(
    mpesaTxId: string,
    tenantId: string,
    accountId: string,
    actorId: string,
    note?: string,
  ): Promise<{
    success: boolean;
    transactionId: string;
    amount: number;
    balanceBefore: number;
    balanceAfter: number;
    accountNumber: string;
    memberName: string;
  }> {
    const mpesaTx = await this.prisma.mpesaTransaction.findFirst({
      where: {
        id: mpesaTxId,
        tenantId,
        status: TransactionStatus.RECON_PENDING,
        transactionId: null,
      },
    });

    if (!mpesaTx) {
      throw new NotFoundException(
        `RECON_PENDING M-Pesa transaction ${mpesaTxId} not found, already matched, or belongs to a different tenant`,
      );
    }

    const account = await this.prisma.account.findFirst({
      where: { id: accountId, tenantId, isActive: true },
      include: {
        member: {
          select: {
            id: true,
            user: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });

    if (!account) {
      throw new NotFoundException(`Active account ${accountId} not found in this tenant`);
    }

    const reference = `MPESA-RECON-${mpesaTxId}`;
    const amount = new Decimal(mpesaTx.amount.toString());
    const noteText = note?.trim() ?? 'No note provided';

    let resultTxId = '';
    let balanceBefore = new Decimal(0);
    let balanceAfter = new Decimal(0);

    const txClient = this.prisma.direct ?? this.prisma;
    await txClient.$transaction(
      async (tx) => {
        const dup = await tx.transaction.findFirst({ where: { tenantId, reference } });
        if (dup) {
          resultTxId = dup.id;
          balanceBefore = new Decimal(dup.balanceBefore.toString());
          balanceAfter = new Decimal(dup.balanceAfter.toString());
          return;
        }

        const freshAccount = await tx.account.findFirst({
          where: { id: accountId, tenantId, isActive: true },
          select: { balance: true },
        });
        if (!freshAccount) throw new NotFoundException(`Account ${accountId} disappeared during transaction`);

        balanceBefore = new Decimal(freshAccount.balance.toString());
        balanceAfter = balanceBefore.plus(amount).toDecimalPlaces(4);

        const updated = await tx.account.updateMany({
          where: { id: accountId, tenantId, isActive: true },
          data: {
            balance: { increment: amount.toDecimalPlaces(4).toString() },
            version: { increment: 1 },
          },
        });

        if (updated.count === 0) {
          throw new BadRequestException('Insufficient funds or concurrent modification');
        }

        const ledgerTx = await tx.transaction.create({
          data: {
            tenantId,
            accountId,
            type: TransactionType.DEPOSIT,
            status: TransactionStatus.COMPLETED,
            amount: amount.toDecimalPlaces(4).toString(),
            balanceBefore: balanceBefore.toDecimalPlaces(4).toString(),
            balanceAfter: balanceAfter.toString(),
            reference,
            description: `Manual M-Pesa reconciliation - receipt ${mpesaTx.mpesaReceiptNumber ?? mpesaTxId} - ${noteText}`,
            processedBy: actorId,
          },
        });

        const glAccounts = await tx.gLAccount.findMany({
          where: { tenantId, code: { in: ['1000', '2000'] }, isActive: true },
          select: { id: true, code: true },
        });
        const cashAccount = glAccounts.find((gl) => gl.code === '1000');
        const memberSavingsAccount = glAccounts.find((gl) => gl.code === '2000');
        if (!cashAccount || !memberSavingsAccount) {
          throw new BadRequestException('Required system GL accounts are not configured for this tenant');
        }

        await tx.journalEntry.create({
          data: {
            tenantId,
            entryNumber: `JE-MPESA-RECON-${mpesaTxId}`,
            type: JournalEntryType.MPESA_DEPOSIT,
            status: JournalEntryStatus.POSTED,
            description: `Manual M-Pesa reconciliation - receipt ${mpesaTx.mpesaReceiptNumber ?? mpesaTxId} - ${noteText}`,
            referenceType: 'TRANSACTION',
            referenceId: ledgerTx.id,
            totalAmount: amount.toDecimalPlaces(4).toString(),
            createdById: actorId,
            approvedById: actorId,
            approvalNotes: 'System-posted with operational ledger transaction',
            postedAt: new Date(),
            postings: {
              create: [{
                debitAccountId: cashAccount.id,
                creditAccountId: memberSavingsAccount.id,
                amount: amount.toDecimalPlaces(4).toString(),
                description: `Manual M-Pesa reconciliation - ${reference}`,
              }],
            },
          },
        });

        await tx.mpesaTransaction.update({
          where: { id: mpesaTxId },
          data: {
            transactionId: ledgerTx.id,
            memberId: mpesaTx.memberId ?? account.member.id,
            status: TransactionStatus.COMPLETED,
            resultDesc: `Manually reconciled - ${noteText}`,
          },
        });

        resultTxId = ledgerTx.id;
      },
      { isolationLevel: 'Serializable' },
    );

    this.audit.create({
      tenantId,
      actorId,
      action: 'MPESA.MANUAL_MATCH',
      entityType: 'MpesaTransaction',
      entityId: mpesaTxId,
      oldValue: { status: TransactionStatus.RECON_PENDING },
      newValue: {
        status: TransactionStatus.COMPLETED,
        transactionId: resultTxId,
        accountId,
        balanceBefore: balanceBefore.toFixed(4),
        balanceAfter: balanceAfter.toFixed(4),
      },
      metadata: {
        mpesaReceipt: mpesaTx.mpesaReceiptNumber,
        amount: amount.toFixed(4),
        phoneNumber: mpesaTx.phoneNumber,
        accountReference: mpesaTx.accountReference,
        note: noteText,
        reference,
      },
    }).catch(() => { /* audit failures are non-fatal */ });

    const memberName = `${account.member.user.firstName} ${account.member.user.lastName}`;

    return {
      success: true,
      transactionId: resultTxId,
      amount: amount.toNumber(),
      balanceBefore: balanceBefore.toNumber(),
      balanceAfter: balanceAfter.toNumber(),
      accountNumber: account.accountNumber,
      memberName,
    };
  }

  // ─── REPORTS (existing) ───────────────────────────────────────────────────────

  async getReport(tenantId: string, query: ReportsQueryDto) {
    const { startDate, endDate } = query;
    const dateFilter = this.buildDateFilter(startDate, endDate);

    const [accountStats, loanStats, mpesaStats] = await Promise.all([
      // FOSA / BOSA totals — current balances, not period-filtered
      this.prisma.account.groupBy({
        by: ['accountType'],
        where: { tenantId, isActive: true },
        _sum: { balance: true },
        _count: { id: true },
      }),

      // Loan book — grouped by status, filtered by disbursedAt period
      this.prisma.loan.groupBy({
        by: ['status'],
        where: {
          tenantId,
          ...(dateFilter && { disbursedAt: dateFilter }),
        },
        _count: { id: true },
        _sum: { principalAmount: true, outstandingBalance: true },
      }),

      // M-Pesa inflow
      this.prisma.mpesaTransaction.aggregate({
        where: {
          tenantId,
          status: TransactionStatus.COMPLETED,
          ...(dateFilter && { createdAt: dateFilter }),
        },
        _sum: { amount: true },
        _count: { id: true },
      }),
    ]);

    const accountBook = accountStats.map((a) => ({
      accountType: a.accountType,
      totalBalance: new Decimal((a._sum.balance ?? 0).toString()).toNumber(),
      accountCount: a._count.id,
    }));

    const loanBook = loanStats.map((l) => ({
      status: l.status,
      count: l._count.id,
      totalPrincipal: new Decimal((l._sum.principalAmount ?? 0).toString()).toNumber(),
      totalOutstanding: new Decimal((l._sum.outstandingBalance ?? 0).toString()).toNumber(),
    }));

    const mpesaVolume = {
      totalAmount: new Decimal((mpesaStats._sum.amount ?? 0).toString()).toNumber(),
      transactionCount: mpesaStats._count.id,
    };

    return {
      period: { startDate, endDate },
      accountBook,
      loanBook,
      mpesaVolume,
      generatedAt: new Date().toISOString(),
    };
  }

  // ─── TENANT PROVISIONING (GL seeding) ──────────────────────────────────────────

  /**
   * Idempotently seed the default SACCO chart of accounts for a tenant.
   * Matches existing rows by (tenantId, code) and leaves them untouched —
   * safe to call repeatedly (e.g. re-run after adding a new default account).
   */
  async seedDefaultChartOfAccounts(tenantId: string): Promise<{ seeded: number }> {
    for (const account of DEFAULT_GL_ACCOUNTS) {
      await this.prisma.gLAccount.upsert({
        where: { tenantId_code: { tenantId, code: account.code } },
        update: {},
        create: {
          tenantId,
          code: account.code,
          name: account.name,
          type: account.type,
          isSystemAccount: account.isSystemAccount,
          isActive: true,
        },
      });
    }
    return { seeded: DEFAULT_GL_ACCOUNTS.length };
  }

  /**
   * Idempotently seed the default FOSA/BOSA balance policy for a tenant.
   * MVP defaults: minimumBalance = 0, allowsNegative = false for both types.
   * Existing policy rows are left untouched.
   */
  async seedDefaultAccountTypePolicies(tenantId: string): Promise<{ seeded: number }> {
    for (const policy of DEFAULT_ACCOUNT_TYPE_POLICIES) {
      await this.prisma.accountTypePolicy.upsert({
        where: { tenantId_accountType: { tenantId, accountType: policy.accountType } },
        update: {},
        create: {
          tenantId,
          accountType: policy.accountType,
          minimumBalance: policy.minimumBalance,
          allowsNegative: policy.allowsNegative,
        },
      });
    }
    return { seeded: DEFAULT_ACCOUNT_TYPE_POLICIES.length };
  }

  /**
   * Full accounting provisioning for a newly created tenant: chart of accounts
   * + default account-type balance policies. Called by TenantsService.create()
   * right after the Tenant row is inserted. Idempotent — safe to re-run for an
   * existing tenant (e.g. from the CLI backfill script).
   */
  async provisionTenantAccounting(
    tenantId: string,
  ): Promise<{ glAccountsSeeded: number; policiesSeeded: number }> {
    const [gl, policies] = await Promise.all([
      this.seedDefaultChartOfAccounts(tenantId),
      this.seedDefaultAccountTypePolicies(tenantId),
    ]);
    return { glAccountsSeeded: gl.seeded, policiesSeeded: policies.seeded };
  }

  // ─── HELPERS ──────────────────────────────────────────────────────────────────

  private buildDateFilter(
    startDate?: string,
    endDate?: string,
  ): { gte?: Date; lte?: Date } | undefined {
    if (!startDate && !endDate) return undefined;
    const filter: { gte?: Date; lte?: Date } = {};
    if (startDate) filter.gte = new Date(`${startDate}T00:00:00.000Z`);
    if (endDate) {
      const end = new Date(`${endDate}T23:59:59.999Z`);
      filter.lte = end;
    }
    return filter;
  }
}
