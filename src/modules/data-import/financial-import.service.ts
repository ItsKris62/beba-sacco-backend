import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RedisService } from '../../common/services/redis.service';
import { Decimal } from '@prisma/client/runtime/library';
import { SavingsType } from '@prisma/client';
import {
  FinancialSheetType,
  FinancialPreviewResponseDto,
  FinancialPreviewRowResult,
  FinancialExecuteResponseDto,
} from './dto/financial-import.dto';

interface RawLoanDisbursementRow {
  idNumber: string;
  memberName: string;
  principal: number;
  disbursedDate: string;
  dueDate: string;
  purpose?: string;
  rowNumber: number;
}

interface RawLoanRepaymentRow {
  idNumber: string;
  dayNumber: number;
  amountPaid: number;
  paymentDate: string;
  method?: string;
  rowNumber: number;
}

interface RawSavingsRow {
  idNumber?: string;
  weekNumber: number;
  amount: number;
  periodDate: string;
  groupName?: string;
  rowNumber: number;
}

interface RawGroupWelfareRow {
  stageName: string;
  weekNumber: number;
  amountCollected: number;
  periodDate: string;
  weeklyTarget?: number;
  rowNumber: number;
}

const DASH_CACHE_KEY = (tenantId: string) => `DASH:STATS:${tenantId}:v1`;

@Injectable()
export class FinancialImportService {
  private readonly logger = new Logger(FinancialImportService.name);
  private readonly FLAT_INTEREST_RATE = 0.06;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly redis: RedisService,
  ) {}

  // ─── Preview ───────────────────────────────────────────────────────────────

  async previewFinancialSheet(
    tenantId: string,
    sheetType: FinancialSheetType,
    rawRows: Record<string, unknown>[],
  ): Promise<FinancialPreviewResponseDto> {
    const rows: FinancialPreviewRowResult[] = [];
    let totalAmount = 0;

    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i];
      const rowNumber = i + 1;
      try {
        const result = await this.validateRow(tenantId, sheetType, raw, rowNumber);
        rows.push(result);
        if (result.status !== 'ERROR') {
          totalAmount += this.extractAmount(sheetType, raw);
        }
      } catch (err) {
        rows.push({
          rowNumber,
          status: 'ERROR',
          message: err instanceof Error ? err.message : 'Unknown error',
          data: raw as Record<string, unknown>,
        });
      }
    }

    return {
      sheetType,
      totalRows: rows.length,
      validRows: rows.filter((r) => r.status === 'VALID').length,
      warningRows: rows.filter((r) => r.status === 'WARNING').length,
      errorRows: rows.filter((r) => r.status === 'ERROR').length,
      rows,
      totalAmount,
    };
  }

  // ─── Execute ───────────────────────────────────────────────────────────────

  async executeFinancialImport(
    tenantId: string,
    initiatedBy: string,
    sheetType: FinancialSheetType,
    rawRows: Record<string, unknown>[],
    importBatchId?: string,
  ): Promise<FinancialExecuteResponseDto> {
    const batchId = importBatchId ?? crypto.randomUUID();
    let loansCreated = 0;
    let repaymentsCreated = 0;
    let savingsCreated = 0;
    let welfareCollectionsCreated = 0;
    let skipped = 0;
    let errors = 0;
    const errorDetails: Array<{ row: number; reason: string }> = [];

    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i];
      const rowNumber = i + 1;

      try {
        switch (sheetType) {
          case FinancialSheetType.LOAN_DISBURSEMENT: {
            const created = await this.upsertLoanDisbursement(
              tenantId,
              raw as unknown as RawLoanDisbursementRow,
              batchId,
            );
            if (created) loansCreated++;
            else skipped++;
            break;
          }
          case FinancialSheetType.LOAN_REPAYMENT: {
            const created = await this.upsertLoanRepayment(
              tenantId,
              raw as unknown as RawLoanRepaymentRow,
              initiatedBy,
            );
            if (created) repaymentsCreated++;
            else skipped++;
            break;
          }
          case FinancialSheetType.SACCO_SAVINGS: {
            const created = await this.upsertSavingsRecord(
              tenantId,
              raw as unknown as RawSavingsRow,
              batchId,
            );
            if (created) savingsCreated++;
            else skipped++;
            break;
          }
          case FinancialSheetType.GROUP_WELFARE: {
            const created = await this.upsertGroupWelfareCollection(
              tenantId,
              raw as unknown as RawGroupWelfareRow,
            );
            if (created) welfareCollectionsCreated++;
            else skipped++;
            break;
          }
        }
      } catch (err) {
        errors++;
        errorDetails.push({
          row: rowNumber,
          reason: err instanceof Error ? err.message : 'Unknown error',
        });
        this.logger.warn(`Row ${rowNumber} failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Invalidate dashboard cache so stats reflect the import
    await this.redis.del(DASH_CACHE_KEY(tenantId));

    await this.auditService.create({
      tenantId,
      userId: initiatedBy,
      action: 'FINANCIAL.IMPORT.EXECUTED',
      resource: 'FinancialImport',
      metadata: {
        sheetType,
        batchId,
        loansCreated,
        repaymentsCreated,
        savingsCreated,
        welfareCollectionsCreated,
        skipped,
        errors,
      },
    });

    return {
      batchId,
      sheetType,
      loansCreated,
      repaymentsCreated,
      savingsCreated,
      welfareCollectionsCreated,
      skipped,
      errors,
      errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
    };
  }

  // ─── Loan Disbursement Upsert ──────────────────────────────────────────────

  private async upsertLoanDisbursement(
    tenantId: string,
    row: RawLoanDisbursementRow,
    batchId: string,
  ): Promise<boolean> {
    const user = await this.prisma.user.findFirst({
      where: { tenantId, idNumber: row.idNumber },
      select: { id: true, member: { select: { id: true } } },
    });

    if (!user?.member) {
      throw new Error(`Member not found for idNumber: ${row.idNumber}`);
    }

    const memberId = user.member.id;
    const principal = new Decimal(row.principal);
    const totalRepayable = principal.mul(new Decimal(1 + this.FLAT_INTEREST_RATE));

    let loanProduct = await this.prisma.loanProduct.findFirst({
      where: { tenantId, name: 'CSV Import Product' },
    });

    if (!loanProduct) {
      loanProduct = await this.prisma.loanProduct.create({
        data: {
          tenantId,
          name: 'CSV Import Product',
          minAmount: new Decimal(0),
          maxAmount: new Decimal(9999999),
          interestRate: new Decimal(0.06),
          interestType: 'FLAT',
          maxTenureMonths: 1,
          processingFeeRate: new Decimal(0),
        },
      });
    }

    const loanCount = await this.prisma.loan.count({ where: { tenantId } });
    const loanNumber = `LN-CSV-${String(loanCount + 1).padStart(6, '0')}`;

    const existing = await this.prisma.loan.findFirst({
      where: {
        tenantId,
        memberId,
        principalAmount: principal,
        disbursedAt: new Date(row.disbursedDate),
      },
    });

    if (existing) return false;

    await this.prisma.loan.create({
      data: {
        tenantId,
        memberId,
        loanProductId: loanProduct.id,
        loanNumber,
        status: 'DISBURSED',
        principalAmount: principal,
        interestRate: new Decimal(this.FLAT_INTEREST_RATE),
        processingFee: new Decimal(0),
        tenureMonths: 1,
        monthlyInstalment: totalRepayable,
        outstandingBalance: totalRepayable,
        totalRepaid: new Decimal(0),
        disbursedAt: new Date(row.disbursedDate),
        dueDate: new Date(row.dueDate),
        purpose: row.purpose ?? 'CSV Import',
        notes: `Imported via batch ${batchId}`,
      },
    });

    return true;
  }

  // ─── Loan Repayment Upsert ─────────────────────────────────────────────────

  private async upsertLoanRepayment(
    tenantId: string,
    row: RawLoanRepaymentRow,
    recordedBy: string,
  ): Promise<boolean> {
    const user = await this.prisma.user.findFirst({
      where: { tenantId, idNumber: row.idNumber },
      select: { member: { select: { id: true } } },
    });

    if (!user?.member) {
      throw new Error(`Member not found for idNumber: ${row.idNumber}`);
    }

    const loan = await this.prisma.loan.findFirst({
      where: {
        tenantId,
        memberId: user.member.id,
        status: { in: ['DISBURSED', 'ACTIVE'] },
      },
      orderBy: { disbursedAt: 'desc' },
    });

    if (!loan) {
      throw new Error(`No active loan found for idNumber: ${row.idNumber}`);
    }

    const existing = await this.prisma.loanRepayment.findUnique({
      where: {
        loanId_dayNumber_tenantId: {
          loanId: loan.id,
          dayNumber: row.dayNumber,
          tenantId,
        },
      },
    });

    if (existing) return false;

    await this.prisma.loanRepayment.create({
      data: {
        loanId: loan.id,
        dayNumber: row.dayNumber,
        amountPaid: new Decimal(row.amountPaid),
        paymentDate: new Date(row.paymentDate),
        method: row.method ?? 'CASH',
        status: 'CONFIRMED',
        recordedBy,
        tenantId,
      },
    });

    const totalPaid = await this.prisma.loanRepayment.aggregate({
      where: { loanId: loan.id, tenantId },
      _sum: { amountPaid: true },
    });

    const totalRepaid = totalPaid._sum.amountPaid ?? new Decimal(0);
    const outstanding = loan.monthlyInstalment.sub(totalRepaid);
    const newStatus = outstanding.lte(new Decimal(0)) ? 'FULLY_PAID' : 'ACTIVE';

    await this.prisma.loan.update({
      where: { id: loan.id },
      data: {
        totalRepaid,
        outstandingBalance: outstanding.lt(new Decimal(0)) ? new Decimal(0) : outstanding,
        status: newStatus,
      },
    });

    return true;
  }

  // ─── Savings Record Upsert ─────────────────────────────────────────────────

  private async upsertSavingsRecord(
    tenantId: string,
    row: RawSavingsRow,
    batchId: string,
  ): Promise<boolean> {
    let memberId: string | undefined;

    if (row.idNumber) {
      const user = await this.prisma.user.findFirst({
        where: { tenantId, idNumber: row.idNumber },
        select: { member: { select: { id: true } } },
      });
      memberId = user?.member?.id;
    }

    const recordType: SavingsType = row.groupName ? 'GROUP_WELFARE' : 'INDIVIDUAL';

    const existing = await this.prisma.savingsRecord.findFirst({
      where: {
        tenantId,
        memberId: memberId ?? null,
        weekNumber: row.weekNumber,
        periodDate: new Date(row.periodDate),
      },
    });

    if (existing) return false;

    await this.prisma.savingsRecord.create({
      data: {
        memberId: memberId ?? null,
        weekNumber: row.weekNumber,
        amount: new Decimal(row.amount),
        periodDate: new Date(row.periodDate),
        recordType,
        tenantId,
        importBatchId: batchId,
      },
    });

    return true;
  }

  // ─── Group Welfare Collection Upsert ──────────────────────────────────────

  private async upsertGroupWelfareCollection(
    tenantId: string,
    row: RawGroupWelfareRow,
  ): Promise<boolean> {
    let group = await this.prisma.groupWelfare.findFirst({
      where: { tenantId, name: row.stageName },
    });

    if (!group) {
      const stage = await this.prisma.stage.findFirst({
        where: { tenantId, name: row.stageName },
      });

      group = await this.prisma.groupWelfare.create({
        data: {
          stageId: stage?.id ?? 'unknown',
          name: row.stageName,
          weeklyTarget: new Decimal(row.weeklyTarget ?? 300),
          tenantId,
        },
      });
    }

    const existing = await this.prisma.groupWelfareCollection.findUnique({
      where: {
        groupId_weekNumber_tenantId: {
          groupId: group.id,
          weekNumber: row.weekNumber,
          tenantId,
        },
      },
    });

    if (existing) return false;

    const target = group.weeklyTarget;
    const collected = new Decimal(row.amountCollected);
    const deficit = target.sub(collected).lt(new Decimal(0))
      ? new Decimal(0)
      : target.sub(collected);

    await this.prisma.groupWelfareCollection.create({
      data: {
        groupId: group.id,
        weekNumber: row.weekNumber,
        amountCollected: collected,
        periodDate: new Date(row.periodDate),
        deficit,
        tenantId,
      },
    });

    return true;
  }

  // ─── Row Validation ────────────────────────────────────────────────────────

  private async validateRow(
    tenantId: string,
    sheetType: FinancialSheetType,
    raw: Record<string, unknown>,
    rowNumber: number,
  ): Promise<FinancialPreviewRowResult> {
    switch (sheetType) {
      case FinancialSheetType.LOAN_DISBURSEMENT:
        return this.validateLoanDisbursementRow(tenantId, raw, rowNumber);
      case FinancialSheetType.LOAN_REPAYMENT:
        return this.validateLoanRepaymentRow(tenantId, raw, rowNumber);
      case FinancialSheetType.SACCO_SAVINGS:
        return this.validateSavingsRow(tenantId, raw, rowNumber);
      case FinancialSheetType.GROUP_WELFARE:
        return this.validateGroupWelfareRow(tenantId, raw, rowNumber);
      default:
        throw new BadRequestException(`Unknown sheet type: ${sheetType as string}`);
    }
  }

  private async validateLoanDisbursementRow(
    tenantId: string,
    raw: Record<string, unknown>,
    rowNumber: number,
  ): Promise<FinancialPreviewRowResult> {
    const idNumber = String(raw['idNumber'] ?? raw['ID_NUMBER'] ?? raw['id_number'] ?? '');
    const principal = Number(raw['principal'] ?? raw['PRINCIPAL'] ?? raw['amount'] ?? 0);

    if (!idNumber) return { rowNumber, status: 'ERROR', message: 'Missing idNumber', data: raw };
    if (principal <= 0) return { rowNumber, status: 'ERROR', message: 'Invalid principal amount', data: raw };

    const user = await this.prisma.user.findFirst({
      where: { tenantId, idNumber },
      select: { id: true, member: { select: { id: true } } },
    });

    if (!user?.member) {
      return { rowNumber, status: 'WARNING', message: `Member not found for idNumber: ${idNumber}`, data: raw };
    }

    const totalRepayable = principal * (1 + this.FLAT_INTEREST_RATE);
    return {
      rowNumber,
      status: 'VALID',
      resolvedMemberId: user.member.id,
      data: { ...raw, totalRepayable, interestRate: '6%' },
    };
  }

  private async validateLoanRepaymentRow(
    tenantId: string,
    raw: Record<string, unknown>,
    rowNumber: number,
  ): Promise<FinancialPreviewRowResult> {
    const idNumber = String(raw['idNumber'] ?? raw['ID_NUMBER'] ?? '');
    const dayNumber = Number(raw['dayNumber'] ?? raw['DAY'] ?? 0);
    const amountPaid = Number(raw['amountPaid'] ?? raw['AMOUNT'] ?? 0);

    if (!idNumber) return { rowNumber, status: 'ERROR', message: 'Missing idNumber', data: raw };
    if (dayNumber < 1 || dayNumber > 30) return { rowNumber, status: 'ERROR', message: 'dayNumber must be 1–30', data: raw };
    if (amountPaid <= 0) return { rowNumber, status: 'ERROR', message: 'Invalid amountPaid', data: raw };

    const user = await this.prisma.user.findFirst({
      where: { tenantId, idNumber },
      select: { member: { select: { id: true } } },
    });

    if (!user?.member) {
      return { rowNumber, status: 'WARNING', message: `Member not found for idNumber: ${idNumber}`, data: raw };
    }

    const loan = await this.prisma.loan.findFirst({
      where: { tenantId, memberId: user.member.id, status: { in: ['DISBURSED', 'ACTIVE'] } },
      orderBy: { disbursedAt: 'desc' },
    });

    if (!loan) {
      return { rowNumber, status: 'WARNING', message: `No active loan for idNumber: ${idNumber}`, data: raw };
    }

    return { rowNumber, status: 'VALID', resolvedMemberId: user.member.id, resolvedLoanId: loan.id, data: raw };
  }

  private async validateSavingsRow(
    tenantId: string,
    raw: Record<string, unknown>,
    rowNumber: number,
  ): Promise<FinancialPreviewRowResult> {
    const weekNumber = Number(raw['weekNumber'] ?? raw['WEEK'] ?? 0);
    const amount = Number(raw['amount'] ?? raw['AMOUNT'] ?? 0);

    if (weekNumber < 1 || weekNumber > 52) return { rowNumber, status: 'ERROR', message: 'weekNumber must be 1–52', data: raw };
    if (amount <= 0) return { rowNumber, status: 'ERROR', message: 'Invalid amount', data: raw };

    const idNumber = String(raw['idNumber'] ?? raw['ID_NUMBER'] ?? '');
    let resolvedMemberId: string | undefined;

    if (idNumber) {
      const user = await this.prisma.user.findFirst({
        where: { tenantId, idNumber },
        select: { member: { select: { id: true } } },
      });
      resolvedMemberId = user?.member?.id;
    }

    return { rowNumber, status: 'VALID', resolvedMemberId, data: raw };
  }

  private async validateGroupWelfareRow(
    _tenantId: string,
    raw: Record<string, unknown>,
    rowNumber: number,
  ): Promise<FinancialPreviewRowResult> {
    const stageName = String(raw['stageName'] ?? raw['STAGE'] ?? raw['GROUP'] ?? '');
    const weekNumber = Number(raw['weekNumber'] ?? raw['WEEK'] ?? 0);
    const amountCollected = Number(raw['amountCollected'] ?? raw['AMOUNT'] ?? 0);

    if (!stageName) return { rowNumber, status: 'ERROR', message: 'Missing stageName', data: raw };
    if (weekNumber < 1 || weekNumber > 52) return { rowNumber, status: 'ERROR', message: 'weekNumber must be 1–52', data: raw };
    if (amountCollected < 0) return { rowNumber, status: 'ERROR', message: 'Invalid amountCollected', data: raw };

    return { rowNumber, status: 'VALID', data: raw };
  }

  private extractAmount(sheetType: FinancialSheetType, raw: Record<string, unknown>): number {
    switch (sheetType) {
      case FinancialSheetType.LOAN_DISBURSEMENT: return Number(raw['principal'] ?? 0);
      case FinancialSheetType.LOAN_REPAYMENT: return Number(raw['amountPaid'] ?? 0);
      case FinancialSheetType.SACCO_SAVINGS: return Number(raw['amount'] ?? 0);
      case FinancialSheetType.GROUP_WELFARE: return Number(raw['amountCollected'] ?? 0);
      default: return 0;
    }
  }
}
