import { LoanStatus } from '@prisma/client';

export const LOAN_TRANSITIONS: Record<LoanStatus, LoanStatus[]> = {
  DRAFT: ['PENDING_GUARANTORS'],
  PENDING_GUARANTORS: ['UNDER_REVIEW', 'REJECTED'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED'], // legacy path
  APPROVED: ['DISBURSED'],
  REJECTED: [],
  DISBURSED: ['ACTIVE'],
  ACTIVE: ['FULLY_PAID', 'DEFAULTED'],
  FULLY_PAID: [],
  DEFAULTED: ['WRITTEN_OFF', 'ACTIVE'],
  WRITTEN_OFF: [],
};

export function canTransition(from: LoanStatus, to: LoanStatus): boolean {
  return (LOAN_TRANSITIONS[from] || []).includes(to);
}
