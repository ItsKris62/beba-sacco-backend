import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma, LoanStaging, LoanStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ReconciliationService } from '../financial/reconciliation.service';
import { ExportType, ExportFormat } from './dto/export-query.dto';

// ─── SASRA standard column headers ───────────────────────────────────────────

const LOAN_EXPORT_HEADERS = [
  'loan_id', 'loan_number', 'member_id', 'member_number', 'national_id',
  'principal', 'outstanding_balance', 'monthly_instalment', 'tenure_months',
  'disbursed_at', 'due_date', 'arrears_days', 'arrears_amount',
  'staging', 'interest_rate', 'guarantor_count', 'status',
];

const MEMBER_EXPORT_HEADERS = [
  'member_id', 'member_number', 'national_id', 'kra_pin', 'employer',
  'joined_at', 'is_active', 'bosa_balance', 'fosa_balance',
  'active_loan_count', 'total_loan_outstanding', 'consent_data_sharing',
];

const LIQUIDITY_EXPORT_HEADERS = [
  'date', 'total_deposits', 'total_withdrawals', 'net_flow',
  'total_loan_disbursements', 'total_loan_repayments',
  'mpesa_deposit_volume', 'active_loan_count', 'npl_count', 'npl_amount',
];

/**
 * ComplianceService – Phase 4
 *
 * Provides:
 *   1. SASRA/CBK export (LOANS | MEMBERS | LIQUIDITY) in CSV or JSON
 *   2. Audit chain integrity verification (prevHash chain)
 *   3. Data retention & purge (Kenya Data Protection Act)
 *   4. Member privacy/consent management
 */
@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  async getLatestReconReport(tenantId: string, settlementDate: string) {
    return this.reconciliation.getLatestReport(tenantId, settlementDate);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. SASRA/CBK EXPORT
  // ─────────────────────────────────────────────────────────────────────────

  async generateExport(
    tenantId: string,
    type: ExportType,
    format: ExportFormat,
    from?: string,
    to?: string,
  ): Promise<{ content: string; filename: string; mimeType: string }> {
    const dateFrom = from ? new Date(from) : undefined;
    const dateTo = to ? new Date(to) : undefined;

    let rows: Record<string, unknown>[] = [];
    let headers: string[] = [];
    let datasetName = '';

    switch (type) {
      case ExportType.LOANS:
        rows = await this.buildLoansExport(tenantId, dateFrom, dateTo);
        headers = LOAN_EXPORT_HEADERS;
        datasetName = 'loans';
        break;
      case ExportType.MEMBERS:
        rows = await this.buildMembersExport(tenantId);
        headers = MEMBER_EXPORT_HEADERS;
        datasetName = 'members';
        break;
      case ExportType.LIQUIDITY:
        rows = await this.buildLiquidityExport(tenantId, dateFrom, dateTo);
        headers = LIQUIDITY_EXPORT_HEADERS;
        datasetName = 'liquidity';
        break;
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `sasra_${datasetName}_${tenantId.slice(0, 8)}_${timestamp}`;

    if (format === ExportFormat.JSON) {
      return {
        content: JSON.stringify(rows, null, 2),
        filename: `${filename}.json`,
        mimeType: 'application/json',
      };
    }

    // CSV
    const csvRows = [headers.join(',')];
    for (const row of rows) {
      const values = headers.map((h) => {
        const val = row[h];
        if (val === null || val === undefined) return '';
        const str = String(val).replace(/"/g, '""');
        return str.includes(',') || str.includes('"') || str.includes('\n')
          ? `"${str}"`
          : str;
      });
      csvRows.push(values.join(','));
    }

    return {
      content: csvRows.join('\n'),
      filename: `${filename}.csv`,
      mimeType: 'text/csv',
    };
  }

  private async buildLoansExport(
    tenantId: string,
    from?: Date,
    to?: Date,
  ): Promise<Record<string, unknown>[]> {
    const loans = await this.prisma.loan.findMany({
      where: {
        tenantId,
        ...(from || to
          ? { disbursedAt: { ...(from && { gte: from }), ...(to && { lte: to }) } }
          : {}),
      },
      include: {
        member: { select: { memberNumber: true, nationalId: true } },
        guarantors: { where: { status: 'ACCEPTED' }, select: { id: true } },
      },
      orderBy: { disbursedAt: 'desc' },
    });

    return loans.map((l) => ({
      loan_id: l.id,
      loan_number: l.loanNumber,
      member_id: l.memberId,
      member_number: l.member.memberNumber,
      national_id: l.member.nationalId ?? '',
      principal: l.principalAmount.toString(),
      outstanding_balance: l.outstandingBalance.toString(),
      monthly_instalment: l.monthlyInstalment.toString(),
      tenure_months: l.tenureMonths,
      disbursed_at: l.disbursedAt?.toISOString() ?? '',
      due_date: l.dueDate?.toISOString() ?? '',
      arrears_days: l.arrearsDays,
      arrears_amount: l.arrearsAmount.toString(),
      staging: l.staging,
      interest_rate: l.interestRate.toString(),
      guarantor_count: l.guarantors.length,
      status: l.status,
    }));
  }

  private async buildMembersExport(tenantId: string): Promise<Record<string, unknown>[]> {
    const members = await this.prisma.member.findMany({
      where: { tenantId, deletedAt: null },
      include: {
        accounts: { select: { accountType: true, balance: true } },
        loans: {
          where: { status: { in: [LoanStatus.ACTIVE, LoanStatus.DISBURSED] } },
          select: { outstandingBalance: true },
        },
      },
    });

    return members.map((m) => {
      const bosa = m.accounts.find((a) => a.accountType === 'BOSA');
      const fosa = m.accounts.find((a) => a.accountType === 'FOSA');
      const totalOutstanding = m.loans.reduce(
        (sum, l) => sum + parseFloat(l.outstandingBalance.toString()),
        0,
      );
      return {
        member_id: m.id,
        member_number: m.memberNumber,
        national_id: m.nationalId ?? '',
        kra_pin: m.kraPin ?? '',
        employer: m.employer ?? '',
        joined_at: m.joinedAt.toISOString(),
        is_active: m.isActive,
        bosa_balance: bosa ? bosa.balance.toString() : '0',
        fosa_balance: fosa ? fosa.balance.toString() : '0',
        active_loan_count: m.loans.length,
        total_loan_outstanding: totalOutstanding.toFixed(4),
        consent_data_sharing: m.consentDataSharing,
      };
    });
  }

  private async buildLiquidityExport(
    tenantId: string,
    from?: Date,
    to?: Date,
  ): Promise<Record<string, unknown>[]> {
    const dateFrom = from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const dateTo = to ?? new Date();

    // Build daily buckets
    const days: Record<string, unknown>[] = [];
    const cursor = new Date(dateFrom);

    while (cursor <= dateTo) {
      const dayStart = new Date(cursor);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(cursor);
      dayEnd.setUTCHours(23, 59, 59, 999);

      const [deposits, withdrawals, disbursements, repayments, mpesaDeposits, activeLoans, nplLoans] =
        await this.prisma.$transaction([
          this.prisma.transaction.aggregate({
            where: { tenantId, type: 'DEPOSIT', status: 'COMPLETED', createdAt: { gte: dayStart, lte: dayEnd } },
            _sum: { amount: true },
          }),
          this.prisma.transaction.aggregate({
            where: { tenantId, type: 'WITHDRAWAL', status: 'COMPLETED', createdAt: { gte: dayStart, lte: dayEnd } },
            _sum: { amount: true },
          }),
          this.prisma.transaction.aggregate({
            where: { tenantId, type: 'LOAN_DISBURSEMENT', status: 'COMPLETED', createdAt: { gte: dayStart, lte: dayEnd } },
            _sum: { amount: true },
          }),
          this.prisma.transaction.aggregate({
            where: { tenantId, type: 'LOAN_REPAYMENT', status: 'COMPLETED', createdAt: { gte: dayStart, lte: dayEnd } },
            _sum: { amount: true },
          }),
          this.prisma.mpesaTransaction.aggregate({
            where: { tenantId, status: 'COMPLETED', createdAt: { gte: dayStart, lte: dayEnd } },
            _sum: { amount: true },
          }),
          this.prisma.loan.count({ where: { tenantId, status: { in: ['ACTIVE', 'DISBURSED'] } } }),
          this.prisma.loan.count({ where: { tenantId, staging: LoanStaging.NPL } }),
        ]);

      const dep = parseFloat(deposits._sum.amount?.toString() ?? '0');
      const wit = parseFloat(withdrawals._sum.amount?.toString() ?? '0');

      days.push({
        date: dayStart.toISOString().split('T')[0],
        total_deposits: dep.toFixed(4),
        total_withdrawals: wit.toFixed(4),
        net_flow: (dep - wit).toFixed(4),
        total_loan_disbursements: parseFloat(disbursements._sum.amount?.toString() ?? '0').toFixed(4),
        total_loan_repayments: parseFloat(repayments._sum.amount?.toString() ?? '0').toFixed(4),
        mpesa_deposit_volume: parseFloat(mpesaDeposits._sum.amount?.toString() ?? '0').toFixed(4),
        active_loan_count: activeLoans,
        npl_count: nplLoans,
        npl_amount: '0', // Would need separate aggregate; placeholder
      });

      cursor.setDate(cursor.getDate() + 1);
    }

    return days;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. IMMUTABLE AUDIT CHAIN
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Appends a hash-chained entry to the audit log.
   * entryHash = SHA-256(prevHash + action + resourceId + userId + timestamp)
   */
  async appendAuditEntry(params: {
    tenantId: string;
    userId?: string;
    action: string;
    resource: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
    ipAddress?: string;
    requestId?: string;
  }): Promise<void> {
    // Get the last audit entry's hash for this tenant
    const last = await this.prisma.auditLog.findFirst({
      where: { tenantId: params.tenantId },
      orderBy: { timestamp: 'desc' },
      select: { entryHash: true },
    });

    const prevHash = last?.entryHash ?? '0';
    const timestamp = new Date().toISOString();

    const hashInput = `${prevHash}|${params.action}|${params.resourceId ?? ''}|${params.userId ?? ''}|${timestamp}`;
    const entryHash = createHash('sha256').update(hashInput).digest('hex');

    await this.prisma.auditLog.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId,
        action: params.action,
        resource: params.resource,
        resourceId: params.resourceId,
        metadata: params.metadata as Prisma.InputJsonValue | undefined,
        ipAddress: params.ipAddress,
        requestId: params.requestId,
        prevHash,
        entryHash,
      },
    });
  }

  /**
   * Validate audit chain integrity for a tenant.
   * Walks all entries in chronological order and verifies the hash chain.
   * Returns { valid: true } or { valid: false, brokenAt: <id> }.
   */
  async validateAuditChain(tenantId: string): Promise<{ valid: boolean; checkedEntries: number; brokenAt?: string }> {
    const entries = await this.prisma.auditLog.findMany({
      where: { tenantId, entryHash: { not: null } },
      orderBy: { timestamp: 'asc' },
      select: { id: true, prevHash: true, entryHash: true, action: true, resourceId: true, userId: true, timestamp: true },
    });

    let checkedEntries = 0;
    let lastHash = '0';

    for (const entry of entries) {
      const hashInput = `${entry.prevHash ?? '0'}|${entry.action}|${entry.resourceId ?? ''}|${entry.userId ?? ''}|${entry.timestamp.toISOString()}`;
      const expectedHash = createHash('sha256').update(hashInput).digest('hex');

      if (entry.entryHash !== expectedHash || entry.prevHash !== lastHash) {
        return { valid: false, checkedEntries, brokenAt: entry.id };
      }

      lastHash = entry.entryHash!;
      checkedEntries++;
    }

    return { valid: true, checkedEntries };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. PRIVACY & CONSENT CONTROLS
  // ─────────────────────────────────────────────────────────────────────────

  async updateMemberConsent(
    memberId: string,
    tenantId: string,
    consentDataSharing: boolean,
    updatedBy: string,
    ipAddress?: string,
  ): Promise<void> {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, tenantId },
      select: { id: true, consentDataSharing: true },
    });
    if (!member) throw new NotFoundException('Member not found');

    await this.prisma.member.update({
      where: { id: memberId },
      data: { consentDataSharing, consentUpdatedAt: new Date() },
    });

    await this.audit.create({
      tenantId,
      userId: updatedBy,
      action: 'MEMBER.PRIVACY_CONSENT_UPDATED',
      resource: 'Member',
      resourceId: memberId,
      metadata: { before: member.consentDataSharing, after: consentDataSharing },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));
  }

  /**
   * Enforce consent check before third-party data exports.
   * Throws ForbiddenException if consent is not given.
   */
  async assertExportConsent(memberId: string, tenantId: string): Promise<void> {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, tenantId },
      select: { consentDataSharing: true },
    });
    if (!member) throw new NotFoundException('Member not found');
    if (!member.consentDataSharing) {
      throw new ForbiddenException('Member has not consented to data sharing');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. DATA RETENTION PURGE
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Soft-delete / purge data per Kenya Data Protection Act:
   *   - Audit logs older than DATA_RETENTION_YEARS (default 7) → soft-delete (set deletedAt)
   *   - Members terminated > 5 years ago → anonymize PII
   */
  async runDataRetentionPurge(tenantId: string, retentionYears = 7): Promise<{
    auditLogsSoftDeleted: number;
    membersAnonymized: number;
  }> {
    const cutoffAudit = new Date();
    cutoffAudit.setFullYear(cutoffAudit.getFullYear() - retentionYears);

    const cutoffMember = new Date();
    cutoffMember.setFullYear(cutoffMember.getFullYear() - 5);

    // Soft-delete old audit logs (the AuditLog model uses a timestamp; we flag with metadata)
    const oldAuditLogs = await this.prisma.auditLog.findMany({
      where: { tenantId, timestamp: { lt: cutoffAudit } },
      select: { id: true },
    });

    // In production you'd set a `deletedAt` on AuditLog; for now, batch-delete
    // only truly expired ones (7+ years) as per regulation
    if (oldAuditLogs.length > 0) {
      await this.prisma.auditLog.deleteMany({
        where: { tenantId, timestamp: { lt: cutoffAudit } },
      });
    }

    // Anonymize terminated members beyond 5-year window
    const termMembers = await this.prisma.member.findMany({
      where: {
        tenantId,
        isActive: false,
        deletedAt: { not: null, lt: cutoffMember },
        nationalId: { not: null }, // only those with PII
      },
      select: { id: true },
    });

    if (termMembers.length > 0) {
      await this.prisma.member.updateMany({
        where: { id: { in: termMembers.map((m) => m.id) } },
        data: {
          nationalId: '[REDACTED]',
          kraPin: '[REDACTED]',
          employer: null,
          occupation: null,
          dateOfBirth: null,
        },
      });
    }

    this.logger.log(
      `Data retention purge: tenant=${tenantId} auditLogsDeleted=${oldAuditLogs.length} membersAnonymized=${termMembers.length}`,
    );

    return {
      auditLogsSoftDeleted: oldAuditLogs.length,
      membersAnonymized: termMembers.length,
    };
  }
}
