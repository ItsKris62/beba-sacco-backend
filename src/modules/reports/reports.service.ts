import { GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import PDFDocument from 'pdfkit';
import { Prisma, ReportFormat, ReportStatus, ReportType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { QUEUE_NAMES, ReportGenerationJobPayload } from '../queue/queue.constants';
import { GenerateReportDto } from './dto/generate-report.dto';

export interface BuiltReport {
  buffer: Buffer;
  contentType: string;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    @InjectQueue(QUEUE_NAMES.REPORT_GENERATION)
    private readonly reportQueue: Queue<ReportGenerationJobPayload>,
  ) {}

  async generateReport(dto: GenerateReportDto, tenantId: string, userId: string) {
    const job = await this.prisma.reportJob.create({
      data: {
        tenantId,
        requestedBy: userId,
        type: dto.type as unknown as ReportType,
        format: dto.format as unknown as ReportFormat,
        status: ReportStatus.QUEUED,
        filters: { from: dto.from, to: dto.to } as Prisma.InputJsonValue,
      },
    });

    await this.reportQueue.add(
      'generate',
      {
        jobId: job.id,
        tenantId,
        requestedBy: userId,
        type: dto.type,
        format: dto.format,
        filters: { from: dto.from, to: dto.to },
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: false,
      },
    );

    await this.audit.create({
      tenantId,
      actorId: userId,
      action: 'REPORT.GENERATE_REQUESTED',
      entityType: 'ReportJob',
      entityId: job.id,
      newValue: { status: ReportStatus.QUEUED },
      metadata: { type: dto.type, format: dto.format, filters: { from: dto.from, to: dto.to } },
    });

    return { jobId: job.id, status: job.status, estimatedCompletion: '60s' };
  }

  async getStatus(jobId: string, tenantId: string) {
    const job = await this.prisma.reportJob.findFirst({
      where: { id: jobId, tenantId },
      select: {
        id: true,
        type: true,
        format: true,
        status: true,
        errorMessage: true,
        expiresAt: true,
        createdAt: true,
        completedAt: true,
      },
    });
    if (!job) throw new NotFoundException('Report job not found');
    return job;
  }

  async getDownloadUrl(jobId: string, tenantId: string, userId: string) {
    const job = await this.prisma.reportJob.findFirst({
      where: { id: jobId, tenantId, status: ReportStatus.SUCCEEDED },
      select: { id: true, objectKey: true, expiresAt: true },
    });
    if (!job?.objectKey) throw new NotFoundException('Report is not available for download');
    if (job.expiresAt && job.expiresAt < new Date()) {
      await this.prisma.reportJob.update({
        where: { id: job.id },
        data: { status: ReportStatus.EXPIRED },
      });
      throw new GoneException('Report expired');
    }

    const expiresIn = Math.min(24 * 60 * 60, 60 * 60);
    const downloadUrl = await this.storage.getDownloadUrl(job.objectKey, expiresIn);

    await this.audit.create({
      tenantId,
      actorId: userId,
      action: 'REPORT.DOWNLOAD',
      entityType: 'ReportJob',
      entityId: job.id,
      metadata: { objectKey: job.objectKey, expiresIn },
    });

    return { downloadUrl, expiresAt: job.expiresAt };
  }

  async markRunning(jobId: string, tenantId: string): Promise<void> {
    await this.prisma.reportJob.updateMany({
      where: { id: jobId, tenantId },
      data: { status: ReportStatus.RUNNING },
    });
  }

  async markSucceeded(jobId: string, tenantId: string, objectKey: string): Promise<void> {
    await this.prisma.reportJob.updateMany({
      where: { id: jobId, tenantId },
      data: {
        status: ReportStatus.SUCCEEDED,
        objectKey,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        completedAt: new Date(),
      },
    });
  }

  async markFailed(jobId: string, tenantId: string, errorMessage: string): Promise<void> {
    await this.prisma.reportJob.updateMany({
      where: { id: jobId, tenantId },
      data: { status: ReportStatus.FAILED, errorMessage, completedAt: new Date() },
    });
  }

  async buildReport(payload: ReportGenerationJobPayload): Promise<BuiltReport> {
    const rows = await this.fetchRows(payload);
    const csv = this.toCsv(rows);
    if (payload.format === 'CSV') {
      return { buffer: Buffer.from(csv, 'utf8'), contentType: 'text/csv' };
    }
    return { buffer: await this.toPdf(payload, rows), contentType: 'application/pdf' };
  }

  private async fetchRows(payload: ReportGenerationJobPayload): Promise<Record<string, unknown>[]> {
    const from = new Date(payload.filters.from);
    const to = new Date(payload.filters.to);

    if (payload.type === 'LOAN_BOOK') {
      const loans = await this.prisma.loan.findMany({
        where: { tenantId: payload.tenantId, appliedAt: { gte: from, lte: to } },
        select: {
          loanNumber: true,
          status: true,
          principalAmount: true,
          outstandingBalance: true,
          appliedAt: true,
          member: { select: { memberNumber: true } },
        },
        orderBy: { appliedAt: 'desc' },
      });
      return loans.map((loan) => ({
        loanNumber: loan.loanNumber,
        memberNumber: loan.member.memberNumber,
        status: loan.status,
        principalAmount: Number(loan.principalAmount),
        outstandingBalance: Number(loan.outstandingBalance),
        appliedAt: loan.appliedAt.toISOString(),
      }));
    }

    if (payload.type === 'MEMBER_BALANCES') {
      const accounts = await this.prisma.account.findMany({
        where: { tenantId: payload.tenantId, isActive: true },
        select: {
          accountNumber: true,
          accountType: true,
          balance: true,
          member: { select: { memberNumber: true } },
        },
        orderBy: { accountNumber: 'asc' },
      });
      return accounts.map((account) => ({
        memberNumber: account.member.memberNumber,
        accountNumber: account.accountNumber,
        accountType: account.accountType,
        balance: Number(account.balance),
      }));
    }

    if (payload.type === 'AUDIT_TRAIL') {
      const logs = await this.prisma.auditLog.findMany({
        where: { tenantId: payload.tenantId, timestamp: { gte: from, lte: to } },
        select: { action: true, entityType: true, entityId: true, actorId: true, timestamp: true },
        orderBy: { timestamp: 'desc' },
        take: 5000,
      });
      return logs.map((log) => ({
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId,
        actorId: log.actorId,
        timestamp: log.timestamp.toISOString(),
      }));
    }

    const [members, loans, transactions] = await Promise.all([
      this.prisma.member.count({ where: { tenantId: payload.tenantId, isActive: true } }),
      this.prisma.loan.aggregate({
        where: { tenantId: payload.tenantId, appliedAt: { gte: from, lte: to } },
        _sum: { principalAmount: true, outstandingBalance: true },
        _count: { id: true },
      }),
      this.prisma.transaction.aggregate({
        where: { tenantId: payload.tenantId, createdAt: { gte: from, lte: to } },
        _sum: { amount: true },
        _count: { id: true },
      }),
    ]);
    return [
      {
        activeMembers: members,
        loanCount: loans._count.id,
        principalAmount: Number(loans._sum.principalAmount ?? 0),
        outstandingBalance: Number(loans._sum.outstandingBalance ?? 0),
        transactionCount: transactions._count.id,
        transactionAmount: Number(transactions._sum.amount ?? 0),
      },
    ];
  }

  private toCsv(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) return 'message\nNo records found\n';
    const headers = Object.keys(rows[0]);
    const lines = rows.map((row) =>
      headers.map((header) => this.csvCell(row[header])).join(','),
    );
    return [headers.join(','), ...lines].join('\n');
  }

  private csvCell(value: unknown): string {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  private toPdf(payload: ReportGenerationJobPayload, rows: Record<string, unknown>[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(16).text(`Beba SACCO ${payload.type} Report`, { align: 'center' });
      doc.moveDown();
      doc.fontSize(10).text(`Period: ${payload.filters.from} to ${payload.filters.to}`);
      doc.text(`Tenant: ${payload.tenantId}`);
      doc.moveDown();

      rows.slice(0, 200).forEach((row, index) => {
        doc.fontSize(10).text(`${index + 1}. ${JSON.stringify(row)}`);
      });
      if (rows.length > 200) doc.text(`... ${rows.length - 200} additional rows omitted from PDF preview.`);
      doc.end();
    });
  }
}
