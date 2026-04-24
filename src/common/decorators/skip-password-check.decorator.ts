import { SetMetadata } from '@nestjs/common';

/**
 * Routes decorated with @SkipPasswordCheck() are accessible even when
 * the authenticated user has mustChangePassword = true.
 *
 * Apply this to: change-password, logout, and refresh — so a user whose
 * password was force-reset by an admin can still reach the one route they need.
 *
 * Phase 3 hook: also apply to any email-verification or 2FA-setup routes.
 */
export const SKIP_PASSWORD_CHECK_KEY = 'skipPasswordCheck';
export const SkipPasswordCheck = () => SetMetadata(SKIP_PASSWORD_CHECK_KEY, true);
