import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Guard for securing M-Pesa callback endpoints.
 *
 * Enforces two security layers as per requirements:
 *   1. The request IP must be whitelisted in the MPESA_CALLBACK_IPS environment variable
 *      (comma‑separated list of allowed IP addresses).
 *   2. The Authorization header must contain a Bearer token that matches MPESA_CALLBACK_SECRET.
 */
@Injectable()
export class MpesaCallbackGuard implements CanActivate {
  private allowedIps: Set<string>;
  private secret: string;

  constructor(private readonly configService: ConfigService) {
    const ips = this.configService.get<string>('MPESA_CALLBACK_IPS') ?? '';
    this.allowedIps = new Set(
      ips
        .split(',')
        .map((ip) => ip.trim())
        .filter((ip) => ip.length > 0),
    );
    this.secret = this.configService.get<string>('MPESA_CALLBACK_SECRET') ?? '';
    if (!this.secret) {
      throw new BadRequestException('MPESA_CALLBACK_SECRET is not configured');
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const ip = request.ip || request.connection?.remoteAddress;
    if (!ip) {
      throw new UnauthorizedException('Unable to determine request IP');
    }
    // If IP whitelist is configured, validate the request IP.
    if (this.allowedIps.size > 0 && !this.allowedIps.has(ip)) {
      throw new UnauthorizedException('IP address not allowed for M-Pesa callbacks');
    }

    const authHeader: string | undefined = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }
    const token = authHeader.slice('Bearer '.length).trim();
    if (token !== this.secret) {
      throw new UnauthorizedException('Invalid M-Pesa callback secret');
    }

    // All checks passed.
    return true;
  }
}
