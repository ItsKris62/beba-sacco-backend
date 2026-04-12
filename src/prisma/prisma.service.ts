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
 * Features:
 * - Automatic connection pooling
 * - Graceful shutdown handling
 * - Query logging in development
 * - Multi-tenant schema switching support
 * 
 * TODO: Phase 1 - Implement tenant schema switching via $executeRawUnsafe
 * TODO: Phase 1 - Add connection pool monitoring
 * TODO: Phase 2 - Implement read replicas for analytics queries
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log:
        process.env.NODE_ENV === 'development'
          ? ['query', 'info', 'warn', 'error']
          : ['warn', 'error'],
      errorFormat: 'pretty',
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('✅ Database connection established');
    } catch (error) {
      this.logger.error('❌ Failed to connect to database', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database connection closed');
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

