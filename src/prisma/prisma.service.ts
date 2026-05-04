import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
  INestApplication,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { tenantAsyncStorage } from '../common/services/tenant-context.service';

/**
 * Prisma Service - Database Connection Manager
 *
 * Two connection modes (Neon specifics):
 *
 *   DATABASE_URL  — Neon pooler (PgBouncer, transaction mode).
 *                   Used by PrismaService itself for all runtime queries.
 *                   BullMQ also uses this connection.
 *
 *   DIRECT_URL    — Direct Neon connection (bypasses PgBouncer).
 *                   Required for:
 *                     • `prisma migrate deploy` (run in preDeployCommand)
 *                     • `$transaction` with explicit isolationLevel
 *                       (e.g. SERIALIZABLE for financial reconciliation)
 *                     • SET search_path for per-tenant schema switching (Phase 3+)
 *
 * Use `prismaService.direct.$transaction(...)` for any Prisma transaction
 * that sets an explicit isolationLevel. Plain `$transaction` (no isolationLevel)
 * works fine through the pooler.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /**
   * Direct (non-pooled) Prisma client.
   *
   * Use this for $transaction calls that require an explicit isolationLevel,
   * or for any operation that must bypass PgBouncer (e.g. LISTEN/NOTIFY,
   * advisory locks, SET search_path). Falls back to the pooler client if
   * DIRECT_URL is not configured — which will fail at the DB level if an
   * unsupported PgBouncer command is issued.
   *
   * @example
   * await this.prisma.direct.$transaction(
   *   async (tx) => { ... },
   *   { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
   * );
   */
  readonly direct: PrismaClient;

  constructor() {
    super({
      log:
        process.env.NODE_ENV === 'development'
          ? ['query', 'info', 'warn', 'error']
          : ['warn', 'error'],
      errorFormat: 'pretty',
    });

    // If DIRECT_URL is set, the Prisma schema's `directUrl` field picks it up
    // automatically for migrations. We create a second client here that explicitly
    // uses DIRECT_URL so application code can access it via `prismaService.direct`.
    const directUrl = process.env.DIRECT_URL;
    if (directUrl) {
      this.direct = new PrismaClient({
        datasources: { db: { url: directUrl } },
        log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['warn', 'error'],
        errorFormat: 'pretty',
      });
    } else {
      // Fallback: same pooler client — transactions without isolationLevel still work.
      // Log a warning so operators know to set DIRECT_URL before using isolation levels.
      this.logger.warn(
        'DIRECT_URL not set — prismaService.direct falls back to pooler. ' +
          '$transaction with isolationLevel will fail on Neon pooler.',
      );
      this.direct = this as unknown as PrismaClient;
    }
  }

  async onModuleInit() {
    try {
      await this.$connect();
      if (this.direct !== (this as unknown as PrismaClient)) {
        await this.direct.$connect();
      }
      this.logger.log('✅ Database connections established (pooler + direct)');
    } catch (error) {
      this.logger.error('❌ Failed to connect to database', error);
      throw error;
    }

    this.attachTenantMiddleware();
    this.attachAppendOnlyMiddleware();
  }

  /**
   * Prisma middleware that auto-injects tenantId into every query.
   * This is the final defense against cross-tenant data leakage.
   */
  private attachTenantMiddleware(): void {
    const tenantScopedModels = new Set([
      'User', 'Member', 'Account', 'Loan', 'LoanProduct',
      'Transaction', 'Guarantor', 'MpesaTransaction', 'AuditLog',
      'LoanApprovalChain', 'LoginSession', 'WebhookSubscription',
      'IntegrationOutbox', 'CrbReport', 'AmlScreening',
      'ProvisioningEntry', 'DsarRequest', 'SasraRatioSnapshot',
      'CbkReturn', 'ApiClient', 'NotificationLog', 'ComplianceAlert',
      'DataImportLog', 'TenantCounter', 'LoanRepayment', 'SavingsRecord',
      'GroupWelfare', 'GroupWelfareCollection', 'RefreshSession',
      'DataConsent', 'MemberApplication', 'Stage', 'StageAssignment',
      'Partner', 'PartnerUsageSnapshot', 'SlaIncident', 'ExecutiveReport',
      'FeatureFlag', 'RiskScore', 'FeatureSnapshot', 'TenantRegionConfig',
      'CanaryDeployment', 'DataAccessLog', 'ConsentRegistry', 'ErasureRequest',
    ]);

    this.$use(async (params, next) => {
      if (!params.model || !tenantScopedModels.has(params.model)) {
        return next(params);
      }

      // Skip raw queries
      if (params.action === 'executeRaw' || params.action === 'queryRaw') {
        return next(params);
      }

      const store = tenantAsyncStorage.getStore();
      const tenantId = store?.tenantId;

      if (!tenantId) {
        // Allow unscoped queries only for specific actions (e.g., seeding, migrations)
        // In production HTTP context, tenantId should always be present.
        return next(params);
      }

      // Inject tenantId into WHERE clauses for reads
      if (
        params.action === 'findUnique' ||
        params.action === 'findFirst' ||
        params.action === 'findMany' ||
        params.action === 'count' ||
        params.action === 'aggregate' ||
        params.action === 'groupBy'
      ) {
        params.args.where = {
          ...params.args.where,
          tenantId,
        };
      }

      // Inject tenantId into CREATE data
      if (params.action === 'create' || params.action === 'createMany') {
        if (Array.isArray(params.args.data)) {
          params.args.data = params.args.data.map((d: Record<string, unknown>) => ({
            ...d,
            tenantId,
          }));
        } else {
          params.args.data = {
            ...params.args.data,
            tenantId,
          };
        }
      }

      // Inject tenantId into UPDATE where + data
      if (params.action === 'update' || params.action === 'updateMany') {
        if (params.args.where) {
          params.args.where = { ...params.args.where, tenantId };
        }
      }

      if (params.action === 'upsert') {
        if (params.args.where) {
          params.args.where = { ...params.args.where, tenantId };
        }
        params.args.create = { ...params.args.create, tenantId };
      }

      // Inject tenantId into DELETE where
      if (params.action === 'delete' || params.action === 'deleteMany') {
        if (params.args.where) {
          params.args.where = { ...params.args.where, tenantId };
        }
      }

      return next(params);
    });

    this.logger.log('🔒 Tenant isolation middleware attached');
  }

  /**
   * Prisma middleware that blocks UPDATE and DELETE on AuditLog.
   * Enforces append-only immutability at the ORM layer.
   */
  private attachAppendOnlyMiddleware(): void {
    this.$use(async (params, next) => {
      if (params.model === 'AuditLog') {
        if (params.action.startsWith('update') || params.action.startsWith('delete')) {
          this.logger.error(
            `Blocked ${params.action} on AuditLog (append-only enforced)`,
          );
          throw new Error(
            'AuditLog is append-only: updates and deletes are forbidden',
          );
        }
      }
      return next(params);
    });

    this.logger.log('🔒 AuditLog append-only middleware attached');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    if (this.direct !== (this as unknown as PrismaClient)) {
      await this.direct.$disconnect();
    }
    this.logger.log('Database connections closed');
  }

  /**
   * Enable shutdown hooks for Prisma
   * Required for graceful shutdown in production
   */
  async enableShutdownHooks(app: INestApplication) {
    process.on('beforeExit', async () => {
      await app.close();
    });
  }

  /**
   * Set tenant-specific search path for multi-tenancy
   * 
   * Usage:
   * await prismaService.setTenantContext('tenant_kc_boda');
   * 
   * TODO: Phase 1 - Implement proper tenant validation
   * TODO: Phase 1 - Add caching for tenant schema names
   * TODO: Phase 1 - Handle schema not found errors
   */
  async setTenantContext(tenantSchemaName: string): Promise<void> {
    // Security: Validate schema name format to prevent SQL injection
    if (!/^tenant_[a-z0-9_]+$/.test(tenantSchemaName)) {
      throw new Error(`Invalid tenant schema name: ${tenantSchemaName}`);
    }

    try {
      await this.$executeRawUnsafe(
        `SET search_path TO "${tenantSchemaName}", public`,
      );
      this.logger.debug(`Switched to tenant schema: ${tenantSchemaName}`);
    } catch (error) {
      this.logger.error(`Failed to set tenant context: ${tenantSchemaName}`, error);
      throw error;
    }
  }

  /**
   * Reset to public schema (useful for admin operations)
   * 
   * TODO: Phase 1 - Add role-based access control
   */
  async resetToPublicSchema(): Promise<void> {
    await this.$executeRawUnsafe(`SET search_path TO public`);
    this.logger.debug('Reset to public schema');
  }

  /**
   * Verify tenant schema exists
   * 
   * TODO: Phase 1 - Implement schema existence check
   */
  async tenantSchemaExists(schemaName: string): Promise<boolean> {
    const result = await this.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS(
        SELECT 1 FROM information_schema.schemata 
        WHERE schema_name = ${schemaName}
      ) as exists
    `;
    return result[0]?.exists ?? false;
  }
}

