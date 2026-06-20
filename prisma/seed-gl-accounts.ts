/**
 * seed-gl-accounts.ts
 *
 * Seeds the default SACCO Chart of Accounts for a given tenant.
 * These are the system-level GL accounts required for double-entry bookkeeping.
 *
 * Run with: npx ts-node prisma/seed-gl-accounts.ts <tenantId>
 */
import { PrismaClient, GLAccountType } from '@prisma/client';

const prisma = new PrismaClient();

interface GLAccountSeed {
  code: string;
  name: string;
  type: GLAccountType;
  isSystemAccount: boolean;
}

const DEFAULT_GL_ACCOUNTS: GLAccountSeed[] = [
  // ASSET accounts
  { code: '1000', name: 'Cash at Bank - M-Pesa', type: 'ASSET', isSystemAccount: true },
  { code: '1010', name: 'Cash at Bank - Commercial', type: 'ASSET', isSystemAccount: true },
  { code: '1100', name: 'Accounts Receivable', type: 'ASSET', isSystemAccount: true },
  { code: '1300', name: 'Loan Portfolio - Development', type: 'ASSET', isSystemAccount: true },
  { code: '1301', name: 'Loan Portfolio - Jipange', type: 'ASSET', isSystemAccount: true },
  { code: '1302', name: 'Loan Portfolio - Emergency', type: 'ASSET', isSystemAccount: true },
  { code: '1400', name: 'Provision for Bad Debts', type: 'ASSET', isSystemAccount: true },

  // LIABILITY accounts
  { code: '2000', name: 'Member Savings', type: 'LIABILITY', isSystemAccount: true },
  { code: '2100', name: 'Member Shares', type: 'LIABILITY', isSystemAccount: true },
  { code: '2200', name: 'Accounts Payable', type: 'LIABILITY', isSystemAccount: true },
  { code: '2300', name: 'Member Deposits - FOSA', type: 'LIABILITY', isSystemAccount: true },
  { code: '2400', name: 'Member Deposits - BOSA', type: 'LIABILITY', isSystemAccount: true },

  // EQUITY accounts
  { code: '3000', name: 'Share Capital', type: 'EQUITY', isSystemAccount: true },
  { code: '3100', name: 'Retained Earnings', type: 'EQUITY', isSystemAccount: true },
  { code: '3200', name: 'Statutory Reserve', type: 'EQUITY', isSystemAccount: true },

  // REVENUE accounts
  { code: '4000', name: 'Interest Income - Loans', type: 'REVENUE', isSystemAccount: true },
  { code: '4100', name: 'Fee Income', type: 'REVENUE', isSystemAccount: true },
  { code: '4200', name: 'Penalty Income', type: 'REVENUE', isSystemAccount: true },
  { code: '4300', name: 'Processing Fee Income', type: 'REVENUE', isSystemAccount: true },

  // EXPENSE accounts
  { code: '5000', name: 'Operating Expenses', type: 'EXPENSE', isSystemAccount: true },
  { code: '5100', name: 'Staff Costs', type: 'EXPENSE', isSystemAccount: true },
  { code: '5200', name: 'M-Pesa Transaction Fees', type: 'EXPENSE', isSystemAccount: true },
  { code: '5300', name: 'Bad Debt Write-off', type: 'EXPENSE', isSystemAccount: true },
  { code: '5400', name: 'Interest Expense', type: 'EXPENSE', isSystemAccount: true },
];

export async function seedGLAccounts(tenantId: string): Promise<number> {
  let created = 0;

  for (const account of DEFAULT_GL_ACCOUNTS) {
    await prisma.gLAccount.upsert({
      where: { tenantId_code: { tenantId, code: account.code } },
      update: {}, // Don't overwrite if already exists
      create: {
        tenantId,
        code: account.code,
        name: account.name,
        type: account.type,
        isSystemAccount: account.isSystemAccount,
        isActive: true,
      },
    });
    created++;
  }

  return created;
}

// CLI entry point
async function main() {
  const tenantId = process.argv[2];
  if (!tenantId) {
    console.error('Usage: npx ts-node prisma/seed-gl-accounts.ts <tenantId>');
    process.exit(1);
  }

  // Verify tenant exists
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    console.error(`Tenant ${tenantId} not found`);
    process.exit(1);
  }

  console.log(`Seeding GL accounts for tenant: ${tenant.name} (${tenantId})`);
  const count = await seedGLAccounts(tenantId);
  console.log(`✅ Seeded ${count} GL accounts`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
