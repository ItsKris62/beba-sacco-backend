/**
 * Seeds the beba-sacco tenant so the frontend can connect.
 * Run: node seed_beba_sacco.js
 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const TENANT_ID = 'b2ae96e2-2ad4-491a-8808-42152e2462a6'; // matches frontend .env.local

async function main() {
  console.log('🌱  Seeding beba-sacco tenant...');

  const existing = await p.tenant.findUnique({ where: { id: TENANT_ID } });
  if (existing) {
    console.log(`ℹ️   Tenant already exists: ${existing.name} (${existing.id}) — status: ${existing.status}`);
    return;
  }

  const tenant = await p.tenant.create({
    data: {
      id: TENANT_ID,
      name: 'KC Boda SACCO',
      slug: 'beba-sacco',
      schemaName: 'beba_sacco',
      contactEmail: 'admin@kcboda.co.ke',
      contactPhone: '+254700000000',
      address: 'Nairobi, Kenya',
      status: 'ACTIVE',
    },
  });

  console.log(`✅  Tenant created: ${tenant.name} (${tenant.id})`);
}

main()
  .catch(e => { console.error('❌  Failed:', e.message); process.exit(1); })
  .finally(() => p.$disconnect());
