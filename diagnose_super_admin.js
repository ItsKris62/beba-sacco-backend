const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');

const p = new PrismaClient();

async function main() {
  const user = await p.user.findFirst({
    where: { role: 'SUPER_ADMIN' },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      isActive: true,
      mustChangePassword: true,
      tenantId: true,
    },
  });

  if (!user) {
    console.log('❌ No SUPER_ADMIN user found!');
    return;
  }

  console.log('=== SUPER_ADMIN ===');
  console.log('email:', user.email);
  console.log('isActive:', user.isActive);
  console.log('mustChangePassword:', user.mustChangePassword);
  console.log('tenantId:', user.tenantId);
  console.log('hash prefix (first 10 chars):', user.passwordHash.substring(0, 10));

  // Detect hash type
  const hash = user.passwordHash;
  if (hash.startsWith('$argon2')) {
    console.log('hash type: argon2 ✅');
  } else if (hash.startsWith('$2b$') || hash.startsWith('$2a$')) {
    console.log('hash type: bcrypt ⚠️  (auth service uses argon2 — password will FAIL to verify!)');
  } else {
    console.log('hash type: UNKNOWN ❓');
  }

  // Test common passwords
  const testPasswords = ['Admin@1234!', 'Admin@123!', 'SuperAdmin@1234!', 'Beba@2025!', 'Admin123!', 'password'];
  console.log('\n=== Testing common passwords ===');
  for (const pw of testPasswords) {
    try {
      const valid = await argon2.verify(hash, pw);
      if (valid) {
        console.log(`✅ Password match: "${pw}"`);
      } else {
        console.log(`❌ No match: "${pw}"`);
      }
    } catch (e) {
      console.log(`⚠️  Error testing "${pw}": ${e.message}`);
    }
  }
}

main()
  .catch(e => console.error('Error:', e.message))
  .finally(() => p.$disconnect());
