import { PrismaClient, UserRole, AccountType } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding loan workflow data...');

  // Create a mock tenant
  const tenant = await prisma.tenant.upsert({
    where: { subdomain: 'test-sacco' },
    update: {},
    create: {
      name: 'Test SACCO',
      subdomain: 'test-sacco',
      schemaMode: 'SHARED',
    },
  });

  // Create Loan Product
  const loanProduct = await prisma.loanProduct.create({
    data: {
      tenantId: tenant.id,
      name: 'Development Loan',
      description: 'Standard development loan',
      minAmount: 5000,
      maxAmount: 1000000,
      savingsMultiplier: 3.0,
      minActiveMonths: 6,
      interestRate: 0.12,
      interestType: 'REDUCING_BALANCE',
      maxTenureMonths: 36,
      processingFeeRate: 0.02,
      gracePeriodMonths: 1,
    },
  });

  // Create Test Users
  const user1 = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: 'borrower@example.com',
      passwordHash: 'hashedpassword',
      firstName: 'Alice',
      lastName: 'Borrower',
      role: UserRole.MEMBER,
      status: 'ACTIVE',
    },
  });

  const member1 = await prisma.member.create({
    data: {
      tenantId: tenant.id,
      userId: user1.id,
      memberNumber: 'M-001',
      kycStatus: 'APPROVED',
    },
  });

  await prisma.account.createMany({
    data: [
      { tenantId: tenant.id, memberId: member1.id, accountNumber: 'FOSA-001', accountType: AccountType.FOSA, balance: 1000 },
      { tenantId: tenant.id, memberId: member1.id, accountNumber: 'BOSA-001', accountType: AccountType.BOSA, balance: 50000 },
    ],
  });

  const user2 = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: 'guarantor@example.com',
      passwordHash: 'hashedpassword',
      firstName: 'Bob',
      lastName: 'Guarantor',
      role: UserRole.MEMBER,
      status: 'ACTIVE',
    },
  });

  const member2 = await prisma.member.create({
    data: {
      tenantId: tenant.id,
      userId: user2.id,
      memberNumber: 'M-002',
      kycStatus: 'APPROVED',
    },
  });

  await prisma.account.createMany({
    data: [
      { tenantId: tenant.id, memberId: member2.id, accountNumber: 'FOSA-002', accountType: AccountType.FOSA, balance: 200000 },
      { tenantId: tenant.id, memberId: member2.id, accountNumber: 'BOSA-002', accountType: AccountType.BOSA, balance: 100000 },
    ],
  });

  console.log('Seeded successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
