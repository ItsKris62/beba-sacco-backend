const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const user = await p.user.findFirst({
    where: { role: 'SUPER_ADMIN' },
    select: {
      id: true,
      email: true,
      passwordResetToken: true,
      passwordResetExpiry: true,
      mustChangePassword: true,
      isActive: true,
    },
  });
  console.log('✅ Prisma client has new fields. User:', JSON.stringify(user, null, 2));
}

main()
  .catch(e => console.error('❌ Error:', e.message))
  .finally(() => p.$disconnect());
