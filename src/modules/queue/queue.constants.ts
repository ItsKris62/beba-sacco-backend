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
  // Phase 4 – Financial Operations
  INTEREST_ACCRUAL: 'financial.interest-accrual',
  REPAYMENT_SCHEDULE: 'financial.repayment-schedule',
  MPESA_RECONCILIATION: 'financial.mpesa-reconciliation',
  LEDGER_INTEGRITY: 'financial.ledger-integrity',
  // Phase 4 – Outbound Webhooks
  OUTBOUND_WEBHOOK: 'webhooks.outbound',
  // Phase 5 – Enterprise Integrations
  CRB_EXPORT: 'integrations.crb-export',
  AML_SCREEN: 'integrations.aml-screen',
  NOTIFY_MULTI: 'notifications.multi-channel',
  OUTBOX_PUBLISH: 'integrations.outbox-publish',
  IFRS9_ECL: 'compliance.ifrs9-ecl',
  DSAR_PROCESS: 'compliance.dsar-process',
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

// ─── Phase 4 job payload types ────────────────────────────────────────────────

export interface InterestAccrualJobPayload {
  /** ISO date string (YYYY-MM-DD) – the accrual date, used for idempotency */
  accrualDate: string;
  tenantId: string;
}

export interface RepaymentScheduleJobPayload {
  loanId: string;
  tenantId: string;
  /** ISO date string – scheduled due date for this instalment */
  dueDate: string;
  instalmentAmount: number;
}

export interface MpesaReconciliationJobPayload {
  /** ISO date string (YYYY-MM-DD) – settlement date to reconcile */
  settlementDate: string;
  tenantId: string;
}

export interface LedgerIntegrityJobPayload {
  tenantId: string;
}

export interface OutboundWebhookJobPayload {
  subscriptionId: string;
  deliveryId: string;
  event: string;
  payload: Record<string, unknown>;
  attempt: number;
}

// ─── Phase 5 job payload types ────────────────────────────────────────────────

export interface CrbExportJobPayload {
  tenantId: string;
  reportId: string;
  outboxId: string;
}

export interface AmlScreenJobPayload {
  tenantId: string;
  screeningId: string;
  memberId: string;
  trigger: 'KYC' | 'DEPOSIT' | 'MANUAL';
  triggerRef?: string;
}

export interface MultiChannelNotifyJobPayload {
  tenantId: string;
  notificationId: string;
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP';
  recipient: string;
  templateId: string;
  payload: Record<string, unknown>;
}

export interface OutboxPublishJobPayload {
  outboxId: string;
}

export interface Ifrs9EclJobPayload {
  tenantId: string;
  calculationDate: string; // YYYY-MM-DD
}

export interface DsarProcessJobPayload {
  tenantId: string;
  dsarRequestId: string;
  memberId: string;
}
