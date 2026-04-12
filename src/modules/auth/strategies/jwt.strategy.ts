import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * JWT payload shape embedded in every access token.
 * `sub` is always user.id (RFC 7519 convention).
 */
export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  tenantId: string;
  iat?: number;
  exp?: number;
}

/**
 * Authenticated user shape attached to req.user by passport.
 * Typed via Express namespace augmentation (see below).
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  tenantId: string;
  isActive: boolean;
  mustChangePassword: boolean;
}

/**
 * Passport JWT Strategy
 *
 * Validates Bearer tokens on every protected request:
 * 1. Extracts JWT from Authorization: Bearer <token>
 * 2. Verifies signature with JWT_SECRET
 * 3. Confirms user still exists + is active in DB
 * 4. Attaches user to req.user
 *
 * TODO: Phase 2 – add jti (JWT ID) blocklist check in Redis on each request
 * TODO: Phase 3 – add device/session management
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('app.jwt.secret'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        tenantId: true,
        isActive: true,
        mustChangePassword: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account has been deactivated');
    }

    // TODO: Phase 2 – if user.mustChangePassword && route !== /auth/change-password → 403
    return user;
  }
}
