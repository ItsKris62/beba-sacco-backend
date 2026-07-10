export const DOMAIN_EVENTS = {
  LOAN: {
    APPLICATION_RECEIVED: 'loan.application.received',
    KYC_PENDING: 'loan.kyc.pending',
    STATUS_CHANGED: 'loan.status.changed',
    APPROVED: 'loan.approved',
    DISBURSED: 'loan.disbursed',
    REPAYMENT_DUE: 'loan.repayment.due',
    REPAYMENT_SUCCESSFUL: 'loan.repayment.successful',
    REPAID: 'loan.repaid',
    DEFAULTED: 'loan.defaulted',
    REJECTED: 'loan.rejected',
  },
  GUARANTOR: {
    REQUESTED: 'guarantor.requested',
    RESPONSE_RECEIVED: 'guarantor.response.received',
    ACCEPTED: 'guarantor.accepted',
    REJECTED: 'guarantor.rejected',
    FORFEITED: 'guarantor.forfeited',
    HOLD_RELEASED: 'guarantor.hold.released',
  },
  MPESA: {
    CALLBACK_RECEIVED: 'mpesa.callback.received',
    DEPOSIT_SUCCESS: 'mpesa.deposit.success',
    DEPOSIT_FAILED: 'mpesa.deposit.failed',
    REPAYMENT_SUCCESS: 'mpesa.repayment.success',
    REPAYMENT_FAILED: 'mpesa.repayment.failed',
    DISBURSEMENT_SUCCESS: 'mpesa.disbursement.success',
    DISBURSEMENT_FAILED: 'mpesa.disbursement.failed',
  },
  KYC: {
    STATUS_CHANGED: 'kyc.status.changed',
    APPROVED: 'kyc.approved',
    REJECTED: 'kyc.rejected',
    PENDING_REVIEW: 'kyc.pending_review',
  },
  MEMBER: {
    CREATED: 'member.created',
    ACCOUNT_ACTIVATED: 'member.account.activated',
    ACCOUNT_DEACTIVATED: 'member.account.deactivated',
    APPLICATION_APPROVED: 'member.application.approved',
    APPLICATION_REJECTED: 'member.application.rejected',
    MONTHLY_STATEMENT_GENERATED: 'member.statement.monthly.generated',
  },
} as const;

type ValueOf<T> = T extends unknown ? T[keyof T] : never;
type EventNamespace = ValueOf<typeof DOMAIN_EVENTS>;

export type DomainEventName = ValueOf<EventNamespace>;
