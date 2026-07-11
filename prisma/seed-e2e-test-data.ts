/**
 * E2E test fixtures for beba-app-frontend/e2e/loan-origination.spec.ts and
 * mpesa-deposit.spec.ts.
 *
 * Distinct from seed-loan-workflow.ts (which pre-dates this and has two real
 * bugs that make it unusable for login-based E2E: passwordHash is the
 * literal string 'hashedpassword' rather than a real argon2 hash, and it
 * only creates MEMBER-role users — no LOAN_OFFICER/MANAGER/TELLER for the
 * approval chain). This script is fully idempotent (upsert everywhere) so
 * it can be re-run before every E2E run without unique-constraint failures,
 * and hashes passwords with the exact argon2id params AuthService.register()
 * uses (see src/modules/auth/auth.service.ts:777-782) so real login works.
 */
import { NestFactory } from '@nestjs/core';
import { PrismaClient, UserRole, AccountType, AccountStatus, KycStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { AccountingService } from '../src/modules/accounting/accounting.service';

const prisma = new PrismaClient();

const TENANT_SLUG = 'e2e-test-sacco';
export const E2E_PASSWORD = 'E2eTestPassw0rd!';

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
  const passwordHash = await argon2.hash(E2E_PASSWORD, ARGON2_OPTS);
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

async function upsertMemberWithAccounts(params: {
  tenantId: string;
  userId: string;
  memberNumber: string;
  fosaBalance: number;
}) {
  const member = await prisma.member.upsert({
    where: { userId: params.userId },
    update: { kycStatus: KycStatus.APPROVED, isActive: true },
    create: {
      tenantId: params.tenantId,
      userId: params.userId,
      memberNumber: params.memberNumber,
      kycStatus: KycStatus.APPROVED,
      isActive: true,
    },
  });

  await prisma.account.upsert({
    where: { tenantId_accountNumber: { tenantId: params.tenantId, accountNumber: `${params.memberNumber}-FOSA` } },
    update: { balance: params.fosaBalance, isActive: true },
    create: {
      tenantId: params.tenantId,
      memberId: member.id,
      accountNumber: `${params.memberNumber}-FOSA`,
      accountType: AccountType.FOSA,
      balance: params.fosaBalance,
      isActive: true,
    },
  });

  return member;
}

async function main() {
  console.log('Seeding E2E test fixtures...');

  const tenant = await prisma.tenant.upsert({
    where: { slug: TENANT_SLUG },
    update: {},
    create: {
      name: 'E2E Test SACCO',
      slug: TENANT_SLUG,
      schemaName: 'e2e_test_sacco_schema',
      contactEmail: 'e2e@test.beba.local',
      contactPhone: '+254700000100',
    },
  });

  // Tenants created via the real signup/admin flow get GL accounts + balance
  // policies + a SYSTEM actor user via AccountingService.provisionTenantAccounting()
  // (called by TenantsService.create()) — this seed script creates the Tenant
  // row directly via Prisma, bypassing that, so the M-Pesa callback processor
  // (and anything else posting to the ledger) fails with "Tenant ... has no
  // SYSTEM user provisioned" until this is called explicitly. Bootstrapping
  // AccountingModule alone isn't sufficient — its dependency chain
  // (FinancialModule -> CommonServicesModule -> PlunkService) needs the
  // globally-registered ConfigModule that only AppModule provides, so this
  // boots the full app context (no HTTP listener starts either way with
  // createApplicationContext) rather than hand-reimplementing GL-seeding/
  // system-user logic here, so it can't drift from the real behavior.
  const appCtx = await NestFactory.createApplicationContext(AppModule);
  try {
    const accountingService = appCtx.get(AccountingService);
    await accountingService.provisionTenantAccounting(tenant.id);
  } finally {
    await appCtx.close();
  }

  const loanProduct = await prisma.loanProduct.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'E2E Development Loan' } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: 'E2E Development Loan',
      description: 'Fixture product for Playwright E2E — deliberately generous limits so a >=500k loan always clears eligibility.',
      minAmount: 5000,
      maxAmount: 5000000,
      savingsMultiplier: 5.0,
      minActiveMonths: 0,
      interestRate: 0.12,
      interestType: 'REDUCING_BALANCE',
      maxTenureMonths: 36,
      processingFeeRate: 0.02,
      gracePeriodMonths: 1,
      minGuarantors: 1,
      maxGuarantors: 3,
      guarantorCoverageRatio: 1.0,
      requiredAccountType: AccountType.FOSA,
    },
  });

  const borrowerUser = await upsertUser({
    tenantId: tenant.id,
    email: 'e2e-borrower@test.beba.local',
    role: UserRole.MEMBER,
    firstName: 'Amina',
    lastName: 'Borrower',
    phone: '+254700000101',
    idNumber: 'E2E-ID-BORROWER-001',
  });
  const borrowerMember = await upsertMemberWithAccounts({
    tenantId: tenant.id,
    userId: borrowerUser.id,
    memberNumber: 'E2E-M-001',
    fosaBalance: 1_000_000,
  });

  const guarantorUser = await upsertUser({
    tenantId: tenant.id,
    email: 'e2e-guarantor@test.beba.local',
    role: UserRole.MEMBER,
    firstName: 'Brian',
    lastName: 'Guarantor',
    phone: '+254700000102',
    idNumber: 'E2E-ID-GUARANTOR-002',
  });
  const guarantorMember = await upsertMemberWithAccounts({
    tenantId: tenant.id,
    userId: guarantorUser.id,
    memberNumber: 'E2E-M-002',
    fosaBalance: 2_000_000,
  });

  const officerUser = await upsertUser({
    tenantId: tenant.id,
    email: 'e2e-officer@test.beba.local',
    role: UserRole.TENANT_ADMIN,
    firstName: 'Carol',
    lastName: 'Officer',
    phone: '+254700000103',
    idNumber: 'E2E-ID-OFFICER-003',
  });

  const managerUser = await upsertUser({
    tenantId: tenant.id,
    email: 'e2e-manager@test.beba.local',
    role: UserRole.MANAGER,
    firstName: 'David',
    lastName: 'Manager',
    phone: '+254700000104',
    idNumber: 'E2E-ID-MANAGER-004',
  });

  const tellerUser = await upsertUser({
    tenantId: tenant.id,
    email: 'e2e-teller@test.beba.local',
    role: UserRole.TELLER,
    firstName: 'Grace',
    lastName: 'Teller',
    phone: '+254700000105',
    idNumber: 'E2E-ID-TELLER-005',
  });

  console.log('Seeded successfully:');
  console.log(JSON.stringify({
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    loanProductId: loanProduct.id,
    borrower: { userId: borrowerUser.id, memberId: borrowerMember.id, email: borrowerUser.email },
    guarantor: { userId: guarantorUser.id, memberId: guarantorMember.id, email: guarantorUser.email },
    officer: { userId: officerUser.id, email: officerUser.email },
    manager: { userId: managerUser.id, email: managerUser.email },
    teller: { userId: tellerUser.id, email: tellerUser.email },
    password: E2E_PASSWORD,
  }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
