const fs = require('fs');
const path = require('path');

const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
const dbUrl = envContent.match(/DATABASE_URL="([^"]+)"/)?.[1];
process.env.DATABASE_URL = dbUrl;

const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');
const p = new PrismaClient();

const OUTPUT_FILE = path.join(__dirname, 'check_fix_output.txt');
const lines = [];
function log(msg) {
  lines.push(msg);
  console.log(msg);
}

async function run() {
  // Step 1: Check current users
  log('=== CHECKING USERS IN DATABASE ===');
  const users = await p.user.findMany({
    select: { id: true, email: true, role: true, isActive: true, tenantId: true, passwordHash: true }
  });
  log('Total users: ' + users.length);

  for (const u of users) {
    const hashType = u.passwordHash
      ? (u.passwordHash.startsWith('$argon2') ? 'argon2'
        : (u.passwordHash.startsWith('$2b$') || u.passwordHash.startsWith('$2a$')) ? 'bcrypt'
        : 'unknown')
      : 'none';
    log('---');
    log('Email: ' + u.email);
    log('Role: ' + u.role);
    log('Active: ' + u.isActive);
    log('TenantId: ' + u.tenantId);
    log('Hash type: ' + hashType);
  }

  // Step 2: Fix passwords for demo accounts
  log('\n=== FIXING DEMO ACCOUNT PASSWORDS (argon2id) ===');
  const demoAccounts = [
    { email: 'admin@beba-sacco.com', password: 'Admin@1234' },
    { email: 'member@beba-sacco.com', password: 'Member@1234' },
  ];

  for (const account of demoAccounts) {
    const user = users.find(u => u.email === account.email);
    if (!user) {
      log('NOT FOUND: ' + account.email);
      continue;
    }
    const hash = await argon2.hash(account.password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    await p.user.update({ where: { email: account.email }, data: { passwordHash: hash } });
    log('Updated: ' + account.email + ' -> argon2id hash set');
  }

  log('\n=== DONE ===');
  fs.writeFileSync(OUTPUT_FILE, lines.join('\n'), 'utf8');
  log('Output written to: ' + OUTPUT_FILE);
  await p.$disconnect();
}

run().catch(async e => {
  const msg = 'FATAL ERROR: ' + e.message + '\n' + e.stack;
  fs.writeFileSync(OUTPUT_FILE, msg, 'utf8');
  console.error(msg);
  await p.$disconnect();
  process.exit(1);
});
