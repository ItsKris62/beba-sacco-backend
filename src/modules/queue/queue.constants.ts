/**
 * BullMQ queue names – single source of truth.
 * Import from here instead of using string literals.
 */
export const QUEUE_NAMES = {
  MPESA_CALLBACK: 'mpesa.callback',
  MPESA_STK_REPAYMENT: 'mpesa.stk-repayment', // Cron-scheduled STK repayment initiation jobs
  MPESA_DISBURSEMENT: 'mpesa.disbursement', // B2C loan disbursement initiation
  MPESA_DISBURSEMENT_DLQ: 'mpesa.disbursement.dlq', // Dead-letter queue for B2C failures
  MPESA_STK_EXPIRY: 'mpesa.stk-expiry',
  MPESA_B2C_TIMEOUT: 'mpesa.b2c-timeout',
  MPESA_CALLBACK_DLQ: 'mpesa.callback.dlq', // Dead-letter queue for callback failures
  LOAN_GUARANTOR_REMINDER: 'loan.guarantor.reminder',
  LOAN_GUARANTOR_EXPIRY: 'loan.guarantor.expiry',
  REPAYMENT_REMINDER: 'loan.repayment.reminder',
  GUARANTOR_RECOVERY: 'loan.guarantor.recovery',
  GUARANTOR_VALIDATION: 'loan.guarantor.validation',
  GUARANTOR_VALIDATION_DLQ: 'loan.guarantor.validation.dlq',
  AUDIT_LOG: 'audit.log',
  AUDIT_PERSIST: 'audit.persist',
  AUDIT_PERSIST_DLQ: 'audit.persist.dlq',
  LOAN_DISBURSE: 'loan.disburse',
  EMAIL: 'email',
  SMS: 'sms-queue',
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
  // Phase 6 – Scale Intelligence & Policy Automation
  ANALYTICS_STREAM: 'analytics.stream',
  RISK_SCORE: 'risk.score',
  COMPLIANCE_CHECK: 'compliance.policy-check',
  FEATURE_STORE_EXPORT: 'ml.feature-store-export',
  CANARY_ANALYSIS: 'deploy.canary-analysis',
  // Phase 7 – Enterprise Operational Maturity
  SECRET_ROTATION: 'zero-trust.secret-rotation',
  DATA_ERASURE: 'governance.data-erasure',
  PARTNER_PROVISION: 'partners.provision',
  REGULATORY_SUBMISSION: 'compliance.regulatory-submission',
  EXECUTIVE_REPORT: 'reports.executive',
  REPORT_GENERATION: 'reports.generation',
  REPORT_GENERATION_DLQ: 'reports.generation.dlq',
  DOCUMENT_CLEANUP: 'documents.cleanup',
  DR_DRILL: 'sre.dr-drill',
  // Phase 1 – KYC document review async pipeline
  KYC_REVIEW: 'kyc.review',
  KYC_REVIEW_DLQ: 'kyc.review.dlq',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
export const GUARANTOR_VALIDATION_QUEUE_JOB = 'validate';
export const GUARANTOR_EXPIRY_CHECK_JOB = 'guarantor-expiry-check';
export const REPAYMENT_REMINDER_SCAN_JOB = 'repayment-reminder-scan';
export const GUARANTOR_RECOVERY_NOTICE_JOB = 'guarantor-recovery-notice';
export const GUARANTOR_DEBIT_JOB = 'guarantor-debit-execute';
export const DOCUMENT_ORPHAN_CLEANUP_JOB = 'document-orphan-cleanup';

// ─── Job payload types ────────────────────────────────────────────────────────

// ─── M-Pesa job payload types ─────────────────────────────────────────────────

export interface MpesaCallbackJobPayload {
  tenantId: string;
  correlationId?: string;
  /** Raw Daraja callback payload (STK, C2B, or B2C result) */
  callbackPayload: Record<string, unknown>;
  /** Discriminator so the processor routes to the right handler */
  callbackType: 'STK_PUSH' | 'C2B' | 'B2C_RESULT' | 'B2C_TIMEOUT';
}

export interface MpesaDisbursementJobPayload {
  loanId: string;
  tenantId: string;
  /** E.164 phone number (2547XXXXXXXX) – resolved from loan at queue time, not in the processor */
  phone: string;
  /** Disbursement amount in KES (ceiling integer) – resolved from loan at queue time */
  amount: number;
  /** userId of officer or "SYSTEM" for automated disbursements */
  triggeredBy: string;
}

export interface MpesaB2cTimeoutJobPayload {
  loanId: string;
  tenantId: string;
  conversationId: string;
}

export interface GuarantorReminderJobPayload {
  loanId: string;
  guarantorId: string;
  tenantId: string;
  memberId: string;
  loanNumber: string;
}

export interface GuarantorValidationJobPayload {
  guarantorId: string;
  loanId: string;
  tenantId: string;
  memberId: string;
  status: 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
}

export interface GuarantorExpiryJobPayload {
  tenantId?: string;
  loanId?: string;
  guarantorId?: string;
  cutoffIso?: string;
}

export interface RepaymentReminderScanJobPayload {
  tenantId?: string;
  runDateIso: string;
}

export interface InitiateGuarantorRecoveryJobPayload {
  tenantId: string;
  loanId: string;
  actorId: string;
  defaultAmount: string;
  noticeDateIso: string;
}

export interface ExecuteGuarantorDebitJobPayload {
  tenantId: string;
  loanId: string;
  actorId: string;
  defaultAmount: string;
  executeAfterIso: string;
}

export interface ReportGenerationJobPayload {
  jobId: string;
  tenantId: string;
  requestedBy: string;
  type: 'LOAN_BOOK' | 'MEMBER_BALANCES' | 'AUDIT_TRAIL' | 'EXECUTIVE';
  format: 'CSV' | 'PDF';
  filters: {
    from: string;
    to: string;
  };
}

export interface AuditLogJobPayload {
  tenantId: string;
  actorId?: string;
  userId?: string;
  action: string;
  entityType?: string;
  resource: string;
  entityId?: string;
  resourceId?: string;
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export interface AuditPersistJobPayload {
  correlationId: string;
  timestamp?: string;
  tenantId: string;
  userId?: string | null;
  role?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  oldState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  endpoint?: string | null;
  method?: string | null;
  statusCode: number;
  success: boolean;
  errorCode?: string | null;
}

export interface LoanDisburseJobPayload {
  loanId: string;
  tenantId: string;
  disbursedBy: string;
}

// ─── Email job payloads (discriminated union) ─────────────────────────────────

export type EmailJobPayload =
  | WelcomeEmailPayload
  | SystemNoticeEmailPayload
  | LoanApprovedEmailPayload
  | LoanRejectedEmailPayload
  | LoanDisbursedEmailPayload
  | GuarantorInviteEmailPayload
  | GuarantorReminderEmailPayload
  | RepaymentReceiptEmailPayload
  | PasswordResetEmailPayload
  | PasswordResetOtpEmailPayload
  | MemberApprovedEmailPayload
  | MemberRejectedEmailPayload;

interface BaseEmailPayload {
  to: string; // recipient email address
  firstName: string; // used in salutation
}

export interface SystemNoticeEmailPayload extends BaseEmailPayload {
  type: 'SYSTEM_NOTICE';
  subject: string;
  body: string;
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

export interface PasswordResetOtpEmailPayload extends BaseEmailPayload {
  type: 'PASSWORD_RESET_OTP';
  otp: string;
  expiresInMinutes: number;
}

// ─── SMS job payloads ─────────────────────────────────────────────────────────

export interface SmsJobPayload {
  type:
    | 'PASSWORD_RESET_OTP'
    | 'TEMP_PASSWORD'
    | 'GUARANTOR_INVITE'
    | 'REPAYMENT_REMINDER'
    | 'GUARANTOR_RECOVERY_NOTICE'
    | 'GUARANTOR_RECOVERY_DEBITED'
    | 'LOAN_APPROVED'
    | 'LOAN_REJECTED'
    | 'LOAN_PENDING_APPROVAL';
  phone: string;
  message: string;
}

export interface MemberApprovedEmailPayload extends BaseEmailPayload {
  type: 'MEMBER_APPROVED';
  saccoName: string;
  memberNumber: string;
}

export interface MemberRejectedEmailPayload extends BaseEmailPayload {
  type: 'MEMBER_REJECTED';
  reason: string;
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
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP' | 'IN_APP';
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

// ─── Phase 6 job payload types ────────────────────────────────────────────────

export interface AnalyticsStreamJobPayload {
  tenantId: string;
  entityType: string; // Transaction | Loan | Member | Account
  entityId: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  payload: Record<string, unknown>;
  timestamp: string; // ISO string – dedup key
}

export interface RiskScoreJobPayload {
  tenantId: string;
  memberId: string;
  context: 'LOAN_APPLY' | 'DEPOSIT' | 'LOGIN' | 'MANUAL';
  triggerRef?: string;
}

export interface CompliancePolicyCheckJobPayload {
  tenantId: string;
  policy?: string; // CBK | SASRA | ODPC – undefined = all
}

export interface FeatureStoreExportJobPayload {
  tenantId: string;
  version: string; // YYYY-MM-DD
}

export interface CanaryAnalysisJobPayload {
  deploymentId: string;
  version: string;
  prometheusBaseUrl: string;
}
