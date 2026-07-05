import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class PasswordPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async validatePassword(tenantId: string, password: string): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });

    const settings = (tenant?.settings as any) || {};
    const policy = settings.security?.passwordPolicy || {};

    const minLength = typeof policy.minLength === 'number' ? policy.minLength : 8;
    const requireComplexity = policy.requireComplexity === true;

    if (password.length < minLength) {
      throw new BadRequestException(`Password must be at least ${minLength} characters long`);
    }

    if (requireComplexity) {
      const hasUppercase = /[A-Z]/.test(password);
      const hasLowercase = /[a-z]/.test(password);
      const hasDigit = /[0-9]/.test(password);
      const hasSpecial = /[^A-Za-z0-9]/.test(password);

      if (!hasUppercase || !hasLowercase || !hasDigit || !hasSpecial) {
        throw new BadRequestException(
          'Password must contain at least one uppercase letter, one lowercase letter, one digit, and one special character',
        );
      }
    }
  }

  async validatePasswordAge(tenantId: string, lastChange: Date): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });

    const expiryDays = (tenant?.settings as any)?.security?.passwordPolicy?.expiryDays;
    if (typeof expiryDays === 'number' && expiryDays > 0) {
      const passwordAgeMs = Date.now() - lastChange.getTime();
      const passwordAgeDays = passwordAgeMs / (1000 * 60 * 60 * 24);
      if (passwordAgeDays > expiryDays) {
        throw new BadRequestException(`Password expired. Please change your password.`);
      }
    }
  }
}
