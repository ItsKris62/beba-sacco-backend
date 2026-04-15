import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../../queue/queue.constants';

export interface PolicyRule {
  id: string;
  name: string;
  policy: 'CBK' | 'SASRA' | 'ODPC';
  description: string;
  evaluate: (state: PolicyState) => PolicyViolation | null;
}

export interface PolicyState {
  tenantId: string;
  // SASRA ratios
  liquidityRatio?: number;
  capitalAdequacyRatio?: number;
  nplRatio?: number;
  // CBK limits
  singleBorrowerExposurePct?: number;
  totalCapital?: number;
  // ODPC / data retention
  oldestAuditLogDays?: number;
  // Portfolio
  totalLoans?: number;
  nplAmount?: number;
  totalAssets?: number;
}

export interface PolicyViolation {
  ruleId: string;
  ruleName: string;
  policy: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  message: string;
  remediation: string;
  actualValue?: number;
  threshold?: number;
}

export interface PolicyCheckResult {
  tenantId: string;
  policy: string;
  checkedAt: string;
  violations: PolicyViolation[];
  passed: boolean;
}

/**
 * Policy Engine Service – Phase 6
 *
 * Evaluates CBK/SASRA/ODPC compliance rules against live tenant state.
 * Generates ComplianceAlert records and triggers Alertmanager webhooks
 * on threshold breaches.
 *
 * Rules:
 *  CBK:  single_borrower_exposure < 20% capital
 *  SASRA: liquidity_ratio >= 15%, capital_adequacy >= 10%, npl_ratio < 5%
 *  ODPC: data_retention >= 7 years (2555 days)
 */
@Injectable()
export class PolicyEngineService {
  private readonly logger = new Logger(PolicyEngineService.name);

  private readonly rules: PolicyRule[] = [
    {
      id: 'CBK-001',
      name: 'Single Borrower Exposure',
      policy: 'CBK',
      description: 'Single borrower exposure must not exceed 20% of core capital',
      evaluate: (s) => {
        if (s.singleBorrowerExposurePct === undefined) return null;
        if (s.singleBorrowerExposurePct > 20) {
          return {
            ruleId: 'CBK-001',
            ruleName: 'Single Borrower Exposure',
            policy: 'CBK',
            severity: 'CRITICAL',
            message: `Single borrower exposure ${s.singleBorrowerExposurePct.toFixed(2)}% exceeds 20% CBK limit`,
            remediation: 'Reduce exposure to single borrower or increase core capital',
            actualValue: s.singleBorrowerExposurePct,
            threshold: 20,
          };
        }
        return null;
      },
    },
    {
      id: 'SASRA-001',
      name: 'Liquidity Ratio',
      policy: 'SASRA',
      description: 'Liquidity ratio must be at least 15%',
      evaluate: (s) => {
        if (s.liquidityRatio === undefined) return null;
        if (s.liquidityRatio < 15) {
          return {
            ruleId: 'SASRA-001',
            ruleName: 'Liquidity Ratio',
            policy: 'SASRA',
            severity: s.liquidityRatio < 10 ? 'CRITICAL' : 'WARNING',
            message: `Liquidity ratio ${s.liquidityRatio.toFixed(2)}% is below 15% SASRA minimum`,
            remediation: 'Increase liquid assets or reduce short-term liabilities',
            actualValue: s.liquidityRatio,
            threshold: 15,
          };
        }
        return null;
      },
    },
    {
      id: 'SASRA-002',
      name: 'Capital Adequacy Ratio',
      policy: 'SASRA',
      description: 'Capital adequacy ratio must be at least 10%',
      evaluate: (s) => {
        if (s.capitalAdequacyRatio === undefined) return null;
        if (s.capitalAdequacyRatio < 10) {
          return {
            ruleId: 'SASRA-002',
            ruleName: 'Capital Adequacy Ratio',
            policy: 'SASRA',
            severity: s.capitalAdequacyRatio < 8 ? 'CRITICAL' : 'WARNING',
            message: `Capital adequacy ratio ${s.capitalAdequacyRatio.toFixed(2)}% is below 10% SASRA minimum`,
            remediation: 'Increase core capital through retained earnings or member contributions',
            actualValue: s.capitalAdequacyRatio,
            threshold: 10,
          };
        }
        return null;
      },
    },
    {
      id: 'SASRA-003',
      name: 'NPL Ratio',
      policy: 'SASRA',
      description: 'Non-performing loan ratio must be below 5%',
      evaluate: (s) => {
        if (s.nplRatio === undefined) return null;
        if (s.nplRatio >= 5) {
          return {
            ruleId: 'SASRA-003',
            ruleName: 'NPL Ratio',
            policy: 'SASRA',
            severity: s.nplRatio >= 10 ? 'CRITICAL' : 'WARNING',
            message: `NPL ratio ${s.nplRatio.toFixed(2)}% exceeds 5% SASRA threshold`,
            remediation: 'Intensify loan recovery efforts and review credit underwriting standards',
            actualValue: s.nplRatio,
            threshold: 5,
          };
        }
        return null;
      },
    },
    {
      id: 'ODPC-001',
      name: 'Data Retention',
      policy: 'ODPC',
      description: 'Audit logs must be retained for at least 7 years (2555 days)',
      evaluate: (s) => {
        if (s.oldestAuditLogDays === undefined) return null;
        if (s.oldestAuditLogDays < 2555) {
          return {
            ruleId: 'ODPC-001',
            ruleName: 'Data Retention',
            policy: 'ODPC',
            severity: 'WARNING',
            message: `Oldest audit log is ${s.oldestAuditLogDays} days old; 7-year retention required`,
            remediation: 'Configure audit log archival to ensure 7-year retention per ODPC requirements',
            actualValue: s.oldestAuditLogDays,
            threshold: 2555,
          };
        }
        return null;
      },
    },
  ];

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.COMPLIANCE_CHECK)
    private readonly complianceQueue: Queue,
  ) {}

  async runPolicyCheck(tenantId: string, policyFilter?: string): Promise<PolicyCheckResult[]> {
    const state = await this.buildPolicyState(tenantId);
    const results: PolicyCheckResult[] = [];

    const policies = policyFilter
      ? [policyFilter.toUpperCase()]
      : ['CBK', 'SASRA', 'ODPC'];

    for (const policy of policies) {
      const applicableRules = this.rules.filter((r) => r.policy === policy);
      const violations: PolicyViolation[] = [];

      for (const rule of applicableRules) {
        const violation = rule.evaluate(state);
        if (violation) {
          violations.push(violation);
          // Persist compliance alert
          await this.createAlert(tenantId, violation);
        }
      }

      results.push({
        tenantId,
        policy,
        checkedAt: new Date().toISOString(),
        violations,
        passed: violations.length === 0,
      });
    }

    this.logger.log(
      `Policy check for tenant ${tenantId}: ${results.flatMap((r) => r.violations).length} violations`,
    );

    return results;
  }

  private async buildPolicyState(tenantId: string): Promise<PolicyState> {
    const [latestSasra, maxBorrower, oldestLog] = await Promise.all([
      this.prisma.sasraRatioSnapshot.findFirst({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
      }),
      // Single borrower exposure: max outstanding balance / total capital
      this.prisma.loan.aggregate({
        where: { tenantId, status: { in: ['ACTIVE', 'DISBURSED'] } },
        _max: { outstandingBalance: true },
        _sum: { outstandingBalance: true },
      }),
      this.prisma.auditLog.findFirst({
        where: { tenantId },
        orderBy: { timestamp: 'asc' },
        select: { timestamp: true },
      }),
    ]);

    const totalCapital = latestSasra ? Number(latestSasra.coreCapital) : 0;
    const maxExposure = Number(maxBorrower._max.outstandingBalance ?? 0);
    const singleBorrowerExposurePct = totalCapital > 0 ? (maxExposure / totalCapital) * 100 : 0;

    const oldestAuditLogDays = oldestLog
      ? Math.floor((Date.now() - oldestLog.timestamp.getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    return {
      tenantId,
      liquidityRatio: latestSasra ? Number(latestSasra.liquidityRatio) * 100 : undefined,
      capitalAdequacyRatio: latestSasra ? Number(latestSasra.capitalAdequacyRatio) * 100 : undefined,
      nplRatio: latestSasra ? Number(latestSasra.portfolioQualityRatio) * 100 : undefined,
      singleBorrowerExposurePct,
      totalCapital,
      oldestAuditLogDays,
    };
  }

  private async createAlert(tenantId: string, violation: PolicyViolation): Promise<void> {
    await this.prisma.complianceAlert.create({
      data: {
        tenantId,
        policy: violation.ruleId,
        severity: violation.severity,
        status: 'OPEN',
        message: violation.message,
        details: violation as unknown as Record<string, unknown>,
        remediation: violation.remediation,
      },
    });
  }

  /** Schedule hourly compliance checks via BullMQ */
  async scheduleHourlyCheck(tenantId: string): Promise<void> {
    await this.complianceQueue.add(
      'hourly-check',
      { tenantId },
      {
        repeat: { every: 60 * 60 * 1000 }, // 1 hour
        jobId: `compliance:hourly:${tenantId}`,
      },
    );
  }
}
