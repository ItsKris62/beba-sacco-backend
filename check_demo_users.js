const fs = require('fs');
const envContent = fs.readFileSync(__dirname + '/.env', 'utf8');
const dbUrl = envContent.match(/DATABASE_URL="([^"]+)"/)?.[1];
process.env.DATABASE_URL = dbUrl;

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function run() {
  const users = await p.user.findMany({
    select: { id: true, email: true, role: true, isActive: true, tenantId: true, passwordHash: true }
  });
  console.log('Total users found:', users.length);
  users.forEach(u => {
    const hashPrefix = u.passwordHash ? u.passwordHash.slice(0, 30) : 'NULL';
    const hashType = u.passwordHash
      ? (u.passwordHash.startsWith('$argon2') ? 'argon2' : u.passwordHash.startsWith('$2b$') || u.passwordHash.startsWith('$2a$') ? 'bcrypt' : 'unknown')
      : 'none';
    console.log('---');
    console.log('Email:', u.email);
    console.log('Role:', u.role);
    console.log('Active:', u.isActive);
    console.log('TenantId:', u.tenantId);
    console.log('Hash type:', hashType);
    console.log('Hash prefix:', hashPrefix);
  });
  await p.$disconnect();
}

run().catch(async e => {
  console.error('Error:', e.message);
  await p.$disconnect();
  process.exit(1);
});
