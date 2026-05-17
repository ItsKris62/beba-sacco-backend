import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SuperAdminAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(SuperAdminAuditInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user as any;

    return next.handle().pipe(
      tap(() => {
        if (user?.role === 'SUPER_ADMIN') {
          const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
          const userAgent = req.headers['user-agent'] || 'unknown';
          const sessionId = (req.headers['x-session-id'] as string) || 'unknown';

          // Write-behind audit logging (non-blocking)
          this.prisma.auditLog.create({
            data: {
              userId: user.id,
              tenantId: user.tenantId, // Maintains tenant isolation
              action: 'SUPER_ADMIN_ACCESS',
              ipAddress: clientIp,
              userAgent,
              sessionId,
              resource: `${req.method} ${req.route.path}`,
              status: 'SUCCESS',
            },
          }).catch(err => this.logger.error('Failed to write SUPER_ADMIN audit log', err));
        }
      })
    );
  }
}