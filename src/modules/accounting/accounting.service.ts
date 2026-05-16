import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { MpesaTxType, TransactionStatus, TransactionType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ReconciliationService } from '../financial/reconciliation.service';
import { AuditService } from '../audit/audit.service';
import {
  GetPendingReconQueryDto,
  LedgerQueryDto,
  ReconQueryDto,
  ReportsQueryDto,
} from './dto/accounting-query.dto';

/**
 * AccountingService
 *
 * All queries aggregate over existing Transaction, Account, Loan, and
 * MpesaTransaction records. No new GL/journal models are introduced.
 * All queries enforce tenantId isolation.
 */
@Injectable()
export class AccountingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recon: ReconciliationService,
    private readonly audit: AuditService,
  ) {}

  // ─── LEDGER ─────────────────────────────────────────────────────────────────

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

    const dateFilter = this.buildDateFilter(startDate, endDate);

    const txns = await this.prisma.transaction.findMany({
      where: {
        tenantId,
        status: TransactionStatus.COMPLETED,
        ...(accountId && { accountId }),
        ...(dateFilter && { createdAt: dateFilter }),
      },
      orderBy: [{ accountId: 'asc' }, { createdAt: 'asc' }],
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
    });

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

    return { data, meta: { count: data.length, startDate, endDate, accountId } };
  }

  // ─── RECONCILIATION ─────────────────────────────────────────────────────────

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

  // ─── REPORTS ─────────────────────────────────────────────────────────────────

  /**
   * Aggregate financial summary for the given period.
   *
   * Sections:
   *   accountBook   — FOSA/BOSA total balances and account counts
   *   loanBook      — active/disbursed/defaulted counts and principal sums, grouped by status
   *   mpesaVolume   — total M-Pesa inflow (COMPLETED STK_PUSH/C2B) for the period
   */
  async getPendingReconciliation(tenantId: string, query: GetPendingReconQueryDto) {
    const page = Math.max(1, Number(query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
    const skip = (page - 1) * limit;
    const dateFilter = this.buildDateFilter(query.startDate, query.endDate);
    const typeFilter =
      query.type === 'STK'
        ? MpesaTxType.STK_PUSH
        : query.type === 'B2C'
          ? MpesaTxType.B2C
          : undefined;

    const where = {
      tenantId,
      status: TransactionStatus.RECON_PENDING,
      transactionId: null, // only unlinked transactions need matching
      ...(typeFilter && { type: typeFilter }),
      ...(dateFilter && { createdAt: dateFilter }),
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
    ]);

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
        startDate: query.startDate,
        endDate: query.endDate,
        type: query.type,
      },
    };
  }

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
        const dup = await tx.transaction.findUnique({ where: { reference } });
        if (dup) {
          resultTxId = dup.id;
          balanceBefore = new Decimal(dup.balanceBefore.toString());
          balanceAfter = new Decimal(dup.balanceAfter.toString());
          return;
        }

        const freshAccount = await tx.account.findUnique({
          where: { id: accountId },
          select: { balance: true },
        });
        if (!freshAccount) throw new NotFoundException(`Account ${accountId} disappeared during transaction`);

        balanceBefore = new Decimal(freshAccount.balance.toString());
        balanceAfter = balanceBefore.plus(amount);

        const ledgerTx = await tx.transaction.create({
          data: {
            tenantId,
            accountId,
            type: TransactionType.DEPOSIT,
            status: TransactionStatus.COMPLETED,
            amount: amount.toDecimalPlaces(4).toString(),
            balanceBefore: balanceBefore.toDecimalPlaces(4).toString(),
            balanceAfter: balanceAfter.toDecimalPlaces(4).toString(),
            reference,
            description: `Manual M-Pesa reconciliation – receipt ${mpesaTx.mpesaReceiptNumber ?? mpesaTxId} – ${noteText}`,
            processedBy: actorId,
          },
        });

        await tx.account.update({
          where: { id: accountId },
          data: { balance: balanceAfter.toDecimalPlaces(4).toString() },
        });

        await tx.mpesaTransaction.update({
          where: { id: mpesaTxId },
          data: {
            transactionId: ledgerTx.id,
            memberId: mpesaTx.memberId ?? account.member.id,
            status: TransactionStatus.COMPLETED,
            resultDesc: `Manually reconciled – ${noteText}`,
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
