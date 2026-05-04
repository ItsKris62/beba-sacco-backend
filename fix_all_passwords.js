/**
 * fix_all_passwords.js
 *
 * Re-hashes ALL user passwords with argon2id (matching the auth service).
 * Run this on the deployed database if login returns 500 due to bcrypt/legacy hashes.
 *
 *   node fix_all_passwords.js
 *
 * It reads passwords from a mapping and updates each user. For users not in the
 * mapping, it sets a default password and prints the reset list.
 */

const fs = require('fs');
const path = require('path');

// Load .env manually
const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
const dbUrl = envContent.match(/DATABASE_URL="([^"]+)"/)?.[1];
if (dbUrl) process.env.DATABASE_URL = dbUrl;

const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');
const p = new PrismaClient();

// Known default passwords for seeded demo accounts
const KNOWN_PASSWORDS = {
  'admin@beba-sacco.com': 'Admin@1234',
  'member@beba-sacco.com': 'Member@1234',
  'superadmin@beba-sacco.com': 'SuperAdmin@1234',
};

const DEFAULT_PASSWORD = 'BebaReset@2026!';

async function run() {
  console.log('=== FIXING ALL PASSWORD HASHES ===\n');

  const users = await p.user.findMany({
    select: { id: true, email: true, passwordHash: true, role: true },
  });

  console.log(`Found ${users.length} user(s)\n`);

  const resetList = [];

  for (const user of users) {
    const isArgon2 = user.passwordHash?.startsWith('$argon2');
    if (isArgon2) {
      console.log(`✅  ${user.email} — already argon2id`);
      continue;
    }

    const plainPassword = KNOWN_PASSWORDS[user.email] ?? DEFAULT_PASSWORD;
    const hash = await argon2.hash(plainPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    await p.user.update({
      where: { id: user.id },
      data: { passwordHash: hash },
    });

    if (!KNOWN_PASSWORDS[user.email]) {
      resetList.push({ email: user.email, password: plainPassword });
    }

    console.log(`🔧  ${user.email} — rehashed with argon2id`);
  }

  console.log('\n=== DONE ===');
  if (resetList.length > 0) {
    console.log('\n⚠️  These accounts had unknown passwords and were reset:');
    resetList.forEach((u) => console.log(`   ${u.email}  →  ${u.password}`));
    console.log('\n   Please share these credentials securely with the users.');
  }
  console.log('\nAll passwords now use argon2id. Login should work.');

  await p.$disconnect();
}

run().catch(async (e) => {
  console.error('FATAL:', e.message);
  await p.$disconnect();
  process.exit(1);
});
