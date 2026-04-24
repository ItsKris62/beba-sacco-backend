import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

/**
 * Guards callback endpoints by validating the caller's IP against
 * Safaricom's published IP ranges.
 *
 * SASRA compliance note: Only Safaricom IPs should be allowed to POST
 * to callback endpoints. Bypassing this guard would allow forged callbacks
 * to credit arbitrary accounts.
 *
 * In sandbox mode (MPESA_ENVIRONMENT != 'production') OR when no IPs are
 * configured (MPESA_ALLOWED_IPS empty), the guard passes all traffic so
 * local development works without a VPN tunnel.
 *
 * Production IP list (May 2025 – verify against Safaricom portal):
 *   196.201.214.200, 196.201.214.206, 196.201.213.114, 196.201.214.207,
 *   196.201.214.208, 196.201.213.44, 196.201.214.185, 196.201.214.186
 */
@Injectable()
export class MpesaIpGuard implements CanActivate {
  private readonly logger = new Logger(MpesaIpGuard.name);
  private readonly allowedIps: Set<string>;
  private readonly enforced: boolean;

  constructor(private readonly config: ConfigService) {
    const ips: string[] = config.get<string[]>('app.mpesa.allowedIps', []);
    this.allowedIps = new Set(ips.filter(Boolean));
    this.enforced =
      config.get<string>('app.mpesa.environment', 'sandbox') === 'production' &&
      this.allowedIps.size > 0;
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (!this.enforced) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const callerIp = this.resolveIp(req);

    if (this.allowedIps.has(callerIp)) {
      return true;
    }

    // Log the blocked IP for security incident review – never log request body
    this.logger.warn(`Mpesa callback rejected from unauthorised IP: ${callerIp}`);
    throw new ForbiddenException('Callback origin not in Safaricom IP allowlist');
  }

  /**
   * Resolve the actual caller IP.
   * In production the app sits behind a reverse proxy (nginx / Cloud Run),
   * so we read X-Forwarded-For. We trust only the leftmost (client) IP.
   */
  private resolveIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = Array.isArray(forwarded)
        ? forwarded[0]
        : forwarded.split(',')[0];
      return first.trim();
    }
    return req.socket?.remoteAddress ?? req.ip ?? '';
  }
}
