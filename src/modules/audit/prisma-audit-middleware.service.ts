import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditEventService } from './audit-event.service';
import { AuditMaskerService } from './audit.masker.service';

const AUDITED_MODELS = new Set([
  'Account',
  'Transaction',
  'MpesaTransaction',
  'Loan',
  'LoanRepayment',
  'LoanGuarantor',
  'Member',
  'Document',
  'MemberApplication',
]);

const MUTATIONS = new Set(['create', 'update', 'delete']);

@Injectable()
export class PrismaAuditMiddlewareService implements OnModuleInit {
  private readonly logger = new Logger(PrismaAuditMiddlewareService.name);
  private attached = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditEvents: AuditEventService,
    private readonly masker: AuditMaskerService,
  ) {}

  onModuleInit(): void {
    const prismaWithMiddleware = this.prisma as PrismaService & {
      $use?: (middleware: Prisma.Middleware) => void;
    };

    if (this.attached || typeof prismaWithMiddleware.$use !== 'function') {
      return;
    }

    prismaWithMiddleware.$use(async (params, next) => {
      if (!params.model || !AUDITED_MODELS.has(params.model) || !MUTATIONS.has(params.action)) {
        return next(params);
      }

      const oldState = params.action === 'create' ? null : await this.readOldState(params);
      const result = await next(params);
      const newState = params.action === 'delete' ? null : this.asRecord(result);
      const tenantId = this.extractTenantId(newState) ?? this.extractTenantId(oldState);

      if (tenantId) {
        this.auditEvents.enqueueFireAndForget({
          tenantId,
          action: 'DB_MUTATION',
          resourceType: params.model,
          resourceId: this.extractId(newState) ?? this.extractId(oldState),
          oldState: this.mask(oldState),
          newState: this.mask(newState),
          metadata: {
            prismaAction: params.action,
          },
          statusCode: 0,
          success: true,
        });
      }

      return result;
    });

    this.attached = true;
    this.logger.log('Prisma DB mutation audit middleware attached');
  }

  private async readOldState(params: Prisma.MiddlewareParams): Promise<Record<string, unknown> | null> {
    if (!params.model || !params.args || typeof params.args !== 'object') {
      return null;
    }

    const args = params.args as { where?: Record<string, unknown> };
    if (!args.where) {
      return null;
    }

    const delegate = (this.prisma as unknown as Record<string, { findUnique?: Function }>)[
      this.delegateName(params.model)
    ];
    if (!delegate?.findUnique) {
      return null;
    }

    try {
      return this.asRecord(await delegate.findUnique({ where: args.where }));
    } catch (error) {
      this.logger.warn(
        `Failed to snapshot old state for ${params.model}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private delegateName(model: string): string {
    return `${model.charAt(0).toLowerCase()}${model.slice(1)}`;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  }

  private extractTenantId(value: Record<string, unknown> | null): string | null {
    const tenantId = value?.tenantId;
    return typeof tenantId === 'string' ? tenantId : null;
  }

  private extractId(value: Record<string, unknown> | null): string | null {
    const id = value?.id;
    return typeof id === 'string' ? id : null;
  }

  private mask(value: Record<string, unknown> | null): Record<string, unknown> | null {
    return value ? this.masker.maskPII(value) : null;
  }
}
