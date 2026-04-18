const argon2 = require('argon2');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const hash = await argon2.hash('Admin1234!');
  console.log('Generated hash:', hash.slice(0, 30) + '...');

  // List all users first
  const users = await prisma.user.findMany({ select: { id: true, email: true, role: true, tenantId: true } });
  console.log('All users:', users);

  // Update admin
  const r1 = await prisma.user.updateMany({
    where: { email: 'admin@beba-sacco.com' },
    data: { passwordHash: hash },
  });
  console.log('Updated admin count:', r1.count);

  // Update member
  const r2 = await prisma.user.updateMany({
    where: { email: 'member@beba-sacco.com' },
    data: { passwordHash: hash },
  });
  console.log('Updated member count:', r2.count);

  await prisma.$disconnect();
  console.log('Done!');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
