import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

@Injectable()
export class MetricsApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(MetricsApiKeyGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const configuredKey = process.env.METRICS_API_KEY;
    const nodeEnv = process.env.NODE_ENV ?? 'development';

    if (!configuredKey) {
      if (nodeEnv === 'production') {
        throw new UnauthorizedException('Invalid metrics API key');
      }

      this.logger.warn('METRICS_API_KEY is unset; allowing /metrics in non-production');
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.headers.authorization;
    const providedKey = this.extractBearerToken(authorization);

    if (!providedKey || !this.safeEquals(providedKey, configuredKey)) {
      throw new UnauthorizedException('Invalid metrics API key');
    }

    return true;
  }

  private extractBearerToken(authorization?: string): string | null {
    if (!authorization?.startsWith('Bearer ')) {
      return null;
    }

    const token = authorization.slice('Bearer '.length).trim();
    return token.length > 0 ? token : null;
  }

  private safeEquals(providedKey: string, configuredKey: string): boolean {
    const provided = Buffer.from(providedKey);
    const configured = Buffer.from(configuredKey);

    if (provided.length !== configured.length) {
      return false;
    }

    return timingSafeEqual(provided, configured);
  }
}
