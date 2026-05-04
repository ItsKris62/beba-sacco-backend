import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SKIP_PASSWORD_CHECK_KEY } from '../decorators/skip-password-check.decorator';
import type { AuthenticatedUser } from '../../modules/auth/strategies/jwt.strategy';

/**
 * Global JWT Authentication Guard
 *
 * Applied globally via APP_GUARD in AppModule. Execution order:
 *   ThrottlerGuard → JwtAuthGuard → RolesGuard
 *
 * Responsibilities:
 *  1. Skip authentication for @Public() routes (login, register, webhooks, health)
 *  2. Validate Bearer token via passport-jwt (JwtStrategy)
 *  3. Surface meaningful 401 errors (expired vs invalid)
 *  4. Enforce mustChangePassword — force users to /auth/change-password before
 *     accessing any other protected resource. Routes decorated with
 *     @SkipPasswordCheck() are exempted (change-password, logout, refresh).
 *
 * JTI blocklist check is performed in JwtStrategy.validate() using the raw JWT
 * payload before the DB lookup. It does not need to be repeated here.
 *
 * Phase 3 hook: add 2FA / TOTP verification step here or in a separate guard.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    return super.canActivate(context);
  }

  handleRequest<T extends AuthenticatedUser>(
    err: Error | null,
    user: T | false,
    info: { name?: string; message?: string } | null,
    context: ExecutionContext,
  ): T {
    // Surface granular 401 errors instead of a generic message
    if (err || !user) {
      if (info?.name === 'TokenExpiredError') {
        throw new UnauthorizedException('Access token has expired — please refresh');
      }
      if (info?.name === 'JsonWebTokenError') {
        throw new UnauthorizedException('Malformed access token');
      }
      if (info?.name === 'NotBeforeError') {
        throw new UnauthorizedException('Token not yet valid');
      }
      throw err ?? new UnauthorizedException('Authentication required');
    }

    // Enforce mustChangePassword: block all routes except those explicitly exempted.
    // This fires when an admin force-resets a user's password, requiring them to
    // set a new one before they can do anything else in the system.
    if (user.mustChangePassword) {
      const skip = this.reflector.getAllAndOverride<boolean>(SKIP_PASSWORD_CHECK_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!skip) {
        throw new ForbiddenException(
          'Password change required — please update your password via PATCH /auth/change-password',
        );
      }
    }

    return user;
  }
}
