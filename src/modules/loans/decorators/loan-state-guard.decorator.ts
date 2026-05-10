import { SetMetadata } from '@nestjs/common';

export const LOAN_STATE_GUARD_KEY = 'loanStateGuard';

export interface LoanStateGuardOptions {
  loanIdParam?: string;
  targetStatusBodyField?: string;
}

export const LoanStateGuard = (options: LoanStateGuardOptions = {}) =>
  SetMetadata(LOAN_STATE_GUARD_KEY, {
    loanIdParam: options.loanIdParam ?? 'id',
    targetStatusBodyField: options.targetStatusBodyField ?? 'status',
  } satisfies Required<LoanStateGuardOptions>);
