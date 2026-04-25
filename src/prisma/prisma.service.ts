import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
  INestApplication,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

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

