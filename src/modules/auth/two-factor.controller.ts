import { Controller, Post, Body, UseGuards, Req, HttpCode, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { TwoFactorService } from './two-factor.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { TwoFactorSetupGuard } from './guards/two-factor-setup.guard';
import { PrismaService } from '../../prisma/prisma.service';
import * as argon2 from 'argon2';

@Controller('api/v1/auth/2fa')
export class TwoFactorController {
  constructor(
    private readonly twoFactorService: TwoFactorService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('generate')
  @UseGuards(TwoFactorSetupGuard)
  async generate(@Req() req: any) {
    return this.twoFactorService.generateSecret(req.user.id, req.user.email);
  }

  @Post('verify')
  @UseGuards(TwoFactorSetupGuard)
  @HttpCode(200)
  async verifyAndEnable(@Req() req: any, @Body('secret') secret: string, @Body('token') token: string) {
    return this.twoFactorService.verifyAndEnable(req.user.id, req.user.tenantId, secret, token, req.ip);
  }

  @Post('backup-codes/regenerate')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async regenerateBackupCodes(@Req() req: any, @Body('password') password?: string, @Body('token') token?: string) {
    if (!password && !token) {
      throw new ForbiddenException('Password or TOTP token required');
    }

    const user = await this.prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
        throw new UnauthorizedException();
    }
    
    if (password) {
      const isValid = await argon2.verify(user.passwordHash, password);
      if (!isValid) throw new ForbiddenException('Invalid password');
    } else if (token) {
      await this.twoFactorService.verifyToken(req.user.id, token, req.user.tenantId);
    }

    return this.twoFactorService.regenerateBackupCodes(req.user.id, req.user.tenantId, req.ip);
  }

  @Post('disable')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async disable(@Req() req: any, @Body('password') password?: string, @Body('token') token?: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: req.user.tenantId } });
    if ((tenant?.settings as any)?.security?.require2FA === true) {
      throw new ForbiddenException('Tenant policy requires 2FA. You cannot disable it.');
    }

    const user = await this.prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
      throw new UnauthorizedException();
    }

    if (password) {
      const isValid = await argon2.verify(user.passwordHash, password);
      if (!isValid) throw new ForbiddenException('Invalid password');
    } else if (token) {
       await this.twoFactorService.verifyToken(req.user.id, token, req.user.tenantId);
    } else {
        throw new ForbiddenException('Password or TOTP token required');
    }

    await this.twoFactorService.disable2FA(req.user.id, req.user.tenantId, req.ip);
    return { success: true };
  }
}
