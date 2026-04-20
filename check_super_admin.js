const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  // Check all tenants
  const tenants = await p.tenant.findMany({
    select: { id: true, name: true, slug: true, status: true },
  });
  console.log('=== TENANTS ===');
  console.log(JSON.stringify(tenants, null, 2));

  // Check SUPER_ADMIN user
  const superAdmin = await p.user.findFirst({
    where: { role: 'SUPER_ADMIN' },
    select: { id: true, email: true, role: true, tenantId: true, isActive: true },
  });
  console.log('\n=== SUPER_ADMIN USER ===');
  console.log(JSON.stringify(superAdmin, null, 2));

  // Check if PasswordResetToken model exists
  try {
    const count = await p.passwordResetToken.count();
    console.log('\n=== PasswordResetToken model EXISTS, count:', count);
  } catch (e) {
    console.log('\n=== PasswordResetToken model DOES NOT EXIST:', e.message);
  }
}

main()
  .catch(e => console.error(e.message))
  .finally(() => p.$disconnect());
