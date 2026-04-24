import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';

export interface MemberFeatureVector {
  memberId: string;
  tenantId: string;
  version: string;
  // Transaction features
  totalDeposits90d: number;
  avgDepositAmount90d: number;
  depositCount90d: number;
  totalWithdrawals90d: number;
  // Loan features
  activeLoanCount: number;
  totalOutstandingBalance: number;
  maxArrearsDays: number;
  hasNplLoan: boolean;
  loanRepaymentRate: number;
  // Guarantor features
  guarantorCount: number;
  guarantorRingDetected: boolean;
  // KYC features
  kycComplete: boolean;
  memberAgeDays: number;
  // Risk features
  lastRiskScore: number | null;
  amlStatus: string | null;
}

/**
 * ML Feature Store Service – Phase 6
 *
 * Aggregates member feature vectors for offline ML model training.
 * Exports versioned datasets to MinIO/S3 in JSON/CSV format.
 *
 * Storage path: `feature-store/{tenantId}/{version}/features.json`
 */
@Injectable()
export class FeatureStoreService {
  private readonly logger = new Logger(FeatureStoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async buildFeatureVector(
    tenantId: string,
    memberId: string,
  ): Promise<MemberFeatureVector> {
    const version = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const [member, account, loans, guarantors, lastRisk, amlScreening] = await Promise.all([
      this.prisma.member.findUnique({ where: { id: memberId } }),
      this.prisma.account.findFirst({ where: { tenantId, memberId, isActive: true } }),
      this.prisma.loan.findMany({
        where: { tenantId, memberId },
        select: { status: true, outstandingBalance: true, arrearsDays: true, staging: true, totalRepaid: true, principalAmount: true },
      }),
      this.prisma.guarantor.count({ where: { tenantId, memberId, status: 'ACCEPTED' } }),
      this.prisma.riskScore.findFirst({
        where: { tenantId, memberId },
        orderBy: { evaluatedAt: 'desc' },
        select: { score: true },
      }),
      this.prisma.amlScreening.findFirst({
        where: { tenantId, memberId },
        orderBy: { createdAt: 'desc' },
        select: { status: true },
      }),
    ]);

    // Transaction aggregates
    let txAggregates = { totalDeposits: 0, avgDeposit: 0, depositCount: 0, totalWithdrawals: 0 };
    if (account) {
      const [deposits, withdrawals] = await Promise.all([
        this.prisma.transaction.aggregate({
          where: { tenantId, accountId: account.id, type: 'DEPOSIT', status: 'COMPLETED', createdAt: { gte: ninetyDaysAgo } },
          _sum: { amount: true },
          _avg: { amount: true },
          _count: true,
        }),
        this.prisma.transaction.aggregate({
          where: { tenantId, accountId: account.id, type: 'WITHDRAWAL', status: 'COMPLETED', createdAt: { gte: ninetyDaysAgo } },
          _sum: { amount: true },
        }),
      ]);
      txAggregates = {
        totalDeposits: Number(deposits._sum.amount ?? 0),
        avgDeposit: Number(deposits._avg.amount ?? 0),
        depositCount: deposits._count,
        totalWithdrawals: Number(withdrawals._sum.amount ?? 0),
      };
    }

    const activeLoans = loans.filter((l) => ['ACTIVE', 'DISBURSED'].includes(l.status));
    const totalOutstanding = activeLoans.reduce((s, l) => s + Number(l.outstandingBalance), 0);
    const maxArrears = activeLoans.length > 0 ? Math.max(...activeLoans.map((l) => l.arrearsDays)) : 0;
    const hasNpl = activeLoans.some((l) => l.staging === 'NPL');

    // Repayment rate: totalRepaid / principalAmount across all loans
    const totalRepaid = loans.reduce((s, l) => s + Number(l.totalRepaid), 0);
    const totalPrincipal = loans.reduce((s, l) => s + Number(l.principalAmount), 0);
    const repaymentRate = totalPrincipal > 0 ? totalRepaid / totalPrincipal : 0;

    const memberAgeDays = member
      ? Math.floor((Date.now() - member.joinedAt.getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    return {
      memberId,
      tenantId,
      version,
      totalDeposits90d: txAggregates.totalDeposits,
      avgDepositAmount90d: txAggregates.avgDeposit,
      depositCount90d: txAggregates.depositCount,
      totalWithdrawals90d: txAggregates.totalWithdrawals,
      activeLoanCount: activeLoans.length,
      totalOutstandingBalance: totalOutstanding,
      maxArrearsDays: maxArrears,
      hasNplLoan: hasNpl,
      loanRepaymentRate: Math.round(repaymentRate * 10000) / 100,
      guarantorCount: guarantors,
      guarantorRingDetected: false, // populated by risk scorer
      kycComplete: !!(member?.nationalId && member?.dateOfBirth),
      memberAgeDays,
      lastRiskScore: lastRisk?.score ?? null,
      amlStatus: amlScreening?.status ?? null,
    };
  }

  async exportTenantFeatures(tenantId: string, version: string): Promise<string> {
    this.logger.log(`Building feature store export for tenant ${tenantId} v${version}`);

    const members = await this.prisma.member.findMany({
      where: { tenantId, isActive: true },
      select: { id: true },
    });

    const features: MemberFeatureVector[] = [];
    for (const member of members) {
      try {
        const vector = await this.buildFeatureVector(tenantId, member.id);
        features.push(vector);
      } catch (err) {
        this.logger.warn(`Feature build failed for member ${member.id}: ${(err as Error).message}`);
      }
    }

    const exportData = {
      tenantId,
      version,
      exportedAt: new Date().toISOString(),
      count: features.length,
      features,
    };

    const jsonContent = JSON.stringify(exportData, null, 2);
    const storagePath = `feature-store/${tenantId}/${version}/features.json`;

    // Upload to MinIO/S3
    await this.storage.uploadBuffer(
      storagePath,
      Buffer.from(jsonContent, 'utf-8'),
      'application/json',
    );

    // Persist snapshot records
    for (const f of features) {
      await this.prisma.featureSnapshot.upsert({
        where: { tenantId_memberId_version: { tenantId, memberId: f.memberId, version } },
        create: {
          tenantId,
          memberId: f.memberId,
          version,
          features: f as unknown as Prisma.InputJsonValue,
          exportedAt: new Date(),
          storagePath,
        },
        update: {
          features: f as unknown as Prisma.InputJsonValue,
          exportedAt: new Date(),
          storagePath,
        },
      });
    }

    this.logger.log(`Exported ${features.length} feature vectors to ${storagePath}`);
    return storagePath;
  }
}
