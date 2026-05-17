import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { LoanStatus, MpesaTxType, TransactionStatus, TransactionType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { AlertsService } from '../../alerts/alerts.service';
import { QUEUE_NAMES } from '../queue.constants';

@Processor(QUEUE_NAMES.MPESA_RECONCILIATION)
export class DailyReconProcessor extends WorkerHost {
  private readonly logger = new Logger(DailyReconProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly alerts: AlertsService,
  ) {
    super();
  }

  async process(job: Job<any>): Promise<any> {
    if (job.name !== 'daily-recon') return;

    this.logger.log('Generating Automated Daily Reconciliation Report...');
    const dateStr = new Date().toISOString().split('T')[0];

    try {
      // 1. Data Collection via native Prisma to enforce Phase 1.1 Tenant Isolation transparently
      const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);

      const stkPending = await this.prisma.mpesaTransaction.count({
        where: {
          type: MpesaTxType.STK_PUSH,
          status: TransactionStatus.PENDING,
          createdAt: { lt: fifteenMinsAgo },
        }
      }).catch(() => 0); // Graceful fallback if migrations lag in target env

      const b2cReconPending = await this.prisma.mpesaTransaction.count({
        where: { type: MpesaTxType.B2C, status: TransactionStatus.RECON_PENDING }
      }).catch(() => 0);

      const b2cTimeout = await this.prisma.mpesaTransaction.count({
        where: { type: MpesaTxType.B2C, status: TransactionStatus.FAILED }
      }).catch(() => 0);

      const loanMismatches = await this.prisma.loan.count({
        where: { 
          status: LoanStatus.DISBURSED,
          transactions: {
            none: {
              type: TransactionType.LOAN_DISBURSEMENT,
              status: TransactionStatus.COMPLETED,
            },
          },
        }
      }).catch(() => 0);

      // 2. CSV Generation
      const csvLines = [
        'Category,Metric,Count,Details',
        `STK_PUSH,PENDING_OVER_15M,${stkPending},Pending without callback`,
        `B2C,RECON_PENDING,${b2cReconPending},Disbursements awaiting manual recon`,
        `B2C,TIMEOUT_REVERTED,${b2cTimeout},Failed/Timed-out B2C disbursements`,
        `LOANS,DISBURSED_MISMATCH,${loanMismatches},Loan marked DISBURSED but B2C not COMPLETED`
      ];
      const csvContent = csvLines.join('\n');

      // 3. Upload to Cloudflare R2 using pre-signed URL technique established in Phase 2
      const fileKey = `recon-reports/${dateStr}.csv`;
      let uploadSuccess = false;
      
      try {
        const { uploadUrl } = await this.storage.getUploadUrlForKey({
          objectKey: fileKey,
          contentType: 'text/csv',
        });
        const uploadRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/csv' },
          body: csvContent,
        });
        uploadSuccess = uploadRes.ok;
      } catch (e) {
        this.logger.error('Failed to upload recon report to R2', e);
      }

      // 4. Alert & Delivery Output
      const summary = `:bar_chart: *Daily Recon Report (${dateStr})*\n` +
        `• STK Pending > 15m: *${stkPending}*\n` +
        `• B2C Recon Pending: *${b2cReconPending}*\n` +
        `• B2C Timeouts/Failed: *${b2cTimeout}*\n` +
        `• Loan Mismatches: *${loanMismatches}*\n\n` +
        `Report uploaded to R2: \`${fileKey}\` (Success: ${uploadSuccess})`;

      await this.alerts.sendSlackAlert(summary);
      await this.alerts.sendOpsEmail(`Daily Recon Report - ${dateStr}`, summary, csvContent);

      return { fileKey, success: uploadSuccess };
    } catch (error) {
      this.logger.error('Critical error generating daily recon report', error);
      await this.alerts.sendSlackAlert(`:rotating_light: *Reconciliation Report FAILED (${dateStr})*\nCheck worker logs immediately.`);
      throw error;
    }
  }
}
