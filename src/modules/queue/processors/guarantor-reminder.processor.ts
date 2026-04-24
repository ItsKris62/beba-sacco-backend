import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { QUEUE_NAMES, GuarantorReminderJobPayload } from '../queue.constants';
import { PlunkService } from '../../../common/services/plunk.service';

/**
 * Guarantor Reminder Processor
 *
 * Fires 24 hours after a guarantor is invited (see LoansService.inviteGuarantors).
 * Looks up the guarantor's name and borrower's name from the DB,
 * then sends a reminder email via Plunk if the guarantee is still PENDING.
 *
 * Uses PrismaClient directly (not PrismaService) because processors
 * run in the BullMQ worker context where DI is not always reliable for
 * circular-dependency-heavy feature modules.
 */
@Processor(QUEUE_NAMES.LOAN_GUARANTOR_REMINDER, { concurrency: 10 })
export class GuarantorReminderProcessor extends WorkerHost {
  private readonly logger = new Logger(GuarantorReminderProcessor.name);
  // PrismaClient is instantiated directly to avoid circular DI in queue context
  private readonly prisma = new PrismaClient();

  constructor(private readonly plunk: PlunkService) {
    super();
  }

  async process(job: Job<GuarantorReminderJobPayload>): Promise<void> {
    const { loanId, guarantorId, tenantId, loanNumber } = job.data;

    this.logger.log(
      `Guarantor reminder: loanId=${loanId} guarantorMemberId=${guarantorId} loan=${loanNumber}`,
    );

    // Skip if guarantor already responded
    const guarantor = await this.prisma.guarantor.findFirst({
      where: { loanId, memberId: guarantorId, tenantId },
      select: {
        status: true,
        guaranteedAmount: true,
        member: { select: { user: { select: { email: true, firstName: true } } } },
      },
    });

    if (!guarantor) {
      this.logger.warn(`Guarantor record not found for loanId=${loanId} memberId=${guarantorId}`);
      return;
    }

    if (guarantor.status !== 'PENDING') {
      this.logger.log(
        `Guarantor ${guarantorId} already responded (${guarantor.status}) — skipping reminder`,
      );
      return;
    }

    // Look up borrower name
    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId },
      select: { member: { select: { user: { select: { firstName: true, lastName: true } } } } },
    });

    const borrowerName = loan
      ? `${loan.member.user.firstName} ${loan.member.user.lastName}`
      : 'a fellow member';

    const guarantorEmail = guarantor.member.user.email;
    const guarantorFirstName = guarantor.member.user.firstName;
    const guaranteedAmount = Number(guarantor.guaranteedAmount);

    await this.plunk.send({
      to: guarantorEmail,
      subject: `Reminder: Pending guarantor response for loan ${loanNumber}`,
      body: await this.buildReminderEmail(guarantorFirstName, borrowerName, loanNumber, guaranteedAmount),
    });

    this.logger.log(`Guarantor reminder email sent to ${guarantorEmail} for loan ${loanNumber}`);
  }

  private async buildReminderEmail(
    firstName: string,
    borrowerName: string,
    loanNumber: string,
    guaranteedAmount: number,
  ): Promise<string> {
    const kes = (n: number) =>
      `KES ${n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: Arial, sans-serif; background: #f4f6f8; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 32px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .header { background: #1a56db; padding: 24px 32px; }
    .header h1 { color: #fff; margin: 0; font-size: 22px; }
    .body { padding: 32px; color: #374151; line-height: 1.6; }
    .highlight { background: #eff6ff; border-left: 4px solid #1a56db; padding: 16px 20px; border-radius: 4px; margin: 20px 0; }
    .highlight table { width: 100%; border-collapse: collapse; }
    .highlight td { padding: 4px 0; }
    .highlight td:last-child { font-weight: bold; text-align: right; }
    .footer { background: #f9fafb; padding: 20px 32px; text-align: center; color: #9ca3af; font-size: 13px; border-top: 1px solid #e5e7eb; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>Beba SACCO</h1></div>
    <div class="body">
      <p>Dear ${firstName},</p>
      <h2>Friendly Reminder ⏰</h2>
      <p>You have a pending guarantor request from <strong>${borrowerName}</strong> that requires your response.</p>
      <div class="highlight">
        <table>
          <tr><td>Loan Number</td><td>${loanNumber}</td></tr>
          <tr><td>Your Guaranteed Amount</td><td>${kes(guaranteedAmount)}</td></tr>
        </table>
      </div>
      <p>Please log in to the Beba SACCO portal to respond. The loan cannot proceed until all guarantors have responded.</p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} Beba SACCO &mdash; Please do not reply to this email.
    </div>
  </div>
</body>
</html>`.trim();
  }
}
