/**
 * Sprint 1 – Location Seed Script
 * Seeds Nairobi + 11 Western Kenya counties with constituencies and wards.
 * Run: node scripts/seed-locations.js
 *
 * Idempotent: uses upsert so safe to re-run.
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─── Location Data ────────────────────────────────────────────────────────────

const LOCATION_DATA = [
  {
    code: 'KE-047',
    name: 'Nairobi City',
    constituencies: [
      {
        code: 'KE-047-001',
        name: 'Westlands',
        wards: [
          { code: 'KE-047-001-001', name: 'Kitisuru' },
          { code: 'KE-047-001-002', name: 'Parklands/Highridge' },
          { code: 'KE-047-001-003', name: 'Karura' },
          { code: 'KE-047-001-004', name: 'Kangemi' },
          { code: 'KE-047-001-005', name: 'Mountain View' },
        ],
      },
      {
        code: 'KE-047-002',
        name: 'Dagoretti North',
        wards: [
          { code: 'KE-047-002-001', name: 'Kilimani' },
          { code: 'KE-047-002-002', name: 'Kawangware' },
          { code: 'KE-047-002-003', name: 'Gatina' },
          { code: 'KE-047-002-004', name: 'Kileleshwa' },
          { code: 'KE-047-002-005', name: 'Kabiro' },
        ],
      },
      {
        code: 'KE-047-003',
        name: 'Langata',
        wards: [
          { code: 'KE-047-003-001', name: 'Karen' },
          { code: 'KE-047-003-002', name: 'Nairobi West' },
          { code: 'KE-047-003-003', name: 'Mugumu-ini' },
          { code: 'KE-047-003-004', name: "South C" },
          { code: 'KE-047-003-005', name: 'Nyayo Highrise' },
        ],
      },
      {
        code: 'KE-047-004',
        name: 'Kibra',
        wards: [
          { code: 'KE-047-004-001', name: 'Laini Saba' },
          { code: 'KE-047-004-002', name: 'Lindi' },
          { code: 'KE-047-004-003', name: 'Makina' },
          { code: 'KE-047-004-004', name: 'Woodley/Kenyatta Golf Course' },
          { code: 'KE-047-004-005', name: 'Sarang\'ombe' },
        ],
      },
    ],
  },
  {
    code: 'KE-042',
    name: 'Kisumu',
    constituencies: [
      {
        code: 'KE-042-001',
        name: 'Kisumu East',
        wards: [
          { code: 'KE-042-001-001', name: 'Kolwa East' },
          { code: 'KE-042-001-002', name: 'Manyatta B' },
          { code: 'KE-042-001-003', name: 'Nyalenda A' },
          { code: 'KE-042-001-004', name: 'Kolwa Central' },
        ],
      },
      {
        code: 'KE-042-002',
        name: 'Kisumu West',
        wards: [
          { code: 'KE-042-002-001', name: 'South West Kisumu' },
          { code: 'KE-042-002-002', name: 'Central Kisumu' },
          { code: 'KE-042-002-003', name: 'Kisumu North' },
          { code: 'KE-042-002-004', name: 'West Kisumu' },
        ],
      },
      {
        code: 'KE-042-003',
        name: 'Kisumu Central',
        wards: [
          { code: 'KE-042-003-001', name: 'Railways' },
          { code: 'KE-042-003-002', name: 'Migosi' },
          { code: 'KE-042-003-003', name: 'Shaurimoyo Kaloleni' },
          { code: 'KE-042-003-004', name: 'Market Milimani' },
          { code: 'KE-042-003-005', name: 'Kondele' },
        ],
      },
    ],
  },
  {
    code: 'KE-037',
    name: 'Kakamega',
    constituencies: [
      {
        code: 'KE-037-001',
        name: 'Lugari',
        wards: [
          { code: 'KE-037-001-001', name: 'Mautuma' },
          { code: 'KE-037-001-002', name: 'Lugari' },
          { code: 'KE-037-001-003', name: 'Lumakanda' },
          { code: 'KE-037-001-004', name: 'Chekalini' },
        ],
      },
      {
        code: 'KE-037-002',
        name: 'Likuyani',
        wards: [
          { code: 'KE-037-002-001', name: 'Sango' },
          { code: 'KE-037-002-002', name: 'Nzoia' },
          { code: 'KE-037-002-003', name: 'Likuyani' },
          { code: 'KE-037-002-004', name: 'Sinoko' },
        ],
      },
      {
        code: 'KE-037-003',
        name: 'Kakamega Central',
        wards: [
          { code: 'KE-037-003-001', name: 'Shieywe' },
          { code: 'KE-037-003-002', name: 'Kakamega East' },
          { code: 'KE-037-003-003', name: 'Kakamega Central' },
          { code: 'KE-037-003-004', name: 'Kakamega North' },
        ],
      },
    ],
  },
  {
    code: 'KE-038',
    name: 'Vihiga',
    constituencies: [
      {
        code: 'KE-038-001',
        name: 'Vihiga',
        wards: [
          { code: 'KE-038-001-001', name: 'Lugaga-Wamuluma' },
          { code: 'KE-038-001-002', name: 'Central Maragoli' },
          { code: 'KE-038-001-003', name: 'Mungoma' },
        ],
      },
      {
        code: 'KE-038-002',
        name: 'Sabatia',
        wards: [
          { code: 'KE-038-002-001', name: 'Wodanga' },
          { code: 'KE-038-002-002', name: 'Sabatia' },
          { code: 'KE-038-002-003', name: 'Chavakali' },
          { code: 'KE-038-002-004', name: 'North Maragoli' },
        ],
      },
    ],
  },
  {
    code: 'KE-039',
    name: 'Bungoma',
    constituencies: [
      {
        code: 'KE-039-001',
        name: 'Webuye East',
        wards: [
          { code: 'KE-039-001-001', name: 'Maraka' },
          { code: 'KE-039-001-002', name: 'Mihuu' },
          { code: 'KE-039-001-003', name: 'Ndivisi' },
        ],
      },
      {
        code: 'KE-039-002',
        name: 'Bungoma Central',
        wards: [
          { code: 'KE-039-002-001', name: 'Musikoma' },
          { code: 'KE-039-002-002', name: 'East Sang\'alo' },
          { code: 'KE-039-002-003', name: 'Kibingei' },
          { code: 'KE-039-002-004', name: 'Moi\'s Bridge' },
        ],
      },
    ],
  },
  {
    code: 'KE-040',
    name: 'Busia',
    constituencies: [
      {
        code: 'KE-040-001',
        name: 'Teso North',
        wards: [
          { code: 'KE-040-001-001', name: 'Malaba Central' },
          { code: 'KE-040-001-002', name: 'Malaba North' },
          { code: 'KE-040-001-003', name: 'Ang\'urai South' },
        ],
      },
      {
        code: 'KE-040-002',
        name: 'Busia Central',
        wards: [
          { code: 'KE-040-002-001', name: 'Ageng\'a Nanguba' },
          { code: 'KE-040-002-002', name: 'Nambale Township' },
          { code: 'KE-040-002-003', name: 'Bukhayo Central/Marenyo' },
        ],
      },
    ],
  },
  {
    code: 'KE-041',
    name: 'Siaya',
    constituencies: [
      {
        code: 'KE-041-001',
        name: 'Ugenya',
        wards: [
          { code: 'KE-041-001-001', name: 'West Ugenya' },
          { code: 'KE-041-001-002', name: 'Ukwala' },
          { code: 'KE-041-001-003', name: 'North Ugenya' },
          { code: 'KE-041-001-004', name: 'East Ugenya' },
        ],
      },
      {
        code: 'KE-041-002',
        name: 'Siaya Town',
        wards: [
          { code: 'KE-041-002-001', name: 'Siaya Township' },
          { code: 'KE-041-002-002', name: 'Karemo' },
          { code: 'KE-041-002-003', name: 'Yimbo East' },
        ],
      },
    ],
  },
  {
    code: 'KE-043',
    name: 'Homa Bay',
    constituencies: [
      {
        code: 'KE-043-001',
        name: 'Homa Bay Town',
        wards: [
          { code: 'KE-043-001-001', name: 'Homa Bay Central' },
          { code: 'KE-043-001-002', name: 'Homa Bay Arujo' },
          { code: 'KE-043-001-003', name: 'Homa Bay East' },
          { code: 'KE-043-001-004', name: 'Homa Bay West' },
        ],
      },
      {
        code: 'KE-043-002',
        name: 'Rangwe',
        wards: [
          { code: 'KE-043-002-001', name: 'East Gem' },
          { code: 'KE-043-002-002', name: 'West Gem' },
          { code: 'KE-043-002-003', name: 'Kagan' },
        ],
      },
    ],
  },
  {
    code: 'KE-044',
    name: 'Migori',
    constituencies: [
      {
        code: 'KE-044-001',
        name: 'Rongo',
        wards: [
          { code: 'KE-044-001-001', name: 'North Kamagambo' },
          { code: 'KE-044-001-002', name: 'Central Kamagambo' },
          { code: 'KE-044-001-003', name: 'East Kamagambo' },
          { code: 'KE-044-001-004', name: 'South Kamagambo' },
        ],
      },
      {
        code: 'KE-044-002',
        name: 'Migori Town',
        wards: [
          { code: 'KE-044-002-001', name: 'Migori' },
          { code: 'KE-044-002-002', name: 'Mabera' },
          { code: 'KE-044-002-003', name: 'Chamwino' },
        ],
      },
    ],
  },
  {
    code: 'KE-026',
    name: 'Trans Nzoia',
    constituencies: [
      {
        code: 'KE-026-001',
        name: 'Kiminini',
        wards: [
          { code: 'KE-026-001-001', name: 'Kiminini' },
          { code: 'KE-026-001-002', name: 'Waitaluk' },
          { code: 'KE-026-001-003', name: 'Sirende' },
          { code: 'KE-026-001-004', name: 'Hospital' },
        ],
      },
      {
        code: 'KE-026-002',
        name: 'Kwanza',
        wards: [
          { code: 'KE-026-002-001', name: 'Kwanza' },
          { code: 'KE-026-002-002', name: 'Keiyo' },
          { code: 'KE-026-002-003', name: 'Bidii' },
        ],
      },
    ],
  },
  {
    code: 'KE-029',
    name: 'Nandi',
    constituencies: [
      {
        code: 'KE-029-001',
        name: 'Aldai',
        wards: [
          { code: 'KE-029-001-001', name: 'Kabwareng' },
          { code: 'KE-029-001-002', name: 'Terik' },
          { code: 'KE-029-001-003', name: 'Kemeloi-Maraba' },
          { code: 'KE-029-001-004', name: 'Kobujoi' },
        ],
      },
      {
        code: 'KE-029-002',
        name: 'Nandi Hills',
        wards: [
          { code: 'KE-029-002-001', name: 'Nandi Hills' },
          { code: 'KE-029-002-002', name: 'Chepkunyuk' },
          { code: 'KE-029-002-003', name: 'Ol\'lessos' },
        ],
      },
    ],
  },
];

// ─── Seed Function ────────────────────────────────────────────────────────────

async function seedLocations() {
  console.log('🌍 Seeding location hierarchy (Nairobi + Western Kenya)...\n');

  let countyCount = 0;
  let constituencyCount = 0;
  let wardCount = 0;

  for (const countyData of LOCATION_DATA) {
    const county = await prisma.county.upsert({
      where: { code: countyData.code },
      create: { code: countyData.code, name: countyData.name },
      update: { name: countyData.name },
    });
    countyCount++;
    console.log(`  ✅ County: ${county.name} (${county.code})`);

    for (const constData of countyData.constituencies) {
      const constituency = await prisma.constituency.upsert({
        where: { code: constData.code },
        create: { code: constData.code, name: constData.name, countyId: county.id },
        update: { name: constData.name, countyId: county.id },
      });
      constituencyCount++;

      for (const wardData of constData.wards) {
        await prisma.ward.upsert({
          where: { code: wardData.code },
          create: { code: wardData.code, name: wardData.name, constituencyId: constituency.id },
          update: { name: wardData.name, constituencyId: constituency.id },
        });
        wardCount++;
      }
    }
  }

  console.log(`\n📊 Seed complete:`);
  console.log(`   Counties:       ${countyCount}`);
  console.log(`   Constituencies: ${constituencyCount}`);
  console.log(`   Wards:          ${wardCount}`);
  console.log('\n✅ Location hierarchy seeded successfully.\n');
}

// ─── SUPER_ADMIN Bootstrap (idempotent) ───────────────────────────────────────

async function ensureSuperAdmin() {
  const argon2 = require('argon2');
  const email = process.env.SUPER_ADMIN_EMAIL || 'superadmin@beba.co.ke';
  const password = process.env.SUPER_ADMIN_PASSWORD || 'BebaAdmin@2026!';

  // Find or create platform tenant
  let tenant = await prisma.tenant.findFirst({ where: { slug: 'beba-platform' } });
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: {
        name: 'Beba Platform',
        slug: 'beba-platform',
        schemaName: 'tenant_beba_platform',
        contactEmail: email,
        contactPhone: '+254700000000',
        status: 'ACTIVE',
      },
    });
    console.log(`✅ Platform tenant created: ${tenant.id}`);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`ℹ️  SUPER_ADMIN already exists: ${email}`);
    return;
  }

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });

  await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email,
      passwordHash,
      firstName: 'Beba',
      lastName: 'SuperAdmin',
      role: 'SUPER_ADMIN',
      isActive: true,
      mustChangePassword: false,
      userStatus: 'ACTIVE',
    },
  });

  console.log(`✅ SUPER_ADMIN created: ${email}`);
  console.log(`   Password: ${password}`);
  console.log(`   ⚠️  Change this password immediately in production!\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await ensureSuperAdmin();
    await seedLocations();
  } catch (err) {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
