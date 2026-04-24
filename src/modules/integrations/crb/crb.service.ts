import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../outbox/outbox.service';
import { QUEUE_NAMES, CrbExportJobPayload } from '../../queue/queue.constants';

/**
 * CRB Reporting Adapter – Phase 5
 *
 * Maps loan data to CRB Africa / Metropol XML format for credit bureau reporting.
 * Uses the Outbox pattern to guarantee delivery.
 *
 * CRB XML format follows the Kenya Credit Information Sharing (CIS) standard:
 *   - Header: Institution code, reporting period, submission date
 *   - Records: Member ID, National ID, Loan details, Arrears, Staging
 *
 * Production: Replace the mock XML builder with actual CRB Africa API client.
 */
@Injectable()
export class CrbService {
  private readonly logger = new Logger(CrbService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    @InjectQueue(QUEUE_NAMES.CRB_EXPORT)
    private readonly crbQueue: Queue<CrbExportJobPayload>,
  ) {}

  /**
   * POST /integrations/crb/report
   * Creates a CRB report, generates XML, and queues for submission via outbox.
   */
  async createReport(params: {
    tenantId: string;
    loanIds: string[];
    periodStart: string;
    periodEnd: string;
  }) {
    const { tenantId, loanIds, periodStart, periodEnd } = params;

    // Fetch loan data with member details
    const loans = await this.prisma.loan.findMany({
      where: {
        tenantId,
        id: { in: loanIds },
      },
      include: {
        member: {
          select: {
            id: true,
            memberNumber: true,
            nationalId: true,
            kraPin: true,
            user: { select: { firstName: true, lastName: true } },
          },
        },
        loanProduct: { select: { name: true } },
      },
    });

    if (loans.length === 0) {
      throw new NotFoundException('No loans found for the specified IDs');
    }

    // Generate CRB XML payload
    const xmlPayload = this.buildCrbXml(loans, tenantId, periodStart, periodEnd);

    // Create CRB report record
    const report = await this.prisma.crbReport.create({
      data: {
        tenantId,
        loanIds,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        xmlPayload,
        status: 'PENDING',
      },
    });

    // Create outbox entry for guaranteed delivery
    const outboxEntry = await this.outbox.createEntry({
      tenantId,
      idempotencyKey: `crb-report-${report.id}`,
      integrationType: 'CRB_EXPORT',
      payload: { reportId: report.id },
      maxAttempts: 5,
    });

    // Update report with outbox reference
    await this.prisma.crbReport.update({
      where: { id: report.id },
      data: { outboxId: outboxEntry.id, status: 'QUEUED' },
    });

    this.logger.log(`CRB report created: ${report.id} with ${loans.length} loans`);

    return {
      reportId: report.id,
      outboxId: outboxEntry.id,
      loanCount: loans.length,
      status: 'QUEUED',
      periodStart,
      periodEnd,
    };
  }

  /**
   * Process a CRB export job (called by queue processor).
   * In production, this would POST the XML to CRB Africa/Metropol API.
   */
  async processExport(reportId: string): Promise<void> {
    const report = await this.prisma.crbReport.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      throw new NotFoundException(`CRB report ${reportId} not found`);
    }

    try {
      // ── MOCK: Simulate CRB API submission ──────────────────────
      // In production, replace with actual HTTP POST to CRB Africa API:
      //   const response = await this.httpService.post(CRB_API_URL, report.xmlPayload, {
      //     headers: { 'Content-Type': 'application/xml', 'Authorization': `Bearer ${token}` },
      //   });
      this.logger.log(`[MOCK] Submitting CRB report ${reportId} to CRB Africa API`);

      // Simulate processing delay
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mock success response
      const mockResponseCode = 'CRB-200';
      const mockResponseMessage = 'Report accepted for processing';

      await this.prisma.crbReport.update({
        where: { id: reportId },
        data: {
          status: 'SUBMITTED',
          submittedAt: new Date(),
          responseCode: mockResponseCode,
          responseMessage: mockResponseMessage,
        },
      });

      this.logger.log(`CRB report ${reportId} submitted successfully`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.prisma.crbReport.update({
        where: { id: reportId },
        data: {
          status: 'FAILED',
          responseMessage: error,
        },
      });
      throw err;
    }
  }

  /**
   * Get CRB report status and history.
   */
  async getReports(tenantId: string, limit = 20) {
    return this.prisma.crbReport.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        loanIds: true,
        periodStart: true,
        periodEnd: true,
        status: true,
        submittedAt: true,
        responseCode: true,
        responseMessage: true,
        createdAt: true,
      },
    });
  }

  /**
   * Build CRB Africa/Metropol XML from loan data.
   * Follows Kenya CIS (Credit Information Sharing) standard format.
   */
  private buildCrbXml(
    loans: Array<{
      id: string;
      loanNumber: string;
      principalAmount: any;
      outstandingBalance: any;
      arrearsDays: number;
      arrearsAmount: any;
      staging: string;
      status: string;
      disbursedAt: Date | null;
      dueDate: Date | null;
      member: {
        id: string;
        memberNumber: string;
        nationalId: string | null;
        kraPin: string | null;
        user: { firstName: string; lastName: string };
      };
      loanProduct: { name: string };
    }>,
    tenantId: string,
    periodStart: string,
    periodEnd: string,
  ): string {
    const submissionDate = new Date().toISOString().split('T')[0];
    const batchId = uuidv4().split('-')[0].toUpperCase();

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<CreditReport xmlns="urn:crbafrica:cis:3.0">\n`;
    xml += `  <Header>\n`;
    xml += `    <InstitutionCode>SACCO-${tenantId.slice(0, 8).toUpperCase()}</InstitutionCode>\n`;
    xml += `    <InstitutionType>SACCO</InstitutionType>\n`;
    xml += `    <BatchId>${batchId}</BatchId>\n`;
    xml += `    <ReportingPeriodStart>${periodStart}</ReportingPeriodStart>\n`;
    xml += `    <ReportingPeriodEnd>${periodEnd}</ReportingPeriodEnd>\n`;
    xml += `    <SubmissionDate>${submissionDate}</SubmissionDate>\n`;
    xml += `    <RecordCount>${loans.length}</RecordCount>\n`;
    xml += `  </Header>\n`;
    xml += `  <Records>\n`;

    for (const loan of loans) {
      const classification = this.mapStagingToCrbClassification(loan.staging);
      xml += `    <CreditRecord>\n`;
      xml += `      <AccountNumber>${this.escapeXml(loan.loanNumber)}</AccountNumber>\n`;
      xml += `      <BorrowerName>${this.escapeXml(`${loan.member.user.lastName} ${loan.member.user.firstName}`)}</BorrowerName>\n`;
      xml += `      <NationalId>${this.escapeXml(loan.member.nationalId ?? 'N/A')}</NationalId>\n`;
      xml += `      <KraPin>${this.escapeXml(loan.member.kraPin ?? 'N/A')}</KraPin>\n`;
      xml += `      <MemberNumber>${this.escapeXml(loan.member.memberNumber)}</MemberNumber>\n`;
      xml += `      <ProductType>${this.escapeXml(loan.loanProduct.name)}</ProductType>\n`;
      xml += `      <PrincipalAmount>${loan.principalAmount}</PrincipalAmount>\n`;
      xml += `      <OutstandingBalance>${loan.outstandingBalance}</OutstandingBalance>\n`;
      xml += `      <ArrearsAmount>${loan.arrearsAmount}</ArrearsAmount>\n`;
      xml += `      <ArrearsDays>${loan.arrearsDays}</ArrearsDays>\n`;
      xml += `      <Classification>${classification}</Classification>\n`;
      xml += `      <AccountStatus>${loan.status}</AccountStatus>\n`;
      xml += `      <DisbursementDate>${loan.disbursedAt?.toISOString().split('T')[0] ?? ''}</DisbursementDate>\n`;
      xml += `      <MaturityDate>${loan.dueDate?.toISOString().split('T')[0] ?? ''}</MaturityDate>\n`;
      xml += `    </CreditRecord>\n`;
    }

    xml += `  </Records>\n`;
    xml += `</CreditReport>`;

    return xml;
  }

  private mapStagingToCrbClassification(staging: string): string {
    switch (staging) {
      case 'PERFORMING': return 'NORMAL';
      case 'WATCHLIST': return 'WATCH';
      case 'NPL': return 'SUBSTANDARD';
      default: return 'UNCLASSIFIED';
    }
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
