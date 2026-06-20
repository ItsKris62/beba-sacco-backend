import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { JwtBlocklistService } from '../jwt-blocklist.service';

/**
 * JWT payload shape embedded in every access token.
 * `sub` is always user.id (RFC 7519 convention).
 * `jti` is a unique token ID used for immediate revocation via Redis blocklist.
 */
export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  tenantId: string;
  jti: string;
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
 * 3. Checks Redis blocklist for revoked JTIs (immediate revocation)
 * 4. Confirms user still exists + is active in DB
 * 5. Verifies the token tenant matches the database tenant
 * 6. Attaches user to req.user
 *
 * TODO: Phase 3 - add device/session management
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly blocklist: JwtBlocklistService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('app.jwt.secret'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    // Phase 2: Check blocklist for revoked tokens (phone theft / password change)
    const blocked = await this.blocklist.isBlocked(payload.jti);
    if (blocked) {
      throw new UnauthorizedException('Token has been revoked');
    }

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

    if (user.tenantId !== payload.tenantId && user.role !== UserRole.SUPER_ADMIN) {
      throw new UnauthorizedException('Token tenant mismatch');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account has been deactivated');
    }

    return user;
  }
}
