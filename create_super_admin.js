const fs = require('fs');
const path = require('path');

// Load .env manually
const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
const dbUrl = envContent.match(/DATABASE_URL="([^"]+)"/)?.[1];
if (dbUrl) process.env.DATABASE_URL = dbUrl;

const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');
const p = new PrismaClient();

async function main() {
  // Find the beba-sacco tenant
  const tenant = await p.tenant.findFirst({ where: { slug: 'beba-sacco' } });
  if (!tenant) {
    console.error('❌ No tenant with slug "beba-sacco" found. Run seed_demo_accounts.js first.');
    process.exit(1);
  }
  console.log('✅ Tenant found:', tenant.name, '(ID:', tenant.id + ')');

  // Hash password with argon2id (same as auth service)
  const hash = await argon2.hash('SuperAdmin@1234', {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });

  // Upsert SUPER_ADMIN user
  const user = await p.user.upsert({
    where: { email: 'superadmin@beba-sacco.com' },
    update: {
      passwordHash: hash,
      isActive: true,
      role: 'SUPER_ADMIN',
      tenantId: tenant.id,
    },
    create: {
      tenantId: tenant.id,
      email: 'superadmin@beba-sacco.com',
      passwordHash: hash,
      firstName: 'Super',
      lastName: 'Admin',
      phone: '+254700000000',
      role: 'SUPER_ADMIN',
      isActive: true,
      emailVerified: true,
    },
  });

  console.log('');
  console.log('=== SUPER_ADMIN ACCOUNT ===');
  console.log('Email    :', user.email);
  console.log('Role     :', user.role);
  console.log('Active   :', user.isActive);
  console.log('TenantID :', user.tenantId);
  console.log('');
  console.log('=== LOGIN CREDENTIALS ===');
  console.log('Email    : superadmin@beba-sacco.com');
  console.log('Password : SuperAdmin@1234');
  console.log('X-Tenant-ID header:', tenant.id);
  console.log('');
  console.log('=== ALL ACCOUNTS SUMMARY ===');
  console.log('superadmin@beba-sacco.com / SuperAdmin@1234  (SUPER_ADMIN)');
  console.log('admin@beba-sacco.com      / Admin@1234       (MANAGER)');
  console.log('member@beba-sacco.com     / Member@1234      (MEMBER)');
  console.log('');
  console.log('✅ Done');
}

main()
  .catch(e => { console.error('❌ Error:', e.message); process.exit(1); })
  .finally(() => p.$disconnect());
