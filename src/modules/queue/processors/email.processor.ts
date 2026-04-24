import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, EmailJobPayload } from '../queue.constants';
import { PlunkService } from '../../../common/services/plunk.service';

/**
 * Email Queue Processor
 *
 * Processes all outbound transactional emails via Plunk.
 * Each job type maps to an inline HTML template.
 *
 * Design choices:
 *  - Templates are inline strings — no file-system dependency, works in any deployment.
 *  - PlunkService never throws — if the API key is missing or Plunk is down the job
 *    completes successfully (no retry storm for missing config).
 *  - All amounts formatted in KES with 2 decimal places.
 *
 * To add a new email type:
 *  1. Add payload interface + union member in queue.constants.ts
 *  2. Add a `case` branch here with its template
 *  3. Enqueue with InjectQueue(QUEUE_NAMES.EMAIL).add('send', payload)
 */
@Processor(QUEUE_NAMES.EMAIL, { concurrency: 3 })
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(private readonly plunk: PlunkService) {
    super();
  }

  async process(job: Job<EmailJobPayload>): Promise<void> {
    const payload = job.data;
    this.logger.log(`Processing email job ${job.id} type=${payload.type} to=${payload.to}`);

    const { subject, body } = this.buildEmail(payload);
    const sent = await this.plunk.send({ to: payload.to, subject, body });

    if (!sent) {
      // Logged inside PlunkService — complete the job so BullMQ doesn't retry forever
      this.logger.warn(`Email not delivered for job ${job.id} (type=${payload.type})`);
    }
  }

  // ─── Template router ─────────────────────────────────────────

  private buildEmail(payload: EmailJobPayload): { subject: string; body: string } {
    switch (payload.type) {
      case 'WELCOME':
        return this.welcome(payload);
      case 'LOAN_APPROVED':
        return this.loanApproved(payload);
      case 'LOAN_REJECTED':
        return this.loanRejected(payload);
      case 'LOAN_DISBURSED':
        return this.loanDisbursed(payload);
      case 'GUARANTOR_INVITE':
        return this.guarantorInvite(payload);
      case 'GUARANTOR_REMINDER':
        return this.guarantorReminder(payload);
      case 'REPAYMENT_RECEIPT':
        return this.repaymentReceipt(payload);
      case 'PASSWORD_RESET':
        return this.passwordReset(payload);
      case 'MEMBER_APPROVED':
        return this.memberApproved(payload);
      case 'MEMBER_REJECTED':
        return this.memberRejected(payload);
    }
  }

  // ─── HTML templates ──────────────────────────────────────────

  private wrap(firstName: string, content: string): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: Arial, sans-serif; background: #f4f6f8; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 32px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .header { background: #1a56db; padding: 24px 32px; }
    .header h1 { color: #fff; margin: 0; font-size: 22px; }
    .body { padding: 32px; color: #374151; line-height: 1.6; }
    .body h2 { color: #111827; margin-top: 0; }
    .highlight { background: #eff6ff; border-left: 4px solid #1a56db; padding: 16px 20px; border-radius: 4px; margin: 20px 0; }
    .highlight table { width: 100%; border-collapse: collapse; }
    .highlight td { padding: 4px 0; }
    .highlight td:last-child { font-weight: bold; text-align: right; }
    .btn { display: inline-block; margin-top: 20px; padding: 12px 28px; background: #1a56db; color: #fff; text-decoration: none; border-radius: 6px; font-weight: bold; }
    .footer { background: #f9fafb; padding: 20px 32px; text-align: center; color: #9ca3af; font-size: 13px; border-top: 1px solid #e5e7eb; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>Beba SACCO</h1></div>
    <div class="body">
      <p>Dear ${firstName},</p>
      ${content}
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} Beba SACCO &mdash; This email was sent to you as a registered member.<br/>
      Please do not reply to this email.
    </div>
  </div>
</body>
</html>`.trim();
  }

  private kes(amount: number): string {
    return `KES ${amount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  // ── WELCOME ───────────────────────────────────────────────────

  private welcome(p: Extract<EmailJobPayload, { type: 'WELCOME' }>) {
    return {
      subject: `Welcome to ${p.saccoName}`,
      body: this.wrap(p.firstName, `
        <h2>Welcome to ${p.saccoName}! 🎉</h2>
        <p>Your account has been created successfully. You are now part of our growing SACCO community.</p>
        <p>Here's what you can do next:</p>
        <ul>
          <li>Open a BOSA savings account to start earning interest</li>
          <li>Open a FOSA transactional account for day-to-day banking</li>
          <li>Apply for a loan once you have an active account</li>
        </ul>
        <p>If you received a temporary password, please change it on your first login.</p>
        <p>Welcome aboard!</p>
      `),
    };
  }

  // ── LOAN APPROVED ─────────────────────────────────────────────

  private loanApproved(p: Extract<EmailJobPayload, { type: 'LOAN_APPROVED' }>) {
    return {
      subject: `Your loan ${p.loanNumber} has been approved`,
      body: this.wrap(p.firstName, `
        <h2>Loan Approved ✅</h2>
        <p>Great news! Your loan application has been approved and is now awaiting disbursement.</p>
        <div class="highlight">
          <table>
            <tr><td>Loan Number</td><td>${p.loanNumber}</td></tr>
            <tr><td>Principal Amount</td><td>${this.kes(p.principalAmount)}</td></tr>
            <tr><td>Monthly Instalment</td><td>${this.kes(p.monthlyInstalment)}</td></tr>
            <tr><td>Tenure</td><td>${p.tenureMonths} months</td></tr>
          </table>
        </div>
        <p>Funds will be credited to your FOSA account once disbursement is processed. You will receive a confirmation email at that time.</p>
      `),
    };
  }

  // ── LOAN REJECTED ─────────────────────────────────────────────

  private loanRejected(p: Extract<EmailJobPayload, { type: 'LOAN_REJECTED' }>) {
    return {
      subject: `Update on your loan application ${p.loanNumber}`,
      body: this.wrap(p.firstName, `
        <h2>Loan Application Update</h2>
        <p>We regret to inform you that your loan application <strong>${p.loanNumber}</strong> has not been approved at this time.</p>
        ${p.reason ? `<div class="highlight"><p style="margin:0"><strong>Reason:</strong> ${p.reason}</p></div>` : ''}
        <p>You are welcome to reapply once you have addressed the above concerns, or visit our offices for further guidance.</p>
        <p>We appreciate your continued membership and trust in Beba SACCO.</p>
      `),
    };
  }

  // ── LOAN DISBURSED ────────────────────────────────────────────

  private loanDisbursed(p: Extract<EmailJobPayload, { type: 'LOAN_DISBURSED' }>) {
    return {
      subject: `Loan ${p.loanNumber} disbursed — ${this.kes(p.principalAmount)} credited`,
      body: this.wrap(p.firstName, `
        <h2>Funds Disbursed 💰</h2>
        <p>Your loan has been disbursed. The funds have been credited to your FOSA account.</p>
        <div class="highlight">
          <table>
            <tr><td>Loan Number</td><td>${p.loanNumber}</td></tr>
            <tr><td>Amount Disbursed</td><td>${this.kes(p.principalAmount)}</td></tr>
            <tr><td>Credited to Account</td><td>${p.accountNumber}</td></tr>
            <tr><td>Monthly Instalment</td><td>${this.kes(p.monthlyInstalment)}</td></tr>
            <tr><td>Final Due Date</td><td>${p.dueDate}</td></tr>
          </table>
        </div>
        <p>Please ensure your FOSA account is funded on or before your monthly instalment date to avoid penalties.</p>
      `),
    };
  }

  // ── GUARANTOR INVITE ──────────────────────────────────────────

  private guarantorInvite(p: Extract<EmailJobPayload, { type: 'GUARANTOR_INVITE' }>) {
    return {
      subject: `${p.borrowerName} has requested you as a guarantor`,
      body: this.wrap(p.firstName, `
        <h2>Guarantor Request</h2>
        <p>Your fellow member <strong>${p.borrowerName}</strong> has listed you as a guarantor for their loan application.</p>
        <div class="highlight">
          <table>
            <tr><td>Loan Number</td><td>${p.loanNumber}</td></tr>
            <tr><td>Loan Principal</td><td>${this.kes(p.loanPrincipal)}</td></tr>
            <tr><td>Your Guaranteed Amount</td><td>${this.kes(p.guaranteedAmount)}</td></tr>
          </table>
        </div>
        <p>Please log in to the Beba SACCO portal to <strong>accept</strong> or <strong>decline</strong> this guarantee request.</p>
        <p>Note: By accepting, your FOSA account balance of ${this.kes(p.guaranteedAmount)} will be reserved as security for this loan.</p>
      `),
    };
  }

  // ── GUARANTOR REMINDER ────────────────────────────────────────

  private guarantorReminder(p: Extract<EmailJobPayload, { type: 'GUARANTOR_REMINDER' }>) {
    return {
      subject: `Reminder: Pending guarantor response for loan ${p.loanNumber}`,
      body: this.wrap(p.firstName, `
        <h2>Friendly Reminder ⏰</h2>
        <p>You have a pending guarantor request from <strong>${p.borrowerName}</strong> that requires your response.</p>
        <div class="highlight">
          <table>
            <tr><td>Loan Number</td><td>${p.loanNumber}</td></tr>
            <tr><td>Your Guaranteed Amount</td><td>${this.kes(p.guaranteedAmount)}</td></tr>
          </table>
        </div>
        <p>Please log in to the Beba SACCO portal to respond. The loan cannot proceed until all guarantors have responded.</p>
      `),
    };
  }

  // ── REPAYMENT RECEIPT ─────────────────────────────────────────

  private repaymentReceipt(p: Extract<EmailJobPayload, { type: 'REPAYMENT_RECEIPT' }>) {
    return {
      subject: `Repayment received — ${this.kes(p.amountPaid)} for loan ${p.loanNumber}`,
      body: this.wrap(p.firstName, `
        <h2>Repayment Confirmed ✅</h2>
        <p>We have received your loan repayment. Here is your receipt:</p>
        <div class="highlight">
          <table>
            <tr><td>Loan Number</td><td>${p.loanNumber}</td></tr>
            <tr><td>Amount Paid</td><td>${this.kes(p.amountPaid)}</td></tr>
            <tr><td>Outstanding Balance</td><td>${this.kes(p.outstandingBalance)}</td></tr>
            <tr><td>Reference</td><td>${p.reference}</td></tr>
            <tr><td>Date</td><td>${p.paidAt}</td></tr>
          </table>
        </div>
        ${p.outstandingBalance <= 0
          ? '<p><strong>🎉 Congratulations! Your loan has been fully repaid.</strong></p>'
          : `<p>Your remaining outstanding balance is <strong>${this.kes(p.outstandingBalance)}</strong>. Thank you for staying on track!</p>`
        }
      `),
    };
  }

  // ── PASSWORD RESET ────────────────────────────────────────────

  private passwordReset(p: Extract<EmailJobPayload, { type: 'PASSWORD_RESET' }>) {
    return {
      subject: 'Reset your Beba SACCO password',
      body: this.wrap(p.firstName, `
        <h2>Password Reset Request 🔒</h2>
        <p>We received a request to reset your password. Click the button below to set a new password:</p>
        <p><a href="${p.resetUrl}" class="btn">Reset Password</a></p>
        <p>This link expires in <strong>${p.expiresInMinutes} minutes</strong>.</p>
        <p>If you did not request a password reset, please ignore this email. Your password will remain unchanged.</p>
        <p>For security, never share this link with anyone.</p>
      `),
    };
  }

  // ── MEMBER KYC APPROVED ───────────────────────────────────────

  private memberApproved(p: Extract<EmailJobPayload, { type: 'MEMBER_APPROVED' }>) {
    return {
      subject: `Your ${p.saccoName} membership has been approved`,
      body: this.wrap(p.firstName, `
        <h2>Membership Approved ✅</h2>
        <p>Congratulations! Your KYC documents have been reviewed and your membership application has been <strong>approved</strong>.</p>
        <div class="highlight">
          <p style="margin:0"><strong>Member Number:</strong> ${p.memberNumber}</p>
        </div>
        <p>Your FOSA and BOSA accounts are now active. Log in to the portal to:</p>
        <ul>
          <li>View your account balances</li>
          <li>Make deposits via M-Pesa</li>
          <li>Apply for a loan</li>
        </ul>
        <p>Welcome to ${p.saccoName}!</p>
      `),
    };
  }

  // ── MEMBER KYC REJECTED ───────────────────────────────────────

  private memberRejected(p: Extract<EmailJobPayload, { type: 'MEMBER_REJECTED' }>) {
    return {
      subject: 'Update on your SACCO membership application',
      body: this.wrap(p.firstName, `
        <h2>Application Update</h2>
        <p>We have reviewed your membership application and are unable to approve it at this time.</p>
        <div class="highlight">
          <p style="margin:0"><strong>Reason:</strong> ${p.reason}</p>
        </div>
        <p>Please address the above and resubmit your application, or visit our offices for assistance.</p>
        <p>We look forward to welcoming you as a member.</p>
      `),
    };
  }
}
