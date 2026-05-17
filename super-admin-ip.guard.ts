import { CanActivate, ExecutionContext, Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { Request } from 'express';
import { AlertsService } from '../../alerts/alerts.service';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SuperAdminIpGuard implements CanActivate {
  private readonly logger = new Logger(SuperAdminIpGuard.name);

  constructor(
    private readonly alertsService: AlertsService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user as any; 

    // Pass through if the user is not a SUPER_ADMIN
    if (user?.role !== 'SUPER_ADMIN') {
      return true;
    }

    const allowedIpsStr = process.env.SUPER_ADMIN_ALLOWED_IPS || '';
    const allowedIps = allowedIpsStr.split(',').map((ip) => ip.trim()).filter(Boolean);
    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

    // 1. IP Allowlist Verification
    if (allowedIps.length > 0 && !allowedIps.includes(clientIp)) {
      this.logger.warn(`Unauthorized SUPER_ADMIN access attempt from IP: ${clientIp}, User: ${user.id}`);
      await this.alertsService.sendSlackAlert(
        `:rotating_light: *SECURITY ALERT*\nUnauthorized SUPER_ADMIN access attempt blocked.\n*User ID:* ${user.id}\n*IP:* ${clientIp}`
      );
      throw new ForbiddenException('Access denied from this IP address.');
    }

    // 2. Alert on New IP detection (Session anomaly)
    try {
      const previousLogin = await this.prisma.auditLog.findFirst({
        where: { 
          userId: user.id, 
          ipAddress: clientIp,
          action: 'SUPER_ADMIN_ACCESS'
        },
      });

      if (!previousLogin) {
        await this.alertsService.sendSlackAlert(
          `:warning: *NEW IP DETECTED*\nSUPER_ADMIN accessed from a new authorized IP.\n*User ID:* ${user.id}\n*IP:* ${clientIp}`
        );
      }
    } catch (error) {
      // Non-blocking failure for auditing
      this.logger.error('Failed to verify previous SUPER_ADMIN logins', error);
    }

    return true;
  }
}