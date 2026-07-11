/**
 * Comprehensive MVP demo seed — gives the frontend team a fully working tenant
 * to develop and test against: a manager, a loan officer, three members with
 * FOSA + BOSA accounts and starting balances, and the two real loan products
 * ("Development Loan", "Jipange Loan" — named after the GL portfolio accounts
 * 1300/1301 in AccountingService's chart of accounts).
 *
 * Fully idempotent (upsert everywhere) — safe to run repeatedly:
 *   npx prisma db seed
 *
 * GL accounts / balance policies / SYSTEM actor are provisioned via the real
 * Nest DI graph (AccountingService.provisionTenantAccounting()) rather than
 * reimplemented here — same pattern as prisma/seed-e2e-test-data.ts and
 * prisma/seed-gl-accounts.ts, so this can't drift from real tenant-onboarding
 * behaviour. Passwords are hashed with the exact argon2id params
 * AuthService.register() uses, so seeded users can log in for real.
 */
import { NestFactory } from '@nestjs/core';
import { PrismaClient, UserRole, AccountType, AccountStatus, KycStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { AccountingService } from '../src/modules/accounting/accounting.service';

const prisma = new PrismaClient();

const TENANT_SLUG = 'beba-demo-sacco';
export const DEMO_PASSWORD = 'BebaDemo@2026!';

const ARGON2_OPTS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

async function upsertUser(params: {
  tenantId: string;
  email: string;
  role: UserRole;
  firstName: string;
  lastName: string;
  phone: string;
  idNumber: string;
}) {
  const passwordHash = await argon2.hash(DEMO_PASSWORD, ARGON2_OPTS);
  return prisma.user.upsert({
    where: { tenantId_email: { tenantId: params.tenantId, email: params.email } },
    update: { passwordHash, role: params.role, accountStatus: AccountStatus.ACTIVE },
    create: {
      tenantId: params.tenantId,
      email: params.email,
      passwordHash,
      firstName: params.firstName,
      lastName: params.lastName,
      phone: params.phone,
      role: params.role,
      accountStatus: AccountStatus.ACTIVE,
      emailVerified: true,
      phoneVerified: true,
      mustChangePassword: false,
      idNumber: params.idNumber,
    },
  });
}

async function upsertAccount(params: {
  tenantId: string;
  memberId: string;
  accountNumber: string;
  accountType: AccountType;
  balance: number;
}) {
  return prisma.account.upsert({
    where: { tenantId_accountNumber: { tenantId: params.tenantId, accountNumber: params.accountNumber } },
    update: { balance: params.balance, isActive: true },
    create: {
      tenantId: params.tenantId,
      memberId: params.memberId,
      accountNumber: params.accountNumber,
      accountType: params.accountType,
      balance: params.balance,
      isActive: true,
    },
  });
}

async function upsertMemberWithAccounts(params: {
  tenantId: string;
  userId: string;
  memberNumber: string;
  nationalId: string;
  kraPin: string;
  fosaBalance: number;
  bosaBalance: number;
}) {
  const member = await prisma.member.upsert({
    where: { userId: params.userId },
    update: { kycStatus: KycStatus.APPROVED, isActive: true },
    create: {
      tenantId: params.tenantId,
      userId: params.userId,
      memberNumber: params.memberNumber,
      nationalId: params.nationalId,
      kraPin: params.kraPin,
      kycStatus: KycStatus.APPROVED,
      isActive: true,
    },
  });

  await upsertAccount({
    tenantId: params.tenantId,
    memberId: member.id,
    accountNumber: `${params.memberNumber}-FOSA`,
    accountType: AccountType.FOSA,
    balance: params.fosaBalance,
  });
  await upsertAccount({
    tenantId: params.tenantId,
    memberId: member.id,
    accountNumber: `${params.memberNumber}-BOSA`,
    accountType: AccountType.BOSA,
    balance: params.bosaBalance,
  });

  return member;
}

async function main() {
  console.log('Seeding Beba demo tenant...');

  const tenant = await prisma.tenant.upsert({
    where: { slug: TENANT_SLUG },
    update: {},
    create: {
      name: 'Beba Demo SACCO',
      slug: TENANT_SLUG,
      schemaName: 'beba_demo_sacco_schema',
      contactEmail: 'info@beba-demo-sacco.co.ke',
      contactPhone: '+254700000000',
      address: 'Nairobi, Kenya',
    },
  });
  console.log(`Tenant: "${tenant.name}" (${tenant.id})`);

  // Bootstraps the same chart of accounts, FOSA/BOSA balance policies, and
  // SYSTEM ledger actor that TenantsService.create() provisions for a tenant
  // created through the real API. Without this, any deposit/withdrawal/loan
  // disbursement against this seeded tenant fails with "GL accounts not
  // configured" or "no SYSTEM user provisioned" the first time LedgerService
  // tries to post an entry.
  const appCtx = await NestFactory.createApplicationContext(AppModule);
  try {
    const accounting = appCtx.get(AccountingService);
    const result = await accounting.provisionTenantAccounting(tenant.id);
    console.log(
      `Provisioned ${result.glAccountsSeeded} GL accounts and ${result.policiesSeeded} account-type policies`,
    );
  } finally {
    await appCtx.close();
  }

  // ─── Loan products ──────────────────────────────────────────────────────
  // Names match the GL portfolio accounts (1300 "Loan Portfolio - Development",
  // 1301 "Loan Portfolio - Jipange") in AccountingService's chart of accounts.

  const developmentLoan = await prisma.loanProduct.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'Development Loan' } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: 'Development Loan',
      description: 'Standard-term development loan for business, education, or asset finance.',
      minAmount: 5000,
      maxAmount: 1_000_000,
      savingsMultiplier: 3.0,
      minActiveMonths: 6,
      interestRate: 0.12,
      interestType: 'REDUCING_BALANCE',
      maxTenureMonths: 36,
      processingFeeRate: 0.02,
      gracePeriodMonths: 1,
      minGuarantors: 2,
      maxGuarantors: 3,
      guarantorCoverageRatio: 1.0,
      requiredAccountType: AccountType.FOSA,
    },
  });

  const jipangeLoan = await prisma.loanProduct.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'Jipange Loan' } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: 'Jipange Loan',
      description: 'Short-term, fast-turnaround loan for emergencies and quick cash needs.',
      minAmount: 1000,
      maxAmount: 200_000,
      savingsMultiplier: 2.0,
      minActiveMonths: 1,
      interestRate: 0.15,
      interestType: 'REDUCING_BALANCE',
      maxTenureMonths: 12,
      processingFeeRate: 0.015,
      gracePeriodMonths: 0,
      minGuarantors: 1,
      maxGuarantors: 2,
      guarantorCoverageRatio: 1.0,
      requiredAccountType: AccountType.FOSA,
    },
  });
  console.log(`Loan products: "${developmentLoan.name}", "${jipangeLoan.name}"`);

  // ─── Staff ──────────────────────────────────────────────────────────────

  const managerUser = await upsertUser({
    tenantId: tenant.id,
    email: 'manager@beba-demo.co.ke',
    role: UserRole.MANAGER,
    firstName: 'David',
    lastName: 'Manager',
    phone: '+254700000001',
    idNumber: 'DEMO-ID-MANAGER-001',
  });

  const loanOfficerUser = await upsertUser({
    tenantId: tenant.id,
    email: 'loanofficer@beba-demo.co.ke',
    role: UserRole.LOAN_OFFICER,
    firstName: 'Carol',
    lastName: 'Officer',
    phone: '+254700000002',
    idNumber: 'DEMO-ID-OFFICER-002',
  });

  // ─── Members ────────────────────────────────────────────────────────────
  // Varied balances so guarantor-eligibility (savingsMultiplier) and loan
  // scenarios are all exercisable out of the box.

  const member1User = await upsertUser({
    tenantId: tenant.id,
    email: 'member1@beba-demo.co.ke',
    role: UserRole.MEMBER,
    firstName: 'Jane',
    lastName: 'Wanjiru',
    phone: '+254700000011',
    idNumber: 'DEMO-ID-MEMBER-011',
  });
  const member1 = await upsertMemberWithAccounts({
    tenantId: tenant.id,
    userId: member1User.id,
    memberNumber: 'M-DEMO-001',
    nationalId: '30000011',
    kraPin: 'A001100011B',
    fosaBalance: 50_000,
    bosaBalance: 150_000,
  });

  const member2User = await upsertUser({
    tenantId: tenant.id,
    email: 'member2@beba-demo.co.ke',
    role: UserRole.MEMBER,
    firstName: 'Peter',
    lastName: 'Otieno',
    phone: '+254700000012',
    idNumber: 'DEMO-ID-MEMBER-012',
  });
  const member2 = await upsertMemberWithAccounts({
    tenantId: tenant.id,
    userId: member2User.id,
    memberNumber: 'M-DEMO-002',
    nationalId: '30000012',
    kraPin: 'A001100012B',
    fosaBalance: 20_000,
    bosaBalance: 80_000,
  });

  const member3User = await upsertUser({
    tenantId: tenant.id,
    email: 'member3@beba-demo.co.ke',
    role: UserRole.MEMBER,
    firstName: 'Grace',
    lastName: 'Achieng',
    phone: '+254700000013',
    idNumber: 'DEMO-ID-MEMBER-013',
  });
  const member3 = await upsertMemberWithAccounts({
    tenantId: tenant.id,
    userId: member3User.id,
    memberNumber: 'M-DEMO-003',
    nationalId: '30000013',
    kraPin: 'A001100013B',
    fosaBalance: 100_000,
    bosaBalance: 300_000,
  });

  console.log('Seeded successfully:');
  console.log(
    JSON.stringify(
      {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        password: DEMO_PASSWORD,
        loanProducts: { developmentLoan: developmentLoan.id, jipangeLoan: jipangeLoan.id },
        manager: { userId: managerUser.id, email: managerUser.email },
        loanOfficer: { userId: loanOfficerUser.id, email: loanOfficerUser.email },
        members: [
          { userId: member1User.id, memberId: member1.id, email: member1User.email, memberNumber: 'M-DEMO-001' },
          { userId: member2User.id, memberId: member2.id, email: member2User.email, memberNumber: 'M-DEMO-002' },
          { userId: member3User.id, memberId: member3.id, email: member3User.email, memberNumber: 'M-DEMO-003' },
        ],
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
