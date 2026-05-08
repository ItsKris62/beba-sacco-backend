import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { MpesaTxType, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ReconciliationService } from '../financial/reconciliation.service';
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
          checkoutRequestId: true,
          conversationId: true,
          mpesaReceiptNumber: true,
          resultDesc: true,
          createdAt: true,
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
        reference:
          row.transaction?.reference ??
          row.reference ??
          row.checkoutRequestId ??
          row.conversationId ??
          row.id,
        type: row.type === MpesaTxType.STK_PUSH ? 'STK' : row.type,
        amount: new Decimal(row.amount.toString()).toNumber(),
        expectedAmount: row.transaction?.amount
          ? new Decimal(row.transaction.amount.toString()).toNumber()
          : null,
        mpesaReceipt: row.mpesaReceiptNumber,
        createdAt: row.createdAt,
        flagReason: row.resultDesc ?? 'Reconciliation mismatch requires manual review',
        reconciliationStatus: row.status,
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
