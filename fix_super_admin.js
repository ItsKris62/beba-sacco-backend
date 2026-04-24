/**
 * fix_super_admin.js
 *
 * Resets the SUPER_ADMIN password to a known strong value using argon2id
 * (same algorithm the auth service uses) and clears mustChangePassword.
 *
 * Usage:
 *   node fix_super_admin.js
 *
 * New credentials:
 *   Email:    superadmin@beba.co.ke
 *   Password: SuperAdmin@Beba2025!
 */

const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');

const p = new PrismaClient();

const NEW_PASSWORD = 'SuperAdmin@Beba2025!';

async function main() {
  console.log('🔧 Fixing SUPER_ADMIN account...\n');

  const user = await p.user.findFirst({
    where: { role: 'SUPER_ADMIN' },
    select: { id: true, email: true, tenantId: true },
  });

  if (!user) {
    console.error('❌ No SUPER_ADMIN user found in the database!');
    process.exit(1);
  }

  console.log('Found SUPER_ADMIN:', user.email, '(tenantId:', user.tenantId + ')');

  // Hash with argon2id — same params as auth.service.ts
  const passwordHash = await argon2.hash(NEW_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MiB
    timeCost: 3,
    parallelism: 1,
  });

  await p.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      mustChangePassword: false,
      isActive: true,
      refreshToken: null, // Clear any stale sessions
    },
  });

  console.log('\n✅ SUPER_ADMIN password reset successfully!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Email:    ', user.email);
  console.log('  Password: ', NEW_PASSWORD);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\n⚠️  IMPORTANT: Change this password immediately after first login!');
  console.log('\nNote: The SUPER_ADMIN belongs to the "Beba Platform" tenant.');
  console.log('      You can log in from ANY tenant context (the auth service bypasses');
  console.log('      tenant scope for SUPER_ADMIN accounts).');
}

main()
  .catch(e => {
    console.error('❌ Error:', e.message);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
