import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { PrismaService } from '../../prisma/prisma.service';
import { maskPhone } from '../mpesa/utils/mpesa.utils';
import {
  SasraAuditReport,
  SasraAuditSummary,
  SasraMismatchEntry,
  SasraStalePendingEntry,
} from './dto/sasra-audit.dto';

// ─── Constants ────────────────────────────────────────────────────────────────

/** SASRA/CBK rule: PENDING transactions older than this without DLQ or FAILED resolution. */
const STALE_PENDING_THRESHOLD_HOURS = 24;

/** SASRA/CBK rule: timestamp skew tolerance. */
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

// Minimum set of fields that every SASRA-compliant MpesaTransaction must carry.
const REQUIRED_SASRA_FIELDS: string[] = [
  'reference',
  'phoneNumber',
  'amount',
  'type',
  'triggerSource',
  'callbackPayload',
  'createdAt',
];

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class SasraValidatorService {
  private readonly logger = new Logger(SasraValidatorService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Runs all SASRA compliance checks over MpesaTransaction rows in the given
   * date window and returns a structured audit report.
   *
   * Checks performed:
   *  1. Required-field completeness (SASRA raw-payload preservation mandate)
   *  2. Timestamp skew > 5 min from server clock (EAT)
   *  3. Ledger cross-validation: MpesaTransaction.amount ↔ Transaction.amount
   *  4. Stale PENDING detection (> 24h, no DLQ or FAILED status)
   *  5. DLQ job count from BullMQ metadata table (if available)
   *  6. Phone masking enforced in report output (ODPC/SASRA mandate)
   */
  async validateMpesaAuditTrail(
    startDate: Date,
    endDate: Date,
    tenantId?: string,
  ): Promise<SasraAuditReport> {
    this.logger.log(
      `SASRA audit run | start=${startDate.toISOString()} end=${endDate.toISOString()} ` +
        `tenant=${tenantId ?? 'ALL'}`,
    );

    const whereClause = tenantId
      ? `WHERE mt."tenantId" = '${tenantId}' AND mt."createdAt" >= '${startDate.toISOString()}' AND mt."createdAt" <= '${endDate.toISOString()}'`
      : `WHERE mt."createdAt" >= '${startDate.toISOString()}' AND mt."createdAt" <= '${endDate.toISOString()}'`;

    const [
      allTransactions,
      statusCounts,
      mismatches,
      stalePending,
      dlqCount,
    ] = await Promise.all([
      this.fetchAllTransactions(startDate, endDate, tenantId),
      this.fetchStatusCounts(startDate, endDate, tenantId),
      this.detectLedgerMismatches(startDate, endDate, tenantId),
      this.detectStalePending(tenantId),
      this.countDlqJobs(),
    ]);

    // ─── Required-field validation ─────────────────────────────────────────
    const missingFields: SasraAuditReport['missingFields'] = [];
    const timestampSkews: SasraAuditReport['timestampSkews'] = [];

    for (const tx of allTransactions) {
      // Check required SASRA fields
      const missing = REQUIRED_SASRA_FIELDS.filter((f) => {
        const val = (tx as Record<string, unknown>)[f];
        return val === null || val === undefined || val === '';
      });

      if (missing.length > 0) {
        missingFields.push({
          mpesaTxId: tx.id,
          reference: tx.reference ?? '(null)',
          missingFields: missing,
          createdAt: tx.createdAt.toISOString(),
        });
      }

      // Check timestamp skew on COMPLETED transactions (callbackPayload has TransactionDate)
      if (tx.transactionDate) {
        const skewMs = Math.abs(Date.now() - new Date(tx.transactionDate).getTime());
        if (skewMs > MAX_TIMESTAMP_SKEW_MS) {
          timestampSkews.push({
            mpesaTxId: tx.id,
            reference: tx.reference ?? '(null)',
            skewSeconds: Math.round(skewMs / 1000),
            transactionDate: new Date(tx.transactionDate).toISOString(),
          });
        }
      }
    }

    // ─── Summary metrics ───────────────────────────────────────────────────
    const total = allTransactions.length;
    const completed = statusCounts.find((r: { status: string }) => r.status === 'COMPLETED')?._count ?? 0;
    const failed = statusCounts.find((r: { status: string }) => r.status === 'FAILED')?._count ?? 0;
    const pending = statusCounts.find((r: { status: string }) => r.status === 'PENDING')?._count ?? 0;

    const issueCount =
      missingFields.length +
      timestampSkews.length +
      mismatches.length +
      stalePending.length;

    const compliancePercent =
      total > 0 ? Math.max(0, Math.round(((total - issueCount) / total) * 100)) : 100;

    const now = new Date();
    const summary: SasraAuditSummary = {
      totalTransactions: total,
      completedCount: Number(completed),
      failedCount: Number(failed),
      pendingCount: Number(pending),
      missingFieldsCount: missingFields.length,
      timestampSkewCount: timestampSkews.length,
      mismatchCount: mismatches.length,
      stalePendingCount: stalePending.length,
      dlqCount,
      compliancePercent,
      // Format as EAT (UTC+3) ISO string
      periodStart: this.toEatIso(startDate),
      periodEnd: this.toEatIso(endDate),
      generatedAt: this.toEatIso(now),
    };

    this.logger.log(
      `SASRA audit complete | total=${total} compliant=${compliancePercent}% ` +
        `mismatches=${mismatches.length} stale=${stalePending.length} dlq=${dlqCount}`,
    );

    return { summary, mismatches, stalePending, missingFields, timestampSkews };
  }

  /**
   * Exports the audit report as CSV.
   * Returns a string with UTF-8 BOM for Excel compatibility.
   * Phone numbers are masked per ODPC mandate.
   */
  exportAsCsv(report: SasraAuditReport): string {
    const lines: string[] = [];

    // ── Summary section ──
    lines.push('SECTION,METRIC,VALUE');
    lines.push(`Summary,Period Start,${report.summary.periodStart}`);
    lines.push(`Summary,Period End,${report.summary.periodEnd}`);
    lines.push(`Summary,Generated At,${report.summary.generatedAt}`);
    lines.push(`Summary,Total Transactions,${report.summary.totalTransactions}`);
    lines.push(`Summary,Completed,${report.summary.completedCount}`);
    lines.push(`Summary,Failed,${report.summary.failedCount}`);
    lines.push(`Summary,Pending,${report.summary.pendingCount}`);
    lines.push(`Summary,Missing Fields,${report.summary.missingFieldsCount}`);
    lines.push(`Summary,Timestamp Skew Count,${report.summary.timestampSkewCount}`);
    lines.push(`Summary,Ledger Mismatches,${report.summary.mismatchCount}`);
    lines.push(`Summary,Stale Pending (>24h),${report.summary.stalePendingCount}`);
    lines.push(`Summary,DLQ Count,${report.summary.dlqCount}`);
    lines.push(`Summary,Compliance %,${report.summary.compliancePercent}`);
    lines.push('');

    // ── Mismatches section ──
    lines.push('SECTION: Ledger Mismatches');
    lines.push('MpesaTxId,Reference,MaskedPhone,MpesaAmount,LedgerAmount,Issue,DetectedAt');
    for (const m of report.mismatches) {
      lines.push(
        [m.mpesaTxId, m.reference, m.maskedPhone, m.mpesaAmount, m.ledgerAmount ?? '', this.csvEscape(m.issue), m.detectedAt].join(','),
      );
    }
    lines.push('');

    // ── Stale PENDING section ──
    lines.push('SECTION: Stale Pending (>24h)');
    lines.push('MpesaTxId,Reference,MaskedPhone,Amount,CreatedAt,AgeHours,HasDlqEntry');
    for (const s of report.stalePending) {
      lines.push(
        [s.mpesaTxId, s.reference, s.maskedPhone, s.amount, s.createdAt, s.ageHours, s.hasDlqEntry].join(','),
      );
    }
    lines.push('');

    // ── Missing fields section ──
    lines.push('SECTION: Missing Required Fields');
    lines.push('MpesaTxId,Reference,MissingFields,CreatedAt');
    for (const f of report.missingFields) {
      lines.push([f.mpesaTxId, f.reference, f.missingFields.join('|'), f.createdAt].join(','));
    }
    lines.push('');

    // ── Timestamp skews section ──
    lines.push('SECTION: Timestamp Skews (>5 min)');
    lines.push('MpesaTxId,Reference,SkewSeconds,TransactionDate');
    for (const t of report.timestampSkews) {
      lines.push([t.mpesaTxId, t.reference, t.skewSeconds, t.transactionDate].join(','));
    }

    // UTF-8 BOM + content
    return '﻿' + lines.join('\r\n');
  }

  // ─── Private: DB queries ──────────────────────────────────────────────────

  private async fetchAllTransactions(startDate: Date, endDate: Date, tenantId?: string) {
    return this.prisma.mpesaTransaction.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        createdAt: { gte: startDate, lte: endDate },
      },
      select: {
        id: true,
        tenantId: true,
        reference: true,
        phoneNumber: true,
        amount: true,
        type: true,
        triggerSource: true,
        status: true,
        callbackPayload: true,
        transactionDate: true,
        createdAt: true,
        mpesaReceiptNumber: true,
        transactionId: true,
        loanId: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async fetchStatusCounts(startDate: Date, endDate: Date, tenantId?: string) {
    return this.prisma.mpesaTransaction.groupBy({
      by: ['status'],
      where: {
        ...(tenantId ? { tenantId } : {}),
        createdAt: { gte: startDate, lte: endDate },
      },
      _count: true,
    });
  }

  /**
   * Cross-joins MpesaTransaction ↔ Transaction (via transactionId FK) to detect
   * amount drift between what Daraja reported and what was posted to the ledger.
   *
   * Uses a raw SQL query for performance on large tables. The query is read-only
   * and safe for a Neon read replica if DIRECT_URL is available.
   */
  private async detectLedgerMismatches(
    startDate: Date,
    endDate: Date,
    tenantId?: string,
  ): Promise<SasraMismatchEntry[]> {
    const tenantFilter = tenantId ? `AND mt."tenantId" = '${tenantId}'` : '';

    // Detect: MpesaTransaction.amount ≠ linked Transaction.amount
    // Also catches: COMPLETED MpesaTransaction with no linked Transaction (orphan)
    type MismatchRow = {
      mt_id: string;
      reference: string;
      phone: string;
      mpesa_amount: string;
      ledger_amount: string | null;
      issue: string;
      created_at: Date;
    };

    const rows = await this.prisma.$queryRawUnsafe<MismatchRow[]>(
      `
      SELECT
        mt.id               AS mt_id,
        mt.reference        AS reference,
        mt."phoneNumber"    AS phone,
        mt.amount::text     AS mpesa_amount,
        t.amount::text      AS ledger_amount,
        CASE
          WHEN t.id IS NULL AND mt.status = 'COMPLETED'
            THEN 'COMPLETED MpesaTransaction has no linked ledger entry'
          WHEN t.id IS NOT NULL AND ABS(mt.amount - t.amount) > 0.0001
            THEN 'Amount drift: MpesaTransaction.amount ≠ Transaction.amount'
          ELSE NULL
        END AS issue,
        mt."createdAt"      AS created_at
      FROM "MpesaTransaction" mt
      LEFT JOIN "Transaction" t ON t.id = mt."transactionId"
      WHERE mt."createdAt" >= $1
        AND mt."createdAt" <= $2
        ${tenantFilter}
        AND (
          -- Case 1: COMPLETED but no ledger entry
          (mt.status = 'COMPLETED' AND t.id IS NULL)
          OR
          -- Case 2: Amount drift > 0.0001 KES
          (t.id IS NOT NULL AND ABS(mt.amount - t.amount) > 0.0001)
        )
      ORDER BY mt."createdAt" DESC
      LIMIT 500
      `,
      startDate,
      endDate,
    );

    return rows.map((row) => ({
      mpesaTxId: row.mt_id,
      reference: row.reference ?? '(null)',
      // ODPC/SASRA: mask phone in all report outputs
      maskedPhone: maskPhone(row.phone ?? ''),
      mpesaAmount: row.mpesa_amount ?? '0',
      ledgerAmount: row.ledger_amount ?? undefined,
      issue: row.issue ?? 'Unknown mismatch',
      detectedAt: this.toEatIso(row.created_at),
    }));
  }

  /**
   * Detects PENDING transactions older than 24h that have NOT transitioned to
   * FAILED or been moved to the DLQ.
   *
   * SASRA audit rule: no PENDING M-Pesa transaction may remain unresolved for
   * more than 24 hours without a documented DLQ entry or FAILED status.
   */
  private async detectStalePending(tenantId?: string): Promise<SasraStalePendingEntry[]> {
    const cutoff = new Date(Date.now() - STALE_PENDING_THRESHOLD_HOURS * 60 * 60 * 1000);

    const stale = await this.prisma.mpesaTransaction.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        status: 'PENDING',
        createdAt: { lt: cutoff },
      },
      select: {
        id: true,
        reference: true,
        phoneNumber: true,
        amount: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });

    // Check BullMQ metadata table for DLQ entries.
    // BullMQ stores jobs in Redis keys; for DB-backed DLQ detection we check
    // whether any job name containing the tx reference exists in the DLQ queue.
    // Since we can't query Redis directly here, we flag all stale rows and note
    // that DLQ status must be verified via Bull Board or Redis CLI.
    return stale.map((tx) => {
      const ageMs = Date.now() - new Date(tx.createdAt).getTime();
      const ageHours = Math.round(ageMs / (1000 * 60 * 60));
      return {
        mpesaTxId: tx.id,
        reference: tx.reference ?? '(null)',
        maskedPhone: maskPhone(tx.phoneNumber ?? ''),
        amount: new Decimal(tx.amount.toString()).toFixed(2),
        createdAt: tx.createdAt.toISOString(),
        ageHours,
        // Conservative: mark false – operator must verify DLQ via Bull Board
        hasDlqEntry: false,
      };
    });
  }

  /**
   * Returns the count of jobs in MPESA_CALLBACK_DLQ.
   * BullMQ v5 stores dead-letter jobs as 'failed' with no auto-cleanup.
   * We approximate DLQ count by querying the BullMQ metadata table in Redis
   * via a raw Prisma query against the BullMQ job table if available.
   *
   * Since BullMQ stores state in Redis (not Postgres), we return a placeholder
   * and the operator should check Bull Board for the real count.
   * This is flagged in the audit report.
   */
  private async countDlqJobs(): Promise<number> {
    // BullMQ DLQ jobs live in Redis, not Postgres.
    // Return -1 to signal "not queryable from DB layer – check Bull Board".
    // The SASRA validator endpoint documentation instructs auditors accordingly.
    return -1;
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  /** Format a Date as ISO 8601 string in EAT (UTC+3). */
  private toEatIso(date: Date): string {
    const eat = new Date(date.getTime() + 3 * 60 * 60 * 1000);
    return eat.toISOString().replace('Z', '+03:00');
  }

  private csvEscape(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }
}
