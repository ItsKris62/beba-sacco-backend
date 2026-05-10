import { LoanStatus } from '@prisma/client';

export const LOAN_TRANSITIONS: Record<LoanStatus, readonly LoanStatus[]> = {
  DRAFT: [LoanStatus.PENDING_GUARANTORS, LoanStatus.PENDING_APPROVAL, LoanStatus.REJECTED],
  PENDING_GUARANTORS: [LoanStatus.PENDING_REVIEW, LoanStatus.REJECTED_GUARANTOR_DECLINE, LoanStatus.REJECTED],
  PENDING_REVIEW: [LoanStatus.APPROVED, LoanStatus.REJECTED],
  PENDING_APPROVAL: [LoanStatus.APPROVED, LoanStatus.REJECTED],
  APPROVED: [LoanStatus.DISBURSED, LoanStatus.ACTIVE],
  DISBURSED: [LoanStatus.ACTIVE],
  ACTIVE: [LoanStatus.FULLY_PAID, LoanStatus.DEFAULTED],
  DEFAULTED: [LoanStatus.WRITTEN_OFF, LoanStatus.ACTIVE],
  REJECTED: [],
  REJECTED_GUARANTOR_DECLINE: [],
  FULLY_PAID: [],
  WRITTEN_OFF: [],
};

export function canTransition(from: LoanStatus, to: LoanStatus): boolean {
  return (LOAN_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: LoanStatus, to: LoanStatus): void {
  if (!canTransition(from, to)) {
    const allowed = (LOAN_TRANSITIONS[from] ?? []).join(', ') || 'none';
    throw new Error(`INVALID_LOAN_STATUS_TRANSITION: ${from} -> ${to}. Allowed: ${allowed}`);
  }
}
