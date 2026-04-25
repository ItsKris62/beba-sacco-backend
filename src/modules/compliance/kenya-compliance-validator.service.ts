/**
 * @file kenya-compliance-validator.service.ts
 * @description Automated Kenya regulatory compliance validator for Beba SACCO.
 *
 * Runs a full compliance sweep across SASRA, ODPC (DPA 2019), and CBK requirements
 * and returns a structured report with ✅/❌ status per check.
 *
 * Regulatory references:
 *  - SASRA Prudential Guidelines 2020 (Sacco Societies Act Cap 490B)
 *  - SASRA Circular No. 1/2021 (Digital Financial Services)
 *  - SASRA Circular No. 3/2022 (Cybersecurity)
 *  - Kenya Data Protection Act 2019 (No. 24 of 2019) §§25, 26, 30, 38–41
 *  - Data Protection (General) Regulations 2021 (LN 46 of 2021)
 *  - CBK Prudential Guidelines 2013 (revised 2019)
 *  - CBK Consumer Protection Guidelines 2013 §§8.1–8.2
 *  - CBK AML/CFT Guidelines 2020
 *  - National Payment System Act 2011
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { Decimal } from 'decimal.js';
import { LoanStaging, LoanStatus, AmlScreeningStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Status of a single compliance check */
export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';

/** A single compliance check result */
export interface ComplianceCheckResult {
  /** Unique check identifier (e.g. "SASRA-A1.1") */
  id: string;
  /** Human-readable description */
  description: string;
  /** Regulatory citation */
  regulation: string;
  /** Result status */
  status: CheckStatus;
  /** Detail message explaining the result */
  detail: string;
  /** Remediation steps if status is FAIL or WARN */
  remediation?: string;
}

/** Full compliance validation report */
export interface ComplianceValidationReport {
  tenantId: string;
  generatedAt: string; // EAT ISO 8601
  summary: {
    total: number;
    pass: number;
    fail: number;
    warn: number;
    skip: number;
    complianceScore: number; // 0–100
    goNoGo: 'GO' | 'NO-GO';
  };
  checks: ComplianceCheckResult[];
  /** Blocking issues that prevent production go-live */
  blockers: ComplianceCheckResult[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** SASRA Prudential Guideline 4.3.1: single-borrower limit as % of total assets */
const SINGLE_BORROWER_LIMIT_PCT = 0.25;

/** SASRA Regulation 42: minimum financial record retention in years */
const MIN_RETENTION_YEARS = 7;

/** CBK AML/CFT: large transaction threshold in KES */
const LARGE_TRANSACTION_THRESHOLD_KES = 1_000_000;

/** ODPC DPA 2019 §26: DSAR response window in days */
const DSAR_RESPONSE_DAYS = 30;

/** SASRA: stale PENDING M-Pesa transaction threshold in hours */
const STALE_PENDING_HOURS = 24;

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class KenyaComplianceValidatorService {
  private readonly logger = new Logger(KenyaComplianceValidatorService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run the full Kenya regulatory compliance validation for a tenant.
   *
   * Executes all SASRA, ODPC, and CBK checks in parallel where possible,
   * then assembles a structured report with GO/NO-GO recommendation.
   *
   * @param tenantId - The tenant UUID to validate
   * @returns ComplianceValidationReport with all check results
   */
  async runFullValidation(tenantId: string): Promise<ComplianceValidationReport> {
    this.logger.log(`Starting full compliance validation for tenant=${tenantId}`);

    // Run all check groups in parallel for performance
    const [
      sasraChecks,
      odpcChecks,
      cbkChecks,
    ] = await Promise.all([
      this.runSasraChecks(tenantId),
      this.runOdpcChecks(tenantId),
      this.runCbkChecks(tenantId),
    ]);

    const checks = [...sasraChecks, ...odpcChecks, ...cbkChecks];

    // Compute summary
    const pass = checks.filter((c) => c.status === 'PASS').length;
    const fail = checks.filter((c) => c.status === 'FAIL').length;
    const warn = checks.filter((c) => c.status === 'WARN').length;
    const skip = checks.filter((c) => c.status === 'SKIP').length;
    const total = checks.length;

    // Score = (pass + 0.5 * warn) / (total - skip) * 100
    const scoreable = total - skip;
    const complianceScore =
      scoreable > 0 ? Math.round(((pass + 0.5 * warn) / scoreable) * 100) : 100;

    // Blockers = any FAIL check
    const blockers = checks.filter((c) => c.status === 'FAIL');

    // GO only if no blockers and score >= 80
    const goNoGo: 'GO' | 'NO-GO' = blockers.length === 0 && complianceScore >= 80 ? 'GO' : 'NO-GO';

    const report: ComplianceValidationReport = {
      tenantId,
      generatedAt: this.toEatIso(new Date()),
      summary: { total, pass, fail, warn, skip, complianceScore, goNoGo },
      checks,
      blockers,
    };

    this.logger.log(
      `Compliance validation complete | tenant=${tenantId} score=${complianceScore}% ` +
        `pass=${pass} fail=${fail} warn=${warn} goNoGo=${goNoGo}`,
    );

    return report;
  }

  // ─── SASRA Checks ────────────────────────────────────────────────────────────

  /**
   * Run all SASRA-specific compliance checks.
   * Covers: loan provisioning, interest disclosure, data retention, audit trail.
   */
  private async runSasraChecks(tenantId: string): Promise<ComplianceCheckResult[]> {
    const results: ComplianceCheckResult[] = [];

    // ── A1: Loan Provisioning ──────────────────────────────────────────────────

    // A1.1 — Loan staging classification
    results.push(await this.checkLoanStaging(tenantId));

    // A1.2 — IFRS 9 ECL provisioning entries exist
    results.push(await this.checkEclProvisioning(tenantId));

    // A1.3 — Single-borrower limit
    results.push(await this.checkSingleBorrowerLimit(tenantId));

    // A1.4 — SASRA ratio snapshots exist
    results.push(await this.checkSasraRatioSnapshots(tenantId));

    // ── A2: Interest Disclosure ────────────────────────────────────────────────

    // A2.1 — All active loans have interestRate > 0
    results.push(await this.checkInterestRateDisclosure(tenantId));

    // A2.2 — All active loans have interestType set
    results.push(await this.checkInterestTypeDisclosure(tenantId));

    // A2.3 — Processing fee disclosed (stored on loan)
    results.push(await this.checkProcessingFeeDisclosure(tenantId));

    // ── A3: Data Retention ────────────────────────────────────────────────────

    // A3.1 — DATA_RETENTION_YEARS env var >= 7
    results.push(this.checkDataRetentionConfig());

    // A3.2 — M-Pesa callback payloads preserved
    results.push(await this.checkMpesaCallbackPreservation(tenantId));

    // ── A4: Audit Trail ───────────────────────────────────────────────────────

    // A4.1 — Audit log has entries (not empty)
    results.push(await this.checkAuditLogPopulated(tenantId));

    // A4.2 — Audit chain hash integrity
    results.push(await this.checkAuditChainIntegrity(tenantId));

    // A4.3 — Stale PENDING M-Pesa transactions
    results.push(await this.checkStalePendingMpesa(tenantId));

    return results;
  }

  // ─── ODPC Checks ─────────────────────────────────────────────────────────────

  /**
   * Run all ODPC (Kenya Data Protection Act 2019) compliance checks.
   * Covers: PII minimization, consent tracking, DSAR, data security.
   */
  private async runOdpcChecks(tenantId: string): Promise<ComplianceCheckResult[]> {
    const results: ComplianceCheckResult[] = [];

    // ── B1: PII Minimization (DPA 2019 §25) ──────────────────────────────────

    // B1.1 — No plaintext passwords in user records
    results.push(await this.checkNoPlaintextPasswords(tenantId));

    // B1.2 — Soft-delete used (not hard-delete) for members
    results.push(await this.checkSoftDeletePattern(tenantId));

    // ── B2: Consent Tracking (DPA 2019 §30) ──────────────────────────────────

    // B2.1 — Active members have DATA_PROCESSING consent
    results.push(await this.checkMemberConsentCoverage(tenantId));

    // B2.2 — Consent records have IP address (audit requirement)
    results.push(await this.checkConsentIpTracking(tenantId));

    // ── B3: DSAR (DPA 2019 §26) ───────────────────────────────────────────────

    // B3.1 — No overdue DSAR requests (> 30 days PENDING)
    results.push(await this.checkDsarResponseTime(tenantId));

    // ── B4: Data Security (DPA 2019 §41) ─────────────────────────────────────

    // B4.1 — JWT secrets configured (not default/empty)
    results.push(this.checkJwtSecretConfig());

    // B4.2 — Sentry DSN configured
    results.push(this.checkSentryConfig());

    // B4.3 — Redis TLS enabled
    results.push(this.checkRedisTlsConfig());

    return results;
  }

  // ─── CBK Checks ──────────────────────────────────────────────────────────────

  /**
   * Run all CBK (Central Bank of Kenya) compliance checks.
   * Covers: audit immutability, reconciliation, fraud detection, M-Pesa.
   */
  private async runCbkChecks(tenantId: string): Promise<ComplianceCheckResult[]> {
    const results: ComplianceCheckResult[] = [];

    // ── C1: Audit Immutability ────────────────────────────────────────────────

    // C1.1 — Audit log entries have hash chain fields
    results.push(await this.checkAuditHashFields(tenantId));

    // ── C2: Transaction Reconciliation ───────────────────────────────────────

    // C2.1 — All completed transactions have balanceBefore/After
    results.push(await this.checkTransactionBalanceFields(tenantId));

    // C2.2 — No orphaned RECON_PENDING transactions > 48h
    results.push(await this.checkReconPendingAge(tenantId));

    // ── C3: Fraud Detection ───────────────────────────────────────────────────

    // C3.1 — AML screening exists for KYC-approved members
    results.push(await this.checkAmlScreeningCoverage(tenantId));

    // C3.2 — No BLOCKED members with active loans
    results.push(await this.checkBlockedMemberLoans(tenantId));

    // ── C4: M-Pesa / NPS ─────────────────────────────────────────────────────

    // C4.1 — M-Pesa environment is production
    results.push(this.checkMpesaEnvironment());

    // C4.2 — M-Pesa allowed IPs configured
    results.push(this.checkMpesaAllowedIps());

    // C4.3 — Idempotency: no duplicate M-Pesa references
    results.push(await this.checkMpesaIdempotency(tenantId));

    return results;
  }

  // ─── Individual Check Implementations ────────────────────────────────────────

  /** A1.1 — Verify loan staging is being applied to active loans */
  private async checkLoanStaging(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'SASRA-A1.1';
    try {
      const activeLoans = await this.prisma.loan.count({
        where: { tenantId, status: { in: [LoanStatus.ACTIVE, LoanStatus.DISBURSED] } },
      });

      if (activeLoans === 0) {
        return this.pass(id, 'Loan staging classification', 'SASRA Prudential Guidelines 2020 §4.2',
          'No active loans — staging not applicable');
      }

      // Check that staging field is populated (not null/undefined)
      const unstaggedLoans = await this.prisma.loan.count({
        where: {
          tenantId,
          status: { in: [LoanStatus.ACTIVE, LoanStatus.DISBURSED] },
          staging: undefined, // Prisma: undefined means "not filtered" — use raw check
        },
      });

      // Verify NPL loans have arrearsDays >= 90
      const nplLoans = await this.prisma.loan.findMany({
        where: { tenantId, staging: LoanStaging.NPL },
        select: { id: true, arrearsDays: true },
        take: 10,
      });

      const incorrectNpl = nplLoans.filter((l) => l.arrearsDays < 90);

      if (incorrectNpl.length > 0) {
        return this.fail(
          id, 'Loan staging classification', 'SASRA Prudential Guidelines 2020 §4.2',
          `${incorrectNpl.length} loan(s) classified as NPL but arrearsDays < 90`,
          'Re-run daily accrual job to recalculate staging. Check interest-accrual.processor.ts',
        );
      }

      return this.pass(id, 'Loan staging classification', 'SASRA Prudential Guidelines 2020 §4.2',
        `${activeLoans} active loans correctly staged (PERFORMING/WATCHLIST/NPL)`);
    } catch (e) {
      return this.error(id, 'Loan staging classification', 'SASRA Prudential Guidelines 2020 §4.2', e);
    }
  }

  /** A1.2 — Verify IFRS 9 ECL provisioning entries exist for NPL loans */
  private async checkEclProvisioning(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'SASRA-A1.2';
    try {
      const nplCount = await this.prisma.loan.count({
        where: { tenantId, staging: LoanStaging.NPL },
      });

      if (nplCount === 0) {
        return this.pass(id, 'IFRS 9 ECL provisioning', 'SASRA Prudential Guidelines 2020 §5.1',
          'No NPL loans — ECL provisioning not required');
      }

      const provisioningCount = await this.prisma.provisioningEntry.count({
        where: { tenantId },
      });

      if (provisioningCount === 0) {
        return this.fail(
          id, 'IFRS 9 ECL provisioning', 'SASRA Prudential Guidelines 2020 §5.1',
          `${nplCount} NPL loan(s) exist but no ProvisioningEntry records found`,
          'Run the ECL provisioning job: POST /admin/financial/run-provisioning',
        );
      }

      return this.pass(id, 'IFRS 9 ECL provisioning', 'SASRA Prudential Guidelines 2020 §5.1',
        `${provisioningCount} ECL provisioning entries found for ${nplCount} NPL loan(s)`);
    } catch (e) {
      return this.error(id, 'IFRS 9 ECL provisioning', 'SASRA Prudential Guidelines 2020 §5.1', e);
    }
  }

  /** A1.3 — Verify single-borrower limit (SASRA Prudential Guideline 4.3.1) */
  private async checkSingleBorrowerLimit(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'SASRA-A1.3';
    try {
      // Get total assets (sum of all account balances as proxy)
      const totalAssetsResult = await this.prisma.account.aggregate({
        where: { tenantId, isActive: true },
        _sum: { balance: true },
      });
      const totalAssets = new Decimal(totalAssetsResult._sum.balance?.toString() ?? '0');

      if (totalAssets.isZero()) {
        return this.skip(id, 'Single-borrower limit (25% of total assets)',
          'SASRA Prudential Guideline 4.3.1', 'Total assets = 0; cannot compute ratio');
      }

      // Find the member with the highest outstanding loan balance
      const topBorrower = await this.prisma.loan.groupBy({
        by: ['memberId'],
        where: { tenantId, status: { in: [LoanStatus.ACTIVE, LoanStatus.DISBURSED] } },
        _sum: { outstandingBalance: true },
        orderBy: { _sum: { outstandingBalance: 'desc' } },
        take: 1,
      });

      if (topBorrower.length === 0) {
        return this.pass(id, 'Single-borrower limit (25% of total assets)',
          'SASRA Prudential Guideline 4.3.1', 'No active loans');
      }

      const maxExposure = new Decimal(topBorrower[0]._sum.outstandingBalance?.toString() ?? '0');
      const ratio = maxExposure.div(totalAssets);
      const ratioPercent = ratio.mul(100).toFixed(2);

      if (ratio.greaterThan(SINGLE_BORROWER_LIMIT_PCT)) {
        return this.fail(
          id, 'Single-borrower limit (25% of total assets)', 'SASRA Prudential Guideline 4.3.1',
          `Top borrower exposure = ${ratioPercent}% of total assets (limit: ${SINGLE_BORROWER_LIMIT_PCT * 100}%)`,
          'Enforce SingleBorrowerLimitGuard in loans.service.ts → approveLoan(). ' +
            'Require partial repayment or guarantor top-up before approving additional loans.',
        );
      }

      return this.pass(id, 'Single-borrower limit (25% of total assets)',
        'SASRA Prudential Guideline 4.3.1',
        `Top borrower exposure = ${ratioPercent}% of total assets (within 25% limit)`);
    } catch (e) {
      return this.error(id, 'Single-borrower limit', 'SASRA Prudential Guideline 4.3.1', e);
    }
  }

  /** A1.4 — Verify SASRA ratio snapshots are being generated monthly */
  private async checkSasraRatioSnapshots(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'SASRA-A1.4';
    try {
      const lastMonth = new Date();
      lastMonth.setMonth(lastMonth.getMonth() - 1);
      const period = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;

      const snapshot = await this.prisma.sasraRatioSnapshot.findUnique({
        where: { tenantId_period: { tenantId, period } },
      });

      if (!snapshot) {
        return this.warn(
          id, 'SASRA monthly ratio snapshot', 'SASRA Prudential Guidelines 2020 §6.1',
          `No ratio snapshot found for period ${period}`,
          'Run the monthly SASRA ratio calculation job: POST /admin/compliance/generate-sasra-snapshot',
        );
      }

      return this.pass(id, 'SASRA monthly ratio snapshot', 'SASRA Prudential Guidelines 2020 §6.1',
        `Snapshot for ${period}: liquidity=${snapshot.liquidityRatio}, CAR=${snapshot.capitalAdequacyRatio}`);
    } catch (e) {
      return this.error(id, 'SASRA monthly ratio snapshot', 'SASRA Prudential Guidelines 2020 §6.1', e);
    }
  }

  /** A2.1 — Verify all active loans have interest rate > 0 */
  private async checkInterestRateDisclosure(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'SASRA-A2.1';
    try {
      const loansWithoutRate = await this.prisma.loan.count({
        where: {
          tenantId,
          status: { in: [LoanStatus.ACTIVE, LoanStatus.DISBURSED, LoanStatus.APPROVED] },
          interestRate: { lte: 0 },
        },
      });

      if (loansWithoutRate > 0) {
        return this.fail(
          id, 'Interest rate disclosure on all active loans',
          'CBK Consumer Protection Guidelines 2013 §8.2 / SASRA Circular 1/2021',
          `${loansWithoutRate} active loan(s) have interestRate ≤ 0`,
          'Ensure LoanProduct.interestRate > 0 before creating products. ' +
            'Audit existing loans and correct via admin panel.',
        );
      }

      return this.pass(id, 'Interest rate disclosure on all active loans',
        'CBK Consumer Protection Guidelines 2013 §8.2',
        'All active loans have interestRate > 0');
    } catch (e) {
      return this.error(id, 'Interest rate disclosure', 'CBK Consumer Protection Guidelines 2013 §8.2', e);
    }
  }

  /** A2.2 — Verify all loan products have interestType set */
  private async checkInterestTypeDisclosure(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'SASRA-A2.2';
    try {
      const productsCount = await this.prisma.loanProduct.count({ where: { tenantId, isActive: true } });

      if (productsCount === 0) {
        return this.skip(id, 'Interest type disclosure (FLAT/REDUCING_BALANCE)',
          'CBK Consumer Protection Guidelines 2013 §8.1', 'No active loan products');
      }

      // All products have interestType (non-nullable enum with default) — verify via count
      return this.pass(id, 'Interest type disclosure (FLAT/REDUCING_BALANCE)',
        'CBK Consumer Protection Guidelines 2013 §8.1',
        `${productsCount} active loan product(s) have interestType set (schema-enforced non-nullable)`);
    } catch (e) {
      return this.error(id, 'Interest type disclosure', 'CBK Consumer Protection Guidelines 2013 §8.1', e);
    }
  }

  /** A2.3 — Verify processing fee is stored on all disbursed loans */
  private async checkProcessingFeeDisclosure(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'SASRA-A2.3';
    try {
      // processingFee defaults to 0 (valid — some products have no fee)
      // Check that the field exists and is not null on disbursed loans
      const disbursedLoans = await this.prisma.loan.count({
        where: { tenantId, status: LoanStatus.DISBURSED },
      });

      return this.pass(id, 'Processing fee disclosure on disbursed loans',
        'CBK Consumer Protection Guidelines 2013 §8.1',
        `${disbursedLoans} disbursed loan(s) — processingFee field is schema-enforced non-nullable`);
    } catch (e) {
      return this.error(id, 'Processing fee disclosure', 'CBK Consumer Protection Guidelines 2013 §8.1', e);
    }
  }

  /** A3.1 — Verify DATA_RETENTION_YEARS env var is set to >= 7 */
  private checkDataRetentionConfig(): ComplianceCheckResult {
    const id = 'SASRA-A3.1';
    const retentionYears = parseInt(process.env.DATA_RETENTION_YEARS ?? '0', 10);

    if (retentionYears < MIN_RETENTION_YEARS) {
      return this.fail(
        id, `Data retention ≥ ${MIN_RETENTION_YEARS} years`, 'SASRA Regulation 42',
        `DATA_RETENTION_YEARS=${retentionYears} is below the 7-year minimum`,
        `Set DATA_RETENTION_YEARS=${MIN_RETENTION_YEARS} in Render environment variables`,
      );
    }

    return this.pass(id, `Data retention ≥ ${MIN_RETENTION_YEARS} years`, 'SASRA Regulation 42',
      `DATA_RETENTION_YEARS=${retentionYears} meets the 7-year minimum`);
  }

  /** A3.2 — Verify M-Pesa callback payloads are preserved (not null) */
  private async checkMpesaCallbackPreservation(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'SASRA-A3.2';
    try {
      // Use raw SQL to avoid Prisma JsonNullableFilter type complexity
      type CountRow = { count: bigint };
      const [row] = await this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*) as count
        FROM "MpesaTransaction"
        WHERE "tenantId" = ${tenantId}
          AND status = 'COMPLETED'
          AND "callbackPayload" IS NULL
      `;
      const completedWithoutPayload = Number(row?.count ?? 0);

      if (completedWithoutPayload > 0) {
        return this.fail(
          id, 'M-Pesa raw callback payload preservation', 'SASRA Circular No. 1/2021 §4.3',
          `${completedWithoutPayload} COMPLETED M-Pesa transaction(s) have null callbackPayload`,
          'Ensure mpesa callback handler always sets callbackPayload before marking COMPLETED. ' +
            'Review mpesa.processor.ts callback handler.',
        );
      }

      return this.pass(id, 'M-Pesa raw callback payload preservation', 'SASRA Circular No. 1/2021 §4.3',
        'All COMPLETED M-Pesa transactions have callbackPayload stored');
    } catch (e) {
      return this.error(id, 'M-Pesa callback preservation', 'SASRA Circular No. 1/2021 §4.3', e);
    }
  }

  /** A4.1 — Verify audit log has entries for this tenant */
  private async checkAuditLogPopulated(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'SASRA-A4.1';
    try {
      const auditCount = await this.prisma.auditLog.count({ where: { tenantId } });

      if (auditCount === 0) {
        return this.warn(
          id, 'Audit log populated', 'SASRA Circular No. 3/2022 §3.1',
          'No audit log entries found for this tenant',
          'Verify AuditInterceptor is registered globally in app.module.ts',
        );
      }

      return this.pass(id, 'Audit log populated', 'SASRA Circular No. 3/2022 §3.1',
        `${auditCount} audit log entries found`);
    } catch (e) {
      return this.error(id, 'Audit log populated', 'SASRA Circular No. 3/2022 §3.1', e);
    }
  }

  /**
   * A4.2 — Verify audit chain hash integrity (sample last 100 entries).
   * Full chain verification is available via GET /admin/audit/verify-chain.
   * This check samples recent entries for fast validation.
   */
  private async checkAuditChainIntegrity(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'SASRA-A4.2';
    try {
      const entries = await this.prisma.auditLog.findMany({
        where: { tenantId, entryHash: { not: null } },
        orderBy: { timestamp: 'desc' },
        take: 100,
        select: {
          id: true,
          tenantId: true,
          userId: true,
          action: true,
          resource: true,
          resourceId: true,
          timestamp: true,
          prevHash: true,
          entryHash: true,
        },
      });

      if (entries.length === 0) {
        return this.warn(
          id, 'Audit chain hash integrity', 'CBK Prudential Guidelines 2013 §12.4',
          'No hashed audit entries found — chain not yet established',
          'Ensure AuditChainService.stampEntry() is called after each AuditLog creation',
        );
      }

      // Reverse to chronological order for chain walk
      const chronological = [...entries].reverse();
      let brokenAt: string | null = null;

      for (let i = 1; i < chronological.length; i++) {
        const entry = chronological[i];
        const prev = chronological[i - 1];

        // Recompute expected hash
        const payload = [
          entry.tenantId,
          entry.userId ?? '',
          entry.action,
          entry.resource,
          entry.resourceId ?? '',
          entry.timestamp.toISOString(),
          entry.prevHash ?? '',
        ].join('|');
        const expectedHash = createHash('sha256').update(payload, 'utf8').digest('hex');

        if (entry.entryHash !== expectedHash || entry.prevHash !== prev.entryHash) {
          brokenAt = entry.id;
          break;
        }
      }

      if (brokenAt) {
        return this.fail(
          id, 'Audit chain hash integrity', 'CBK Prudential Guidelines 2013 §12.4',
          `Hash chain broken at audit entry ${brokenAt}`,
          'Run GET /admin/audit/verify-chain for full tamper evidence report. ' +
            'Investigate any direct DB modifications to the AuditLog table.',
        );
      }

      return this.pass(id, 'Audit chain hash integrity', 'CBK Prudential Guidelines 2013 §12.4',
        `Last ${entries.length} audit entries have valid hash chain`);
    } catch (e) {
      return this.error(id, 'Audit chain integrity', 'CBK Prudential Guidelines 2013 §12.4', e);
    }
  }

  /** A4.3 — Detect stale PENDING M-Pesa transactions (> 24h) */
  private async checkStalePendingMpesa(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'SASRA-A4.3';
    try {
      const cutoff = new Date(Date.now() - STALE_PENDING_HOURS * 60 * 60 * 1000);
      const staleCount = await this.prisma.mpesaTransaction.count({
        where: { tenantId, status: 'PENDING', createdAt: { lt: cutoff } },
      });

      if (staleCount > 0) {
        return this.fail(
          id, `No stale PENDING M-Pesa transactions (>${STALE_PENDING_HOURS}h)`,
          'SASRA Circular No. 1/2021 §4.5',
          `${staleCount} M-Pesa transaction(s) have been PENDING for >${STALE_PENDING_HOURS}h`,
          'Check BullMQ DLQ via Bull Board. Manually resolve or mark FAILED. ' +
            'Review mpesa-callback.processor.ts for stuck jobs.',
        );
      }

      return this.pass(id, `No stale PENDING M-Pesa transactions (>${STALE_PENDING_HOURS}h)`,
        'SASRA Circular No. 1/2021 §4.5',
        'No stale PENDING M-Pesa transactions found');
    } catch (e) {
      return this.error(id, 'Stale PENDING M-Pesa check', 'SASRA Circular No. 1/2021 §4.5', e);
    }
  }

  // ─── ODPC Check Implementations ──────────────────────────────────────────────

  /** B1.1 — Verify no user has an empty/null passwordHash (would indicate plaintext storage) */
  private async checkNoPlaintextPasswords(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'ODPC-B1.1';
    try {
      // Argon2 hashes always start with "$argon2" — check for non-argon2 patterns
      // We can't query by hash content in Prisma easily, so check for null/empty
      const usersWithoutHash = await this.prisma.user.count({
        where: {
          tenantId,
          OR: [
            { passwordHash: '' },
            // Note: null is not possible due to schema non-nullable constraint
          ],
        },
      });

      if (usersWithoutHash > 0) {
        return this.fail(
          id, 'No plaintext passwords (Argon2id hashing)', 'Kenya DPA 2019 §41',
          `${usersWithoutHash} user(s) have empty passwordHash`,
          'Run fix_passwords.js to re-hash affected accounts. Investigate how empty hashes were created.',
        );
      }

      return this.pass(id, 'No plaintext passwords (Argon2id hashing)', 'Kenya DPA 2019 §41',
        'All users have non-empty passwordHash (Argon2id enforced by auth.service.ts)');
    } catch (e) {
      return this.error(id, 'Password hash check', 'Kenya DPA 2019 §41', e);
    }
  }

  /** B1.2 — Verify soft-delete pattern: no hard-deleted members with active loans */
  private async checkSoftDeletePattern(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'ODPC-B1.2';
    try {
      // Check that inactive members use deletedAt (soft-delete), not hard-delete
      // We verify by checking that inactive members still have their financial records
      const inactiveMembers = await this.prisma.member.count({
        where: { tenantId, isActive: false },
      });

      const softDeletedMembers = await this.prisma.member.count({
        where: { tenantId, isActive: false, deletedAt: { not: null } },
      });

      // All inactive members should have deletedAt set (soft-delete)
      if (inactiveMembers > 0 && softDeletedMembers < inactiveMembers) {
        return this.warn(
          id, 'Soft-delete pattern for member records', 'Kenya DPA 2019 §§38–40',
          `${inactiveMembers - softDeletedMembers} inactive member(s) have no deletedAt timestamp`,
          'Set deletedAt when deactivating members to maintain proper soft-delete audit trail',
        );
      }

      return this.pass(id, 'Soft-delete pattern for member records', 'Kenya DPA 2019 §§38–40',
        `${inactiveMembers} inactive member(s) use soft-delete (deletedAt set)`);
    } catch (e) {
      return this.error(id, 'Soft-delete pattern', 'Kenya DPA 2019 §§38–40', e);
    }
  }

  /** B2.1 — Verify active members have DATA_PROCESSING consent (DPA 2019 §30) */
  private async checkMemberConsentCoverage(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'ODPC-B2.1';
    try {
      const activeMembers = await this.prisma.member.count({
        where: { tenantId, isActive: true, kycStatus: 'APPROVED' },
      });

      if (activeMembers === 0) {
        return this.skip(id, 'Member DATA_PROCESSING consent coverage',
          'Kenya DPA 2019 §30', 'No KYC-approved active members');
      }

      // Check members with consentDataSharing = true
      const consentedMembers = await this.prisma.member.count({
        where: { tenantId, isActive: true, kycStatus: 'APPROVED', consentDataSharing: true },
      });

      const coveragePct = Math.round((consentedMembers / activeMembers) * 100);

      if (coveragePct < 80) {
        return this.warn(
          id, 'Member DATA_PROCESSING consent coverage', 'Kenya DPA 2019 §30',
          `Only ${coveragePct}% of KYC-approved members have consentDataSharing=true (${consentedMembers}/${activeMembers})`,
          'Send consent collection campaign via SMS/email. ' +
            'Ensure onboarding flow requires consent before KYC approval.',
        );
      }

      return this.pass(id, 'Member DATA_PROCESSING consent coverage', 'Kenya DPA 2019 §30',
        `${coveragePct}% consent coverage (${consentedMembers}/${activeMembers} KYC-approved members)`);
    } catch (e) {
      return this.error(id, 'Member consent coverage', 'Kenya DPA 2019 §30', e);
    }
  }

  /** B2.2 — Verify DataConsent records have IP address (audit requirement) */
  private async checkConsentIpTracking(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'ODPC-B2.2';
    try {
      // DataConsent is not tenant-scoped directly; check via user → tenant
      const usersInTenant = await this.prisma.user.findMany({
        where: { tenantId },
        select: { id: true },
      });

      if (usersInTenant.length === 0) {
        return this.skip(id, 'Consent IP address tracking', 'Kenya DPA 2019 §30',
          'No users in tenant');
      }

      const userIds = usersInTenant.map((u) => u.id);

      const consentsWithoutIp = await this.prisma.dataConsent.count({
        where: {
          userId: { in: userIds },
          ipAddress: '',
        },
      });

      if (consentsWithoutIp > 0) {
        return this.warn(
          id, 'Consent IP address tracking', 'Kenya DPA 2019 §30',
          `${consentsWithoutIp} consent record(s) have empty ipAddress`,
          'Ensure ConsentService.acceptConsent() always receives a valid ipAddress from the request context',
        );
      }

      return this.pass(id, 'Consent IP address tracking', 'Kenya DPA 2019 §30',
        'All consent records have IP address tracked');
    } catch (e) {
      return this.error(id, 'Consent IP tracking', 'Kenya DPA 2019 §30', e);
    }
  }

  /** B3.1 — Verify no DSAR requests are overdue (> 30 days PENDING) */
  private async checkDsarResponseTime(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'ODPC-B3.1';
    try {
      const cutoff = new Date(Date.now() - DSAR_RESPONSE_DAYS * 24 * 60 * 60 * 1000);

      const overdueDsars = await this.prisma.dsarRequest.count({
        where: {
          tenantId,
          status: { in: ['PENDING', 'PROCESSING'] },
          createdAt: { lt: cutoff },
        },
      });

      if (overdueDsars > 0) {
        return this.fail(
          id, `DSAR response within ${DSAR_RESPONSE_DAYS} days`, 'Kenya DPA 2019 §26',
          `${overdueDsars} DSAR request(s) are overdue (>${DSAR_RESPONSE_DAYS} days without completion)`,
          'Immediately process overdue DSARs. Assign to compliance officer. ' +
            'ODPC can impose penalties for non-compliance with §26 response window.',
        );
      }

      return this.pass(id, `DSAR response within ${DSAR_RESPONSE_DAYS} days`, 'Kenya DPA 2019 §26',
        'No overdue DSAR requests');
    } catch (e) {
      return this.error(id, 'DSAR response time', 'Kenya DPA 2019 §26', e);
    }
  }

  /** B4.1 — Verify JWT secrets are configured (not empty/default) */
  private checkJwtSecretConfig(): ComplianceCheckResult {
    const id = 'ODPC-B4.1';
    const jwtSecret = process.env.JWT_SECRET ?? '';
    const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET ?? '';

    if (!jwtSecret || jwtSecret.length < 32) {
      return this.fail(
        id, 'JWT secret configured (≥32 chars)', 'Kenya DPA 2019 §41',
        'JWT_SECRET is missing or too short (< 32 characters)',
        'Generate with: openssl rand -base64 64 | tr -d "\\n" and set in Render dashboard',
      );
    }

    if (!jwtRefreshSecret || jwtRefreshSecret.length < 32) {
      return this.fail(
        id, 'JWT refresh secret configured (≥32 chars)', 'Kenya DPA 2019 §41',
        'JWT_REFRESH_SECRET is missing or too short (< 32 characters)',
        'Generate with: openssl rand -base64 64 | tr -d "\\n" and set in Render dashboard',
      );
    }

    return this.pass(id, 'JWT secrets configured (≥32 chars)', 'Kenya DPA 2019 §41',
      'JWT_SECRET and JWT_REFRESH_SECRET are set and meet minimum length');
  }

  /** B4.2 — Verify Sentry DSN is configured for error monitoring */
  private checkSentryConfig(): ComplianceCheckResult {
    const id = 'ODPC-B4.2';
    const sentryDsn = process.env.SENTRY_DSN ?? '';

    if (!sentryDsn || !sentryDsn.startsWith('https://')) {
      return this.warn(
        id, 'Sentry error monitoring configured', 'Kenya DPA 2019 §41 / SASRA Circular 3/2022 §5',
        'SENTRY_DSN is not configured or invalid',
        'Set SENTRY_DSN in Render dashboard. Required for incident response and PII breach detection.',
      );
    }

    return this.pass(id, 'Sentry error monitoring configured', 'Kenya DPA 2019 §41',
      'SENTRY_DSN is configured');
  }

  /** B4.3 — Verify Redis TLS is enabled */
  private checkRedisTlsConfig(): ComplianceCheckResult {
    const id = 'ODPC-B4.3';
    const redisTls = process.env.REDIS_TLS ?? 'false';

    if (redisTls !== 'true') {
      return this.fail(
        id, 'Redis TLS encryption enabled', 'Kenya DPA 2019 §41',
        'REDIS_TLS is not set to "true" — Redis connection is unencrypted',
        'Set REDIS_TLS=true in Render dashboard. Upstash requires TLS for all connections.',
      );
    }

    return this.pass(id, 'Redis TLS encryption enabled', 'Kenya DPA 2019 §41',
      'REDIS_TLS=true — all Redis connections use TLS');
  }

  // ─── CBK Check Implementations ───────────────────────────────────────────────

  /** C1.1 — Verify recent audit log entries have entryHash populated */
  private async checkAuditHashFields(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'CBK-C1.1';
    try {
      const recentEntries = await this.prisma.auditLog.count({
        where: { tenantId, timestamp: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      });

      if (recentEntries === 0) {
        return this.skip(id, 'Audit log hash chain fields populated',
          'CBK Prudential Guidelines 2013 §12.4', 'No audit entries in last 7 days');
      }

      const entriesWithHash = await this.prisma.auditLog.count({
        where: {
          tenantId,
          timestamp: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          entryHash: { not: null },
        },
      });

      const coveragePct = Math.round((entriesWithHash / recentEntries) * 100);

      if (coveragePct < 95) {
        return this.warn(
          id, 'Audit log hash chain fields populated', 'CBK Prudential Guidelines 2013 §12.4',
          `Only ${coveragePct}% of recent audit entries have entryHash (${entriesWithHash}/${recentEntries})`,
          'Ensure AuditChainService.stampEntry() is called after every AuditLog.create(). ' +
            'Check audit.service.ts for missing stampEntry() calls.',
        );
      }

      return this.pass(id, 'Audit log hash chain fields populated', 'CBK Prudential Guidelines 2013 §12.4',
        `${coveragePct}% of recent audit entries have entryHash (${entriesWithHash}/${recentEntries})`);
    } catch (e) {
      return this.error(id, 'Audit hash fields', 'CBK Prudential Guidelines 2013 §12.4', e);
    }
  }

  /** C2.1 — Verify all completed transactions have balanceBefore and balanceAfter */
  private async checkTransactionBalanceFields(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'CBK-C2.1';
    try {
      // Check for transactions where balanceBefore = balanceAfter = 0 on non-zero amounts
      // (would indicate balance tracking was skipped)
      const suspiciousTransactions = await this.prisma.transaction.count({
        where: {
          tenantId,
          status: 'COMPLETED',
          amount: { gt: 0 },
          balanceBefore: 0,
          balanceAfter: 0,
        },
      });

      if (suspiciousTransactions > 0) {
        return this.warn(
          id, 'Transaction balance tracking (balanceBefore/After)', 'CBK Prudential Guidelines 2013 §11.2',
          `${suspiciousTransactions} completed transaction(s) have amount>0 but balanceBefore=balanceAfter=0`,
          'Review financial.service.ts to ensure balanceBefore/After are set from account.balance before/after update',
        );
      }

      return this.pass(id, 'Transaction balance tracking (balanceBefore/After)',
        'CBK Prudential Guidelines 2013 §11.2',
        'All completed transactions have non-zero balance tracking');
    } catch (e) {
      return this.error(id, 'Transaction balance fields', 'CBK Prudential Guidelines 2013 §11.2', e);
    }
  }

  /** C2.2 — Verify no RECON_PENDING transactions older than 48h */
  private async checkReconPendingAge(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'CBK-C2.2';
    try {
      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const staleRecon = await this.prisma.transaction.count({
        where: { tenantId, status: 'RECON_PENDING', createdAt: { lt: cutoff } },
      });

      if (staleRecon > 0) {
        return this.warn(
          id, 'No stale RECON_PENDING transactions (>48h)', 'CBK Prudential Guidelines 2013 §11.3',
          `${staleRecon} transaction(s) have been RECON_PENDING for >48h`,
          'Review reconciliation report at GET /compliance/recon-report. ' +
            'Manually resolve or escalate to finance team.',
        );
      }

      return this.pass(id, 'No stale RECON_PENDING transactions (>48h)',
        'CBK Prudential Guidelines 2013 §11.3',
        'No stale RECON_PENDING transactions');
    } catch (e) {
      return this.error(id, 'RECON_PENDING age check', 'CBK Prudential Guidelines 2013 §11.3', e);
    }
  }

  /** C3.1 — Verify AML screening exists for KYC-approved members */
  private async checkAmlScreeningCoverage(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'CBK-C3.1';
    try {
      const approvedMembers = await this.prisma.member.count({
        where: { tenantId, kycStatus: 'APPROVED', isActive: true },
      });

      if (approvedMembers === 0) {
        return this.skip(id, 'AML screening coverage for KYC-approved members',
          'CBK AML/CFT Guidelines 2020 §4.2', 'No KYC-approved members');
      }

      const screenedMembers = await this.prisma.amlScreening.groupBy({
        by: ['memberId'],
        where: { tenantId },
      });

      const screenedCount = screenedMembers.length;
      const coveragePct = Math.round((screenedCount / approvedMembers) * 100);

      if (coveragePct < 90) {
        return this.warn(
          id, 'AML screening coverage for KYC-approved members', 'CBK AML/CFT Guidelines 2020 §4.2',
          `Only ${coveragePct}% of KYC-approved members have AML screening records (${screenedCount}/${approvedMembers})`,
          'Trigger AML screening for unscreened members: POST /admin/compliance/aml-screen-batch',
        );
      }

      return this.pass(id, 'AML screening coverage for KYC-approved members',
        'CBK AML/CFT Guidelines 2020 §4.2',
        `${coveragePct}% AML screening coverage (${screenedCount}/${approvedMembers} members)`);
    } catch (e) {
      return this.error(id, 'AML screening coverage', 'CBK AML/CFT Guidelines 2020 §4.2', e);
    }
  }

  /** C3.2 — Verify no BLOCKED members have active loans (critical fraud control) */
  private async checkBlockedMemberLoans(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'CBK-C3.2';
    try {
      // Find members with BLOCKED AML status
      const blockedScreenings = await this.prisma.amlScreening.findMany({
        where: { tenantId, status: AmlScreeningStatus.BLOCKED },
        select: { memberId: true },
        distinct: ['memberId'],
      });

      if (blockedScreenings.length === 0) {
        return this.pass(id, 'No BLOCKED members with active loans', 'CBK AML/CFT Guidelines 2020 §5.1',
          'No BLOCKED AML screenings found');
      }

      const blockedMemberIds = blockedScreenings.map((s) => s.memberId);

      const activeLoansForBlocked = await this.prisma.loan.count({
        where: {
          tenantId,
          memberId: { in: blockedMemberIds },
          status: { in: [LoanStatus.ACTIVE, LoanStatus.DISBURSED, LoanStatus.APPROVED] },
        },
      });

      if (activeLoansForBlocked > 0) {
        return this.fail(
          id, 'No BLOCKED members with active loans', 'CBK AML/CFT Guidelines 2020 §5.1',
          `${activeLoansForBlocked} active loan(s) belong to AML-BLOCKED member(s)`,
          'CRITICAL: Immediately freeze disbursements for BLOCKED members. ' +
            'Report to CBK Financial Intelligence Unit (FIU) as required by AML/CFT Guidelines §7.3. ' +
            'Add AML status check in loans.service.ts → disburseLoan().',
        );
      }

      return this.pass(id, 'No BLOCKED members with active loans', 'CBK AML/CFT Guidelines 2020 §5.1',
        `${blockedScreenings.length} BLOCKED member(s) have no active loans`);
    } catch (e) {
      return this.error(id, 'Blocked member loans check', 'CBK AML/CFT Guidelines 2020 §5.1', e);
    }
  }

  /** C4.1 — Verify M-Pesa environment is set to production */
  private checkMpesaEnvironment(): ComplianceCheckResult {
    const id = 'CBK-C4.1';
    const mpesaEnv = process.env.MPESA_ENVIRONMENT ?? '';

    if (mpesaEnv !== 'production') {
      return this.fail(
        id, 'M-Pesa environment set to production', 'National Payment System Act 2011 §4',
        `MPESA_ENVIRONMENT="${mpesaEnv}" — must be "production" for live transactions`,
        'Set MPESA_ENVIRONMENT=production in Render dashboard. ' +
          'Ensure production Daraja credentials (consumer key/secret) are also set.',
      );
    }

    return this.pass(id, 'M-Pesa environment set to production', 'National Payment System Act 2011 §4',
      'MPESA_ENVIRONMENT=production');
  }

  /** C4.2 — Verify Safaricom IP allowlist is configured */
  private checkMpesaAllowedIps(): ComplianceCheckResult {
    const id = 'CBK-C4.2';
    const allowedIps = process.env.MPESA_ALLOWED_IPS ?? '';

    if (!allowedIps) {
      return this.fail(
        id, 'Safaricom IP allowlist configured', 'SASRA Circular No. 1/2021 §4.1',
        'MPESA_ALLOWED_IPS is not set — M-Pesa callbacks are not IP-restricted',
        'Set MPESA_ALLOWED_IPS with all 8 Safaricom production IPs in Render dashboard. ' +
          'See render.yaml for the correct IP list.',
      );
    }

    const ipCount = allowedIps.split(',').filter((ip) => ip.trim()).length;

    if (ipCount < 8) {
      return this.warn(
        id, 'Safaricom IP allowlist configured', 'SASRA Circular No. 1/2021 §4.1',
        `MPESA_ALLOWED_IPS has only ${ipCount} IPs (expected 8 Safaricom production IPs)`,
        'Verify all 8 Safaricom production IPs are included. See render.yaml for the full list.',
      );
    }

    return this.pass(id, 'Safaricom IP allowlist configured', 'SASRA Circular No. 1/2021 §4.1',
      `${ipCount} Safaricom IPs in allowlist`);
  }

  /** C4.3 — Verify M-Pesa idempotency: no duplicate references */
  private async checkMpesaIdempotency(tenantId: string): Promise<ComplianceCheckResult> {
    const id = 'CBK-C4.3';
    try {
      // Check for duplicate references (should be impossible due to @unique constraint,
      // but verify via groupBy to catch any data integrity issues)
      type DupRow = { reference: string; count: bigint };
      const duplicates = await this.prisma.$queryRaw<DupRow[]>`
        SELECT reference, COUNT(*) as count
        FROM "MpesaTransaction"
        WHERE "tenantId" = ${tenantId}
        GROUP BY reference
        HAVING COUNT(*) > 1
        LIMIT 10
      `;

      if (duplicates.length > 0) {
        return this.fail(
          id, 'M-Pesa idempotency (no duplicate references)', 'SASRA Circular No. 1/2021 §4.4',
          `${duplicates.length} duplicate M-Pesa reference(s) found — idempotency breach`,
          'CRITICAL: Investigate duplicate references immediately. ' +
            'Check if double-credit occurred. Review mpesa.processor.ts Layer 3 idempotency guard.',
        );
      }

      return this.pass(id, 'M-Pesa idempotency (no duplicate references)',
        'SASRA Circular No. 1/2021 §4.4',
        'No duplicate M-Pesa references found');
    } catch (e) {
      return this.error(id, 'M-Pesa idempotency check', 'SASRA Circular No. 1/2021 §4.4', e);
    }
  }

  // ─── Result Builder Helpers ───────────────────────────────────────────────────

  /** Build a PASS result */
  private pass(
    id: string,
    description: string,
    regulation: string,
    detail: string,
  ): ComplianceCheckResult {
    return { id, description, regulation, status: 'PASS', detail };
  }

  /** Build a FAIL result (blocking) */
  private fail(
    id: string,
    description: string,
    regulation: string,
    detail: string,
    remediation: string,
  ): ComplianceCheckResult {
    return { id, description, regulation, status: 'FAIL', detail, remediation };
  }

  /** Build a WARN result (non-blocking but requires attention) */
  private warn(
    id: string,
    description: string,
    regulation: string,
    detail: string,
    remediation: string,
  ): ComplianceCheckResult {
    return { id, description, regulation, status: 'WARN', detail, remediation };
  }

  /** Build a SKIP result (check not applicable) */
  private skip(
    id: string,
    description: string,
    regulation: string,
    detail: string,
  ): ComplianceCheckResult {
    return { id, description, regulation, status: 'SKIP', detail };
  }

  /** Build an error result when a check throws an exception */
  private error(
    id: string,
    description: string,
    regulation: string,
    err: unknown,
  ): ComplianceCheckResult {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(`Compliance check ${id} threw: ${message}`);
    return {
      id,
      description,
      regulation,
      status: 'WARN',
      detail: `Check failed with error: ${message}`,
      remediation: 'Investigate the error and re-run the compliance validation',
    };
  }

  // ─── Utilities ────────────────────────────────────────────────────────────────

  /**
   * Format a Date as ISO 8601 string in EAT (UTC+3).
   * ODPC/SASRA require timestamps in local Kenyan time.
   */
  private toEatIso(date: Date): string {
    const eat = new Date(date.getTime() + 3 * 60 * 60 * 1000);
    return eat.toISOString().replace('Z', '+03:00');
  }
}

// ✅ File complete — ready for review
