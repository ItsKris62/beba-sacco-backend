import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { ConsentService } from '../compliance/consent.service';
import { AuditService } from '../audit/audit.service';

export interface StatementTransaction {
  date: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  reference: string;
}

export interface StatementMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface FosaStatement {
  memberId: string;
  memberNumber: string;
  memberName: string;
  generatedAt: string;
  periodFrom: string;
  periodTo: string;
  openingBalance: number;
  closingBalance: number;
  totalDisbursed: number;
  totalRepaid: number;
  transactions: StatementTransaction[];
  meta?: StatementMeta;
  auditHash: string;
}

export interface BosaStatement {
  memberId: string;
  memberNumber: string;
  memberName: string;
  generatedAt: string;
  periodFrom: string;
  periodTo: string;
  openingBalance: number;
  closingBalance: number;
  totalSavings: number;
  welfareContributions: number;
  transactions: StatementTransaction[];
  meta?: StatementMeta;
  auditHash: string;
}

export interface StatementOptions {
  skipConsent?: boolean;
  exportFormat?: 'VIEW' | 'PDF' | 'CSV';
  ipAddress?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class StatementService {
  private readonly logger = new Logger(StatementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly consentService: ConsentService,
    private readonly audit: AuditService,
  ) {}

  async resolveMemberIdForUser(tenantId: string, userId: string): Promise<string> {
    const member = await this.prisma.member.findFirst({
      where: { tenantId, userId },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('Member profile not found');
    return member.id;
  }

  private resolveStatementPeriod(
    periodFrom: string | undefined,
    periodTo: string | undefined,
    defaultDays: number,
  ): { from: Date; to: Date } {
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    const from = periodFrom
      ? this.parseStatementDate(periodFrom, 'periodFrom')
      : new Date(Date.now() - defaultDays * 24 * 60 * 60 * 1000);
    from.setHours(0, 0, 0, 0);

    const to = periodTo ? this.parseStatementDate(periodTo, 'periodTo') : new Date();
    to.setHours(23, 59, 59, 999);

    if (from > today || to > today) {
      throw new BadRequestException('Statement dates cannot be in the future');
    }
    if (from > to) {
      throw new BadRequestException('periodFrom cannot be later than periodTo');
    }

    return { from, to };
  }

  private parseStatementDate(value: string, fieldName: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException(`${fieldName} must be in YYYY-MM-DD format`);
    }

    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new BadRequestException(`${fieldName} is not a valid calendar date`);
    }

    return date;
  }

  async getFosaStatement(
    tenantId: string,
    userId: string,
    memberId: string,
    periodFrom?: string,
    periodTo?: string,
    options: StatementOptions = {},
  ): Promise<FosaStatement> {
    if (!memberId) throw new BadRequestException('memberId is required to generate a statement');
    await this.ensureConsent(userId, options);

    const member = await this.prisma.member.findFirst({
      where: { id: memberId, tenantId },
      include: { user: { select: { firstName: true, lastName: true } } },
    });
    if (!member) throw new NotFoundException('Member not found');

    const { from, to } = this.resolveStatementPeriod(periodFrom, periodTo, 90);

    const loans = await this.prisma.loan.findMany({
      where: { tenantId, memberId, disbursedAt: { lte: to } },
      orderBy: { disbursedAt: 'asc' },
    });
    const loanIds = loans.map((loan) => loan.id);

    const [periodRepayments, openingRepayments] =
      loanIds.length > 0
        ? await Promise.all([
            this.prisma.loanRepayment.findMany({
              where: {
                loanId: { in: loanIds },
                tenantId,
                status: 'PAID',
                paymentDate: { gte: from, lte: to },
              },
              orderBy: { paymentDate: 'asc' },
            }),
            this.prisma.loanRepayment.findMany({
              where: {
                loanId: { in: loanIds },
                tenantId,
                status: 'PAID',
                paymentDate: { lt: from },
              },
            }),
          ])
        : [[], []];

    const openingDisbursed = loans
      .filter((loan) => loan.disbursedAt && loan.disbursedAt < from)
      .reduce((sum, loan) => sum + Number(loan.principalAmount), 0);
    const openingRepaid = openingRepayments.reduce(
      (sum, repayment) => sum + Number(repayment.amountPaid),
      0,
    );

    const datedEntries: Array<StatementTransaction & { sortDate: Date; order: number }> = [];
    let totalDisbursed = 0;
    let totalRepaid = 0;

    loans.forEach((loan, index) => {
      if (!loan.disbursedAt || loan.disbursedAt < from || loan.disbursedAt > to) return;
      const principal = Number(loan.principalAmount);
      totalDisbursed += principal;
      datedEntries.push({
        date: loan.disbursedAt.toISOString().split('T')[0],
        description: `Loan Disbursement - ${loan.loanNumber}`,
        debit: principal,
        credit: 0,
        balance: 0,
        reference: loan.loanNumber,
        sortDate: loan.disbursedAt,
        order: index,
      });
    });

    const loanNumberById = new Map(loans.map((loan) => [loan.id, loan.loanNumber]));
    periodRepayments.forEach((repayment, index) => {
      const amount = Number(repayment.amountPaid);
      totalRepaid += amount;
      datedEntries.push({
        date: repayment.paymentDate.toISOString().split('T')[0],
        description: `Repayment Day ${repayment.dayNumber} - ${loanNumberById.get(repayment.loanId) ?? repayment.loanId}`,
        debit: 0,
        credit: amount,
        balance: 0,
        reference: repayment.id,
        sortDate: repayment.paymentDate,
        order: loans.length + index,
      });
    });

    let runningBalance = openingDisbursed - openingRepaid;
    const openingBalance = runningBalance;
    const transactions = datedEntries
      .sort((a, b) => a.sortDate.getTime() - b.sortDate.getTime() || a.order - b.order)
      .map(({ sortDate: _sortDate, order: _order, ...tx }) => {
        runningBalance += tx.debit;
        runningBalance -= tx.credit;
        return { ...tx, balance: runningBalance };
      });
    const paginated = this.paginateTransactions(transactions, options);

    const content = JSON.stringify({ memberId, openingBalance, transactions: paginated.transactions, totalDisbursed, totalRepaid });
    const auditHash = createHash('sha256').update(content).digest('hex');
    const statement: FosaStatement = {
      memberId,
      memberNumber: member.memberNumber,
      memberName: `${member.user.firstName} ${member.user.lastName}`,
      generatedAt: new Date().toISOString(),
      periodFrom: from.toISOString().split('T')[0],
      periodTo: to.toISOString().split('T')[0],
      openingBalance,
      closingBalance: runningBalance,
      totalDisbursed,
      totalRepaid,
      transactions: paginated.transactions,
      ...(paginated.meta && { meta: paginated.meta }),
      auditHash,
    };

    await this.auditStatement(tenantId, userId, 'FOSA', statement, options);
    return statement;
  }

  async getBosaStatement(
    tenantId: string,
    userId: string,
    memberId: string,
    periodFrom?: string,
    periodTo?: string,
    options: StatementOptions = {},
  ): Promise<BosaStatement> {
    if (!memberId) throw new BadRequestException('memberId is required to generate a statement');
    await this.ensureConsent(userId, options);

    const member = await this.prisma.member.findFirst({
      where: { id: memberId, tenantId },
      include: { user: { select: { firstName: true, lastName: true } } },
    });
    if (!member) throw new NotFoundException('Member not found');

    const { from, to } = this.resolveStatementPeriod(periodFrom, periodTo, 365);

    const [savings, openingSavings] = await Promise.all([
      this.prisma.savingsRecord.findMany({
        where: { tenantId, memberId, periodDate: { gte: from, lte: to } },
        orderBy: { periodDate: 'asc' },
      }),
      this.prisma.savingsRecord.aggregate({
        where: { tenantId, memberId, periodDate: { lt: from } },
        _sum: { amount: true },
      }),
    ]);

    const transactions: StatementTransaction[] = [];
    let runningBalance = Number(openingSavings._sum.amount ?? 0);
    const openingBalance = runningBalance;
    let totalSavings = 0;
    let welfareContributions = 0;

    for (const record of savings) {
      const amount = Number(record.amount);
      if (record.recordType === 'INDIVIDUAL') totalSavings += amount;
      else welfareContributions += amount;
      runningBalance += amount;

      transactions.push({
        date: record.periodDate.toISOString().split('T')[0],
        description: `${record.recordType === 'INDIVIDUAL' ? 'Savings' : 'Welfare'} - Week ${record.weekNumber}`,
        debit: 0,
        credit: amount,
        balance: runningBalance,
        reference: record.id,
      });
    }

    const paginated = this.paginateTransactions(transactions, options);
    const content = JSON.stringify({
      memberId,
      openingBalance,
      transactions: paginated.transactions,
      totalSavings,
      welfareContributions,
    });
    const auditHash = createHash('sha256').update(content).digest('hex');
    const statement: BosaStatement = {
      memberId,
      memberNumber: member.memberNumber,
      memberName: `${member.user.firstName} ${member.user.lastName}`,
      generatedAt: new Date().toISOString(),
      periodFrom: from.toISOString().split('T')[0],
      periodTo: to.toISOString().split('T')[0],
      openingBalance,
      closingBalance: runningBalance,
      totalSavings,
      welfareContributions,
      transactions: paginated.transactions,
      ...(paginated.meta && { meta: paginated.meta }),
      auditHash,
    };

    await this.auditStatement(tenantId, userId, 'BOSA', statement, options);
    return statement;
  }

  async generatePdf(
    statement: FosaStatement | BosaStatement,
    saccoName: string,
    statementType: 'FOSA' | 'BOSA',
  ): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PDFDocument = require('pdfkit') as typeof import('pdfkit');

    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.save();
      doc.rotate(45, { origin: [300, 400] });
      doc.fontSize(80).fillColor('#e0e0e0').opacity(0.3).text('CONFIDENTIAL', 50, 300);
      doc.restore();
      doc.opacity(1);

      doc.fontSize(20).fillColor('#1a1a2e').text(saccoName, { align: 'center' });
      doc.fontSize(14).fillColor('#333').text(`${statementType} Statement`, { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).fillColor('#666').text(`Generated: ${statement.generatedAt}`, { align: 'right' });
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ccc');
      doc.moveDown();

      doc.fontSize(11).fillColor('#333');
      doc.text(`Member: ${statement.memberName}`);
      doc.text(`Member No: ${statement.memberNumber}`);
      doc.text(`Period: ${statement.periodFrom} to ${statement.periodTo}`);
      doc.moveDown();

      doc.fontSize(12).fillColor('#1a1a2e').text('Summary', { underline: true });
      doc.fontSize(10).fillColor('#333');

      if (statementType === 'FOSA') {
        const fosa = statement as FosaStatement;
        doc.text(`Opening Balance: KES ${fosa.openingBalance.toLocaleString()}`);
        doc.text(`Total Disbursed: KES ${fosa.totalDisbursed.toLocaleString()}`);
        doc.text(`Total Repaid: KES ${fosa.totalRepaid.toLocaleString()}`);
        doc.text(`Closing Balance: KES ${fosa.closingBalance.toLocaleString()}`);
      } else {
        const bosa = statement as BosaStatement;
        doc.text(`Opening Balance: KES ${bosa.openingBalance.toLocaleString()}`);
        doc.text(`Total Savings: KES ${bosa.totalSavings.toLocaleString()}`);
        doc.text(`Welfare Contributions: KES ${bosa.welfareContributions.toLocaleString()}`);
        doc.text(`Closing Balance: KES ${bosa.closingBalance.toLocaleString()}`);
      }
      doc.moveDown();

      doc.fontSize(12).fillColor('#1a1a2e').text('Transactions', { underline: true });
      doc.moveDown(0.5);

      const colX = [50, 120, 280, 360, 430];
      doc.fontSize(9).fillColor('#fff');
      doc.rect(50, doc.y, 495, 18).fill('#1a1a2e');
      const headerY = doc.y - 14;
      doc.fillColor('#fff');
      doc.text('Date', colX[0], headerY);
      doc.text('Description', colX[1], headerY);
      doc.text('Debit', colX[2], headerY);
      doc.text('Credit', colX[3], headerY);
      doc.text('Balance', colX[4], headerY);
      doc.moveDown(0.3);

      let rowIndex = 0;
      for (const tx of statement.transactions) {
        const rowY = doc.y;
        if (rowIndex % 2 === 0) doc.rect(50, rowY, 495, 16).fill('#f8f9fa');
        doc.fillColor('#333').fontSize(8);
        doc.text(tx.date, colX[0], rowY + 3, { width: 65 });
        doc.text(tx.description, colX[1], rowY + 3, { width: 155 });
        doc.text(tx.debit > 0 ? tx.debit.toLocaleString() : '-', colX[2], rowY + 3, { width: 75 });
        doc.text(tx.credit > 0 ? tx.credit.toLocaleString() : '-', colX[3], rowY + 3, { width: 65 });
        doc.text(tx.balance.toLocaleString(), colX[4], rowY + 3, { width: 65 });
        doc.moveDown(0.8);
        rowIndex++;
        if (doc.y > 720) {
          doc.addPage();
          rowIndex = 0;
        }
      }

      doc.moveDown();
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ccc');
      doc.moveDown(0.5);
      doc.fontSize(8).fillColor('#999');
      doc.text(`Audit Hash: ${statement.auditHash}`, { align: 'left' });
      doc.moveDown(0.3);
      doc.text(
        'ODPC Disclaimer: This statement contains personal data processed under the Kenya Data Protection Act 2019. Unauthorized disclosure is prohibited. Retain for 7 years per SACCO regulations.',
        { align: 'left', width: 495 },
      );

      doc.end();
    });
  }

  exportAsCsv(statement: FosaStatement | BosaStatement): string {
    const isFosa = 'totalDisbursed' in statement;
    const summaryRows = isFosa
      ? [
          ['Opening Balance', String((statement as FosaStatement).openingBalance)],
          ['Total Disbursed', String((statement as FosaStatement).totalDisbursed)],
          ['Total Repaid', String((statement as FosaStatement).totalRepaid)],
          ['Closing Balance', String((statement as FosaStatement).closingBalance)],
        ]
      : [
          ['Opening Balance', String((statement as BosaStatement).openingBalance)],
          ['Total Savings', String((statement as BosaStatement).totalSavings)],
          ['Welfare Contributions', String((statement as BosaStatement).welfareContributions)],
          ['Closing Balance', String((statement as BosaStatement).closingBalance)],
        ];

    const rows = [
      ['Member', statement.memberName],
      ['Member Number', statement.memberNumber],
      ['Period From', statement.periodFrom],
      ['Period To', statement.periodTo],
      ['Audit Hash', statement.auditHash],
      [],
      ...summaryRows,
      [],
      ['Date', 'Description', 'Debit', 'Credit', 'Balance', 'Reference'],
      ...statement.transactions.map((tx) => [
        tx.date,
        tx.description,
        String(tx.debit),
        String(tx.credit),
        String(tx.balance),
        tx.reference,
      ]),
    ];

    return rows.map((row) => row.map((value) => this.csvCell(value)).join(',')).join('\n');
  }

  private async ensureConsent(userId: string, options: StatementOptions): Promise<void> {
    if (options.skipConsent) return;
    const hasConsent = await this.consentService.hasConsent(userId, 'STATEMENT_EXPORT');
    if (!hasConsent) {
      throw new ForbiddenException(
        'STATEMENT_EXPORT consent required. Please accept the consent in your profile.',
      );
    }
  }

  private paginateTransactions(
    transactions: StatementTransaction[],
    options: StatementOptions,
  ): { transactions: StatementTransaction[]; meta?: StatementMeta } {
    if (!options.page && !options.limit) {
      return { transactions };
    }

    const page = Math.max(1, Number(options.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(options.limit ?? 20)));
    const total = transactions.length;
    const skip = (page - 1) * limit;

    return {
      transactions: transactions.slice(skip, skip + limit),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  private async auditStatement(
    tenantId: string,
    actorId: string,
    statementType: 'FOSA' | 'BOSA',
    statement: FosaStatement | BosaStatement,
    options: StatementOptions,
  ): Promise<void> {
    const format = options.exportFormat ?? 'VIEW';
    await this.audit
      .create({
        tenantId,
        actorId,
        action: format === 'VIEW' ? 'STATEMENT.VIEW' : 'STATEMENT.EXPORT',
        entityType: 'Statement',
        entityId: statement.memberId,
        metadata: {
          statementType,
          format,
          memberNumber: statement.memberNumber,
          periodFrom: statement.periodFrom,
          periodTo: statement.periodTo,
          transactionCount: statement.transactions.length,
          auditHash: statement.auditHash,
        },
        ipAddress: options.ipAddress,
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `Statement audit write failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  private csvCell(value: unknown): string {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
}

