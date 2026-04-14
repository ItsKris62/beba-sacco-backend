/**
 * BullMQ queue names – single source of truth.
 * Import from here instead of using string literals.
 */
export const QUEUE_NAMES = {
  MPESA_CALLBACK: 'mpesa.callback',
  LOAN_GUARANTOR_REMINDER: 'loan.guarantor.reminder',
  AUDIT_LOG: 'audit.log',
  LOAN_DISBURSE: 'loan.disburse',
  EMAIL: 'email',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ─── Job payload types ────────────────────────────────────────────────────────

export interface MpesaCallbackJobPayload {
  tenantId: string;
  callbackPayload: Record<string, unknown>;
}

export interface GuarantorReminderJobPayload {
  loanId: string;
  guarantorId: string;
  tenantId: string;
  memberId: string;
  loanNumber: string;
}

export interface AuditLogJobPayload {
  tenantId: string;
  userId?: string;
  action: string;
  resource: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export interface LoanDisburseJobPayload {
  loanId: string;
  tenantId: string;
  disbursedBy: string;
}

// ─── Email job payloads (discriminated union) ─────────────────────────────────

export type EmailJobPayload =
  | WelcomeEmailPayload
  | LoanApprovedEmailPayload
  | LoanRejectedEmailPayload
  | LoanDisbursedEmailPayload
  | GuarantorInviteEmailPayload
  | GuarantorReminderEmailPayload
  | RepaymentReceiptEmailPayload
  | PasswordResetEmailPayload;

interface BaseEmailPayload {
  to: string;       // recipient email address
  firstName: string; // used in salutation
}

export interface WelcomeEmailPayload extends BaseEmailPayload {
  type: 'WELCOME';
  saccoName: string;
}

export interface LoanApprovedEmailPayload extends BaseEmailPayload {
  type: 'LOAN_APPROVED';
  loanNumber: string;
  principalAmount: number;
  monthlyInstalment: number;
  tenureMonths: number;
}

export interface LoanRejectedEmailPayload extends BaseEmailPayload {
  type: 'LOAN_REJECTED';
  loanNumber: string;
  reason?: string;
}

export interface LoanDisbursedEmailPayload extends BaseEmailPayload {
  type: 'LOAN_DISBURSED';
  loanNumber: string;
  principalAmount: number;
  monthlyInstalment: number;
  dueDate: string;
  accountNumber: string;
}

export interface GuarantorInviteEmailPayload extends BaseEmailPayload {
  type: 'GUARANTOR_INVITE';
  borrowerName: string;
  loanNumber: string;
  guaranteedAmount: number;
  loanPrincipal: number;
}

export interface GuarantorReminderEmailPayload extends BaseEmailPayload {
  type: 'GUARANTOR_REMINDER';
  borrowerName: string;
  loanNumber: string;
  guaranteedAmount: number;
}

export interface RepaymentReceiptEmailPayload extends BaseEmailPayload {
  type: 'REPAYMENT_RECEIPT';
  loanNumber: string;
  amountPaid: number;
  outstandingBalance: number;
  reference: string;
  paidAt: string;
}

export interface PasswordResetEmailPayload extends BaseEmailPayload {
  type: 'PASSWORD_RESET';
  resetUrl: string;
  expiresInMinutes: number;
}
