import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
  INestApplication,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { applyPrismaTenantExtension, TENANT_SCOPED_MODELS } from './prisma-tenant.extension';

function withConnectionLimit(url: string | undefined, defaultLimit = '10'): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('connection_limit')) {
      parsed.searchParams.set('connection_limit', process.env.PRISMA_CONNECTION_LIMIT ?? defaultLimit);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Prisma Service - Database Connection Manager
 *
 * Two connection modes:
 * - DATABASE_URL: Neon pooler connection for normal runtime queries.
 * - DATABASE_DIRECT_URL / DIRECT_URL: direct Neon connection for serializable
 *   transactions and operations that must bypass PgBouncer.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly directBaseClient?: PrismaClient;
  private tenantExtensionApplied = false;

  /**
   * Direct, non-pooled Prisma client. Use this for transactions that require
   * explicit isolation levels or any operation that must bypass PgBouncer.
   */
  readonly direct: PrismaClient;

  get client(): PrismaClient {
    return this as unknown as PrismaClient;
  }

  get directClient(): PrismaClient {
    return this.direct;
  }

  constructor() {
    const databaseUrl = withConnectionLimit(process.env.DATABASE_URL);
    super({
      ...(databaseUrl
        ? { datasources: { db: { url: databaseUrl } } }
        : {}),
      log:
        process.env.NODE_ENV === 'development'
          ? ['query', 'info', 'warn', 'error']
          : ['warn', 'error'],
      errorFormat: 'pretty',
    });

    const directUrl = withConnectionLimit(process.env.DATABASE_DIRECT_URL ?? process.env.DIRECT_URL);
    if (directUrl) {
      const directBaseClient = new PrismaClient({
        datasources: { db: { url: directUrl } },
        log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['warn', 'error'],
        errorFormat: 'pretty',
      });

      this.directBaseClient = directBaseClient;
      this.direct = directBaseClient;
    } else {
      this.logger.warn(
        'DATABASE_DIRECT_URL/DIRECT_URL not set; prismaService.direct falls back to pooler. ' +
          '$transaction with isolationLevel may fail on Neon pooler.',
      );
      this.direct = this as unknown as PrismaClient;
    }
  }

  async onModuleInit(): Promise<void> {
    // Prisma opens connections lazily on the first query. Avoid eager $connect()
    // so Neon cold starts do not exhaust pool_timeout during app bootstrap.
    this.attachTenantExtension();
    this.logger.log('Prisma tenant extension attached (lazy-connect mode)');
  }

  private attachTenantExtension(): void {
    if (this.tenantExtensionApplied) {
      return;
    }

    applyPrismaTenantExtension(this);
    if (this.directBaseClient) {
      applyPrismaTenantExtension(this.directBaseClient);
    }
    this.tenantExtensionApplied = true;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    if (this.directBaseClient) {
      await this.directBaseClient.$disconnect();
    }
    this.logger.log('Database connections closed');
  }

  /**
   * Enable shutdown hooks for Prisma.
   */
  async enableShutdownHooks(app: INestApplication): Promise<void> {
    process.on('beforeExit', async () => {
      await app.close();
    });
  }

  /**
   * Set tenant-specific search path for future schema-per-tenant routing.
   */
  async setTenantContext(tenantSchemaName: string): Promise<void> {
    if (!/^tenant_[a-z0-9_]+$/.test(tenantSchemaName)) {
      throw new Error(`Invalid tenant schema name: ${tenantSchemaName}`);
    }

    try {
      await this.$executeRawUnsafe(`SET search_path TO "${tenantSchemaName}", public`);
      this.logger.debug(`Switched to tenant schema: ${tenantSchemaName}`);
    } catch (error) {
      this.logger.error(`Failed to set tenant context: ${tenantSchemaName}`, error);
      throw error;
    }
  }

  /**
   * Reset to the public schema.
   */
  async resetToPublicSchema(): Promise<void> {
    await this.$executeRawUnsafe('SET search_path TO public');
    this.logger.debug('Reset to public schema');
  }

  /**
   * Create an explicitly tenant-scoped Prisma extension for jobs or utilities
   * that run outside the HTTP AsyncLocalStorage request context.
   */
  forContext(tenantId: string, options: { bypassRls?: boolean } = {}) {
    return this.$extends({
      name: 'explicit-tenant-context',
      query: {
        $allModels: {
          async $allOperations({ model, args, query }) {
            const scopedArgs = args as { where?: Record<string, unknown>; data?: unknown };
            if (
              !options.bypassRls &&
              model &&
              (TENANT_SCOPED_MODELS as readonly string[]).includes(model)
            ) {
              scopedArgs.where = {
                ...(scopedArgs.where ?? {}),
                tenantId,
              };
            }
            return query(scopedArgs);
          },
        },
      },
    });
  }

  /**
   * Verify that a tenant schema exists.
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
