/**
 * Sprint 3 – Statement Service
 *
 * Generates FOSA/BOSA statements as JSON or PDF.
 * PDF generation is server-side using PDFKit to prevent client-side data exposure.
 *
 * FOSA = Front Office Savings Account (loans, repayments)
 * BOSA = Back Office Savings Account (savings, welfare)
 *
 * PDF includes:
 *   - SACCO header with logo placeholder
 *   - Member details
 *   - Transaction table
 *   - Audit signature hash (SHA-256 of content)
 *   - ODPC disclaimer
 *   - Watermark: "CONFIDENTIAL"
 */
import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SecurityService } from './security.service';

export interface StatementTransaction {
  date: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  reference: string;
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
  auditHash: string;
}

export interface BosaStatement {
  memberId: string;
  memberNumber: string;
  memberName: string;
  generatedAt: string;
  periodFrom: string;
  periodTo: string;
  totalSavings: number;
  welfareContributions: number;
  transactions: StatementTransaction[];
  auditHash: string;
}

@Injectable()
export class StatementService {
  private readonly logger = new Logger(StatementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly securityService: SecurityService,
  ) {}

  // ─── FOSA Statement ────────────────────────────────────────────────────────

  async getFosaStatement(
    tenantId: string,
    userId: string,
    memberId: string,
    periodFrom?: string,
    periodTo?: string,
  ): Promise<FosaStatement> {
    // Verify consent before generating statement
    const hasConsent = await this.securityService.hasConsent(userId, 'STATEMENT_EXPORT');
    if (!hasConsent) {
      throw new ForbiddenException(
        'STATEMENT_EXPORT consent required. Please accept the consent in your profile.',
      );
    }

    const member = await this.prisma.member.findFirst({
      where: { id: memberId, tenantId },
      include: { user: { select: { firstName: true, lastName: true } } },
    });

    if (!member) {
      throw new NotFoundException('Member not found');
    }

    const from = periodFrom ? new Date(periodFrom) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const to = periodTo ? new Date(periodTo) : new Date();

    // Fetch loans in period
    const loans = await this.prisma.loan.findMany({
      where: {
        tenantId,
        memberId,
        disbursedAt: { gte: from, lte: to },
      },
      include: {
        repayments: {
          where: { paymentDate: { gte: from, lte: to } },
          orderBy: { paymentDate: 'asc' },
        },
      },
      orderBy: { disbursedAt: 'asc' },
    });

    const transactions: StatementTransaction[] = [];
    let runningBalance = 0;
    let totalDisbursed = 0;
    let totalRepaid = 0;

    for (const loan of loans) {
      const principal = Number(loan.principalAmount);
      totalDisbursed += principal;
      runningBalance += principal;

      transactions.push({
        date: loan.disbursedAt?.toISOString().split('T')[0] ?? '',
        description: `Loan Disbursement – ${loan.loanNumber}`,
        debit: principal,
        credit: 0,
        balance: runningBalance,
        reference: loan.loanNumber,
      });

      for (const repayment of loan.repayments) {
        const amount = Number(repayment.amountPaid);
        totalRepaid += amount;
        runningBalance -= amount;

        transactions.push({
          date: repayment.paymentDate.toISOString().split('T')[0],
          description: `Repayment Day ${repayment.dayNumber} – ${loan.loanNumber}`,
          debit: 0,
          credit: amount,
          balance: runningBalance,
          reference: repayment.id,
        });
      }
    }

    const content = JSON.stringify({ memberId, transactions, totalDisbursed, totalRepaid });
    const auditHash = createHash('sha256').update(content).digest('hex');

    return {
      memberId,
      memberNumber: member.memberNumber,
      memberName: `${member.user.firstName} ${member.user.lastName}`,
      generatedAt: new Date().toISOString(),
      periodFrom: from.toISOString().split('T')[0],
      periodTo: to.toISOString().split('T')[0],
      openingBalance: 0,
      closingBalance: runningBalance,
      totalDisbursed,
      totalRepaid,
      transactions,
      auditHash,
    };
  }

  // ─── BOSA Statement ────────────────────────────────────────────────────────

  async getBosaStatement(
    tenantId: string,
    userId: string,
    memberId: string,
    periodFrom?: string,
    periodTo?: string,
  ): Promise<BosaStatement> {
    const hasConsent = await this.securityService.hasConsent(userId, 'STATEMENT_EXPORT');
    if (!hasConsent) {
      throw new ForbiddenException('STATEMENT_EXPORT consent required.');
    }

    const member = await this.prisma.member.findFirst({
      where: { id: memberId, tenantId },
      include: { user: { select: { firstName: true, lastName: true } } },
    });

    if (!member) {
      throw new NotFoundException('Member not found');
    }

    const from = periodFrom ? new Date(periodFrom) : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const to = periodTo ? new Date(periodTo) : new Date();

    const savings = await this.prisma.savingsRecord.findMany({
      where: { tenantId, memberId, periodDate: { gte: from, lte: to } },
      orderBy: { periodDate: 'asc' },
    });

    const transactions: StatementTransaction[] = [];
    let runningBalance = 0;
    let totalSavings = 0;
    let welfareContributions = 0;

    for (const record of savings) {
      const amount = Number(record.amount);
      if (record.recordType === 'INDIVIDUAL') {
        totalSavings += amount;
      } else {
        welfareContributions += amount;
      }
      runningBalance += amount;

      transactions.push({
        date: record.periodDate.toISOString().split('T')[0],
        description: `${record.recordType === 'INDIVIDUAL' ? 'Savings' : 'Welfare'} – Week ${record.weekNumber}`,
        debit: 0,
        credit: amount,
        balance: runningBalance,
        reference: record.id,
      });
    }

    const content = JSON.stringify({ memberId, transactions, totalSavings, welfareContributions });
    const auditHash = createHash('sha256').update(content).digest('hex');

    return {
      memberId,
      memberNumber: member.memberNumber,
      memberName: `${member.user.firstName} ${member.user.lastName}`,
      generatedAt: new Date().toISOString(),
      periodFrom: from.toISOString().split('T')[0],
      periodTo: to.toISOString().split('T')[0],
      totalSavings,
      welfareContributions,
      transactions,
      auditHash,
    };
  }

  // ─── PDF Generation ────────────────────────────────────────────────────────

  /**
   * Generate a PDF statement buffer using PDFKit.
   * Server-side only – never expose raw data to client.
   *
   * Includes:
   *   - SACCO header
   *   - Member details
   *   - Transaction table
   *   - Audit hash footer
   *   - "CONFIDENTIAL" watermark
   *   - ODPC disclaimer
   */
  async generatePdf(
    statement: FosaStatement | BosaStatement,
    saccoName: string,
    statementType: 'FOSA' | 'BOSA',
  ): Promise<Buffer> {
    // Dynamic import to avoid loading PDFKit at module init
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PDFDocument = require('pdfkit') as typeof import('pdfkit');

    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ── Watermark ──────────────────────────────────────────────────────────
      doc.save();
      doc.rotate(45, { origin: [300, 400] });
      doc.fontSize(80).fillColor('#e0e0e0').opacity(0.3).text('CONFIDENTIAL', 50, 300);
      doc.restore();
      doc.opacity(1);

      // ── Header ─────────────────────────────────────────────────────────────
      doc.fontSize(20).fillColor('#1a1a2e').text(saccoName, { align: 'center' });
      doc.fontSize(14).fillColor('#333').text(`${statementType} Statement`, { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).fillColor('#666').text(`Generated: ${statement.generatedAt}`, { align: 'right' });
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ccc');
      doc.moveDown();

      // ── Member Details ─────────────────────────────────────────────────────
      doc.fontSize(11).fillColor('#333');
      doc.text(`Member: ${statement.memberName}`);
      doc.text(`Member No: ${statement.memberNumber}`);
      doc.text(`Period: ${statement.periodFrom} to ${statement.periodTo}`);
      doc.moveDown();

      // ── Summary ────────────────────────────────────────────────────────────
      doc.fontSize(12).fillColor('#1a1a2e').text('Summary', { underline: true });
      doc.fontSize(10).fillColor('#333');

      if (statementType === 'FOSA') {
        const fosa = statement as FosaStatement;
        doc.text(`Total Disbursed: KES ${fosa.totalDisbursed.toLocaleString()}`);
        doc.text(`Total Repaid: KES ${fosa.totalRepaid.toLocaleString()}`);
        doc.text(`Closing Balance: KES ${fosa.closingBalance.toLocaleString()}`);
      } else {
        const bosa = statement as BosaStatement;
        doc.text(`Total Savings: KES ${bosa.totalSavings.toLocaleString()}`);
        doc.text(`Welfare Contributions: KES ${bosa.welfareContributions.toLocaleString()}`);
      }
      doc.moveDown();

      // ── Transaction Table ──────────────────────────────────────────────────
      doc.fontSize(12).fillColor('#1a1a2e').text('Transactions', { underline: true });
      doc.moveDown(0.5);

      // Table header
      const colX = [50, 120, 280, 360, 430, 490];
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

      // Table rows
      let rowIndex = 0;
      for (const tx of statement.transactions) {
        const rowY = doc.y;
        if (rowIndex % 2 === 0) {
          doc.rect(50, rowY, 495, 16).fill('#f8f9fa');
        }
        doc.fillColor('#333').fontSize(8);
        doc.text(tx.date, colX[0], rowY + 3, { width: 65 });
        doc.text(tx.description, colX[1], rowY + 3, { width: 155 });
        doc.text(tx.debit > 0 ? tx.debit.toLocaleString() : '-', colX[2], rowY + 3, { width: 75 });
        doc.text(tx.credit > 0 ? tx.credit.toLocaleString() : '-', colX[3], rowY + 3, { width: 65 });
        doc.text(tx.balance.toLocaleString(), colX[4], rowY + 3, { width: 65 });
        doc.moveDown(0.8);
        rowIndex++;

        // Page break check
        if (doc.y > 720) {
          doc.addPage();
          rowIndex = 0;
        }
      }

      doc.moveDown();

      // ── Audit Footer ───────────────────────────────────────────────────────
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ccc');
      doc.moveDown(0.5);
      doc.fontSize(8).fillColor('#999');
      doc.text(`Audit Hash: ${statement.auditHash}`, { align: 'left' });
      doc.moveDown(0.3);
      doc.text(
        'ODPC Disclaimer: This statement contains personal data processed under the Kenya Data Protection Act 2019. ' +
          'Unauthorized disclosure is prohibited. Retain for 7 years per SACCO regulations.',
        { align: 'left', width: 495 },
      );

      doc.end();
    });
  }
}
