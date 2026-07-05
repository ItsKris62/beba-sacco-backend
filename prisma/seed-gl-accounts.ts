/**
 * seed-gl-accounts.ts
 *
 * Seeds the default SACCO Chart of Accounts (and default FOSA/BOSA balance
 * policies) for a given tenant, via the real Nest DI graph — calls
 * AccountingService.provisionTenantAccounting() rather than duplicating the
 * seed logic here. Idempotent: safe to re-run for a tenant that's already
 * been provisioned.
 *
 * Run with: npx ts-node -r tsconfig-paths/register prisma/seed-gl-accounts.ts <tenantId>
 */
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AccountingService } from '../src/modules/accounting/accounting.service';

const prisma = new PrismaClient();

async function main() {
  const tenantId = process.argv[2];
  if (!tenantId) {
    console.error('Usage: npx ts-node prisma/seed-gl-accounts.ts <tenantId>');
    process.exit(1);
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    console.error(`Tenant ${tenantId} not found`);
    process.exit(1);
  }

  console.log(`Seeding GL accounts + account-type policies for tenant: ${tenant.name} (${tenantId})`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const accounting = app.get(AccountingService);
    const result = await accounting.provisionTenantAccounting(tenantId);
    console.log(
      `✅  Seeded ${result.glAccountsSeeded} GL accounts and ${result.policiesSeeded} account-type policies`,
    );
  } finally {
    await app.close();
  }
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
