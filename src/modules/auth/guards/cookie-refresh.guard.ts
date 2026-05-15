import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';

/**
 * Reads the HttpOnly `refresh_token` cookie and injects its value into
 * `req.body.refreshToken` so that the existing RefreshTokenDto validation
 * and AuthService.refreshToken() work without modification.
 *
 * Falls back gracefully when the cookie is absent — the controller then
 * reads from req.body directly (for API clients that send the token in the body).
 *
 * Always returns true: token validity is enforced by AuthService, not here.
 */
@Injectable()
export class CookieRefreshGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { cookies?: Record<string, string> }>();
    const cookie = req.cookies?.['refresh_token'] as string | undefined;

    if (cookie && !(req.body as Record<string, unknown>)?.refreshToken) {
      (req.body as Record<string, unknown>) = {
        ...(req.body as Record<string, unknown>),
        refreshToken: cookie,
      };
    }

    return true;
  }
}
