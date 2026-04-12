import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * JWT Authentication Guard
 * 
 * Globally applied guard that validates JWT tokens
 * Respects @Public() decorator to allow unauthenticated routes
 * 
 * TODO: Phase 1 - Implement JWT strategy (passport-jwt)
 * TODO: Phase 1 - Add token blacklist check (Redis)
 * TODO: Phase 1 - Implement refresh token rotation
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Delegate to passport-jwt strategy
    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, info: any) {
    // TODO: Phase 1 - Add detailed error handling
    // - Token expired
    // - Token invalid
    // - Token blacklisted
    // - User deactivated

    if (err || !user) {
      throw err || new UnauthorizedException('Invalid or expired token');
    }
    return user;
  }
}

