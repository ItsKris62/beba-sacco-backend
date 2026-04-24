const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');
const p = new PrismaClient();
async function run() {
  const users = [
    { email: 'admin@beba-sacco.com', password: 'Admin@1234' },
    { email: 'member@beba-sacco.com', password: 'Member@1234' },
  ];
  for (const u of users) {
    const hash = await argon2.hash(u.password, { type: argon2.argon2id });
    await p.user.update({ where: { email: u.email }, data: { passwordHash: hash } });
    console.log('Updated:', u.email);
  }
  console.log('Done. Passwords now use argon2id.');
  await p.$disconnect();
}
run().catch(async e => { console.error(e.message); await p.$disconnect(); process.exit(1); });
