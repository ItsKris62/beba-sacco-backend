import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';

/**
 * Auth Module
 *
 * Registers:
 * - PassportModule with default 'jwt' strategy
 * - JwtModule (for access token signing only; refresh uses jwtService.sign with override secret)
 * - JwtStrategy (passport provider — validates Bearer tokens on every protected request)
 * - AuditModule (for auth event audit trail)
 *
 * TODO: Phase 2 – add OAuth2 strategies (GoogleStrategy, MicrosoftStrategy)
 * TODO: Phase 3 – add TotpStrategy for 2FA
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),

    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Default secret/expiry for access tokens.
        // Refresh tokens use explicit overrides in AuthService.generateTokens().
        secret: config.getOrThrow<string>('app.jwt.secret'),
        signOptions: {
          expiresIn: config.get<string>('app.jwt.accessExpiration', '15m'),
        },
      }),
    }),

    AuditModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, PrismaService, JwtStrategy],
  exports: [AuthService, JwtModule, PassportModule],
})
export class AuthModule {}
