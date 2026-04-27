/**
 * Nyanza Region Location Seed Script
 * Seeds all 6 Nyanza counties with their constituencies and wards.
 *
 * Nyanza Counties:
 *   KE-041 – Siaya
 *   KE-042 – Kisumu
 *   KE-043 – Homa Bay
 *   KE-044 – Migori
 *   KE-045 – Kisii
 *   KE-046 – Nyamira
 *
 * Run: node scripts/seed-nyanza-locations.js
 * Idempotent: uses upsert so safe to re-run.
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─── Nyanza Location Data ─────────────────────────────────────────────────────

const NYANZA_DATA = [
  // ── 1. SIAYA (KE-041) ──────────────────────────────────────────────────────
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
        name: 'Ugunja',
        wards: [
          { code: 'KE-041-002-001', name: 'Ugunja' },
          { code: 'KE-041-002-002', name: 'Sigomere' },
          { code: 'KE-041-002-003', name: 'Sidindi' },
        ],
      },
      {
        code: 'KE-041-003',
        name: 'Alego Usonga',
        wards: [
          { code: 'KE-041-003-001', name: 'West Alego' },
          { code: 'KE-041-003-002', name: 'Central Alego' },
          { code: 'KE-041-003-003', name: 'Siaya Township' },
          { code: 'KE-041-003-004', name: 'North Alego' },
          { code: 'KE-041-003-005', name: 'South East Alego' },
          { code: 'KE-041-003-006', name: 'Usonga' },
        ],
      },
      {
        code: 'KE-041-004',
        name: 'Gem',
        wards: [
          { code: 'KE-041-004-001', name: 'North Gem' },
          { code: 'KE-041-004-002', name: 'West Gem' },
          { code: 'KE-041-004-003', name: 'Central Gem' },
          { code: 'KE-041-004-004', name: 'Yala Township' },
          { code: 'KE-041-004-005', name: 'East Gem' },
          { code: 'KE-041-004-006', name: 'Sifuyo' },
        ],
      },
      {
        code: 'KE-041-005',
        name: 'Bondo',
        wards: [
          { code: 'KE-041-005-001', name: 'Usigu' },
          { code: 'KE-041-005-002', name: 'Township' },
          { code: 'KE-041-005-003', name: 'Yimbo West' },
          { code: 'KE-041-005-004', name: 'Central Sakwa' },
          { code: 'KE-041-005-005', name: 'South Sakwa' },
          { code: 'KE-041-005-006', name: 'West Sakwa' },
          { code: 'KE-041-005-007', name: 'North Sakwa' },
        ],
      },
      {
        code: 'KE-041-006',
        name: 'Rarieda',
        wards: [
          { code: 'KE-041-006-001', name: 'East Asembo' },
          { code: 'KE-041-006-002', name: 'West Asembo' },
          { code: 'KE-041-006-003', name: 'North Uyoma' },
          { code: 'KE-041-006-004', name: 'South Uyoma' },
          { code: 'KE-041-006-005', name: 'West Uyoma' },
        ],
      },
    ],
  },

  // ── 2. KISUMU (KE-042) ─────────────────────────────────────────────────────
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
          { code: 'KE-042-001-005', name: 'Nyalenda B' },
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
          { code: 'KE-042-002-005', name: 'North West Kisumu' },
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
          { code: 'KE-042-003-006', name: 'Manyatta A' },
        ],
      },
      {
        code: 'KE-042-004',
        name: 'Seme',
        wards: [
          { code: 'KE-042-004-001', name: 'West Seme' },
          { code: 'KE-042-004-002', name: 'Central Seme' },
          { code: 'KE-042-004-003', name: 'East Seme' },
          { code: 'KE-042-004-004', name: 'North Seme' },
        ],
      },
      {
        code: 'KE-042-005',
        name: 'Nyando',
        wards: [
          { code: 'KE-042-005-001', name: 'East Kano/Wawidhi' },
          { code: 'KE-042-005-002', name: 'Awasi/Onjiko' },
          { code: 'KE-042-005-003', name: 'Ahero' },
          { code: 'KE-042-005-004', name: 'Kabonyo/Kanyagwal' },
          { code: 'KE-042-005-005', name: 'Kobura' },
        ],
      },
      {
        code: 'KE-042-006',
        name: 'Muhoroni',
        wards: [
          { code: 'KE-042-006-001', name: 'Miwani' },
          { code: 'KE-042-006-002', name: 'Ombeyi' },
          { code: 'KE-042-006-003', name: 'Masogo/Nyang\'oma' },
          { code: 'KE-042-006-004', name: 'Chemelil/Songhor' },
          { code: 'KE-042-006-005', name: 'Muhoroni/Koru' },
        ],
      },
      {
        code: 'KE-042-007',
        name: 'Nyakach',
        wards: [
          { code: 'KE-042-007-001', name: 'North East Nyakach' },
          { code: 'KE-042-007-002', name: 'South West Nyakach' },
          { code: 'KE-042-007-003', name: 'West Nyakach' },
          { code: 'KE-042-007-004', name: 'Central Nyakach' },
          { code: 'KE-042-007-005', name: 'South East Nyakach' },
        ],
      },
    ],
  },

  // ── 3. HOMA BAY (KE-043) ──────────────────────────────────────────────────
  {
    code: 'KE-043',
    name: 'Homa Bay',
    constituencies: [
      {
        code: 'KE-043-001',
        name: 'Kasipul',
        wards: [
          { code: 'KE-043-001-001', name: 'West Kasipul' },
          { code: 'KE-043-001-002', name: 'South Kasipul' },
          { code: 'KE-043-001-003', name: 'Central Kasipul' },
          { code: 'KE-043-001-004', name: 'Kasipul Kabondo' },
          { code: 'KE-043-001-005', name: 'East Kasipul' },
        ],
      },
      {
        code: 'KE-043-002',
        name: 'Kabondo Kasipul',
        wards: [
          { code: 'KE-043-002-001', name: 'Kokwanyo/Kakelo' },
          { code: 'KE-043-002-002', name: 'Kojwach' },
          { code: 'KE-043-002-003', name: 'East Kabondo' },
          { code: 'KE-043-002-004', name: 'West Kabondo' },
        ],
      },
      {
        code: 'KE-043-003',
        name: 'Karachuonyo',
        wards: [
          { code: 'KE-043-003-001', name: 'North Karachuonyo' },
          { code: 'KE-043-003-002', name: 'West Karachuonyo' },
          { code: 'KE-043-003-003', name: 'Central Karachuonyo' },
          { code: 'KE-043-003-004', name: 'Kendu Bay Town' },
          { code: 'KE-043-003-005', name: 'Kibiri' },
          { code: 'KE-043-003-006', name: 'Pala' },
        ],
      },
      {
        code: 'KE-043-004',
        name: 'Rangwe',
        wards: [
          { code: 'KE-043-004-001', name: 'East Gem' },
          { code: 'KE-043-004-002', name: 'West Gem' },
          { code: 'KE-043-004-003', name: 'Kagan' },
          { code: 'KE-043-004-004', name: 'Kochia' },
        ],
      },
      {
        code: 'KE-043-005',
        name: 'Homa Bay Town',
        wards: [
          { code: 'KE-043-005-001', name: 'Homa Bay Central' },
          { code: 'KE-043-005-002', name: 'Homa Bay Arujo' },
          { code: 'KE-043-005-003', name: 'Homa Bay East' },
          { code: 'KE-043-005-004', name: 'Homa Bay West' },
        ],
      },
      {
        code: 'KE-043-006',
        name: 'Ndhiwa',
        wards: [
          { code: 'KE-043-006-001', name: 'Kwabwai' },
          { code: 'KE-043-006-002', name: 'Kanyadoto' },
          { code: 'KE-043-006-003', name: 'Kanyikela' },
          { code: 'KE-043-006-004', name: 'Kabuoch North/Pala' },
          { code: 'KE-043-006-005', name: 'Kabuoch South' },
          { code: 'KE-043-006-006', name: 'Kanyamwa Kosewe' },
          { code: 'KE-043-006-007', name: 'Kanyamwa Kologi' },
        ],
      },
      {
        code: 'KE-043-007',
        name: 'Mbita',
        wards: [
          { code: 'KE-043-007-001', name: 'Gwassi South' },
          { code: 'KE-043-007-002', name: 'Gwassi North' },
          { code: 'KE-043-007-003', name: 'Kaksingri West' },
          { code: 'KE-043-007-004', name: 'Lambwe' },
          { code: 'KE-043-007-005', name: 'Rusinga Island' },
          { code: 'KE-043-007-006', name: 'Mbita' },
        ],
      },
      {
        code: 'KE-043-008',
        name: 'Suba North',
        wards: [
          { code: 'KE-043-008-001', name: 'Ruma Kaksingri' },
          { code: 'KE-043-008-002', name: 'West Kamagak' },
          { code: 'KE-043-008-003', name: 'East Kamagak' },
          { code: 'KE-043-008-004', name: 'Gembe' },
        ],
      },
    ],
  },

  // ── 4. MIGORI (KE-044) ─────────────────────────────────────────────────────
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
        name: 'Awendo',
        wards: [
          { code: 'KE-044-002-001', name: 'North East Sakwa' },
          { code: 'KE-044-002-002', name: 'South Sakwa' },
          { code: 'KE-044-002-003', name: 'West Sakwa' },
          { code: 'KE-044-002-004', name: 'Central Sakwa' },
        ],
      },
      {
        code: 'KE-044-003',
        name: 'Suna East',
        wards: [
          { code: 'KE-044-003-001', name: 'Wiga' },
          { code: 'KE-044-003-002', name: 'Wasweta II' },
          { code: 'KE-044-003-003', name: 'Ragana-Oruba' },
          { code: 'KE-044-003-004', name: 'Wasimbete' },
        ],
      },
      {
        code: 'KE-044-004',
        name: 'Suna West',
        wards: [
          { code: 'KE-044-004-001', name: 'Migori' },
          { code: 'KE-044-004-002', name: 'Mabera' },
          { code: 'KE-044-004-003', name: 'Chamwino' },
          { code: 'KE-044-004-004', name: 'God Jope' },
        ],
      },
      {
        code: 'KE-044-005',
        name: 'Uriri',
        wards: [
          { code: 'KE-044-005-001', name: 'West Kanyamkago' },
          { code: 'KE-044-005-002', name: 'North Kanyamkago' },
          { code: 'KE-044-005-003', name: 'Central Kanyamkago' },
          { code: 'KE-044-005-004', name: 'South Kanyamkago' },
          { code: 'KE-044-005-005', name: 'East Kanyamkago' },
        ],
      },
      {
        code: 'KE-044-006',
        name: 'Nyatike',
        wards: [
          { code: 'KE-044-006-001', name: 'Kachieng\'' },
          { code: 'KE-044-006-002', name: 'Kaler' },
          { code: 'KE-044-006-003', name: 'Got Kachola' },
          { code: 'KE-044-006-004', name: 'Muhuru' },
          { code: 'KE-044-006-005', name: 'Macalder/Kuja' },
          { code: 'KE-044-006-006', name: 'Sori' },
        ],
      },
      {
        code: 'KE-044-007',
        name: 'Kuria West',
        wards: [
          { code: 'KE-044-007-001', name: 'Masaba' },
          { code: 'KE-044-007-002', name: 'Bukira East' },
          { code: 'KE-044-007-003', name: 'Bukira Central/Ikerege' },
          { code: 'KE-044-007-004', name: 'Isibania' },
          { code: 'KE-044-007-005', name: 'Makerero' },
          { code: 'KE-044-007-006', name: 'Tagare' },
        ],
      },
      {
        code: 'KE-044-008',
        name: 'Kuria East',
        wards: [
          { code: 'KE-044-008-001', name: 'Gokeharaka/Getambwega' },
          { code: 'KE-044-008-002', name: 'Ntimaru West' },
          { code: 'KE-044-008-003', name: 'Ntimaru East' },
          { code: 'KE-044-008-004', name: 'Nyamosense/Komosoko' },
        ],
      },
    ],
  },

  // ── 5. KISII (KE-045) ──────────────────────────────────────────────────────
  {
    code: 'KE-045',
    name: 'Kisii',
    constituencies: [
      {
        code: 'KE-045-001',
        name: 'Bonchari',
        wards: [
          { code: 'KE-045-001-001', name: 'Bomariba' },
          { code: 'KE-045-001-002', name: 'Bogiakumu' },
          { code: 'KE-045-001-003', name: 'Riana' },
          { code: 'KE-045-001-004', name: 'Bomorenda' },
        ],
      },
      {
        code: 'KE-045-002',
        name: 'South Mugirango',
        wards: [
          { code: 'KE-045-002-001', name: 'Boikang\'a' },
          { code: 'KE-045-002-002', name: 'Getenga' },
          { code: 'KE-045-002-003', name: 'Bomwagamo' },
          { code: 'KE-045-002-004', name: 'Bokeira' },
          { code: 'KE-045-002-005', name: 'Magombo' },
        ],
      },
      {
        code: 'KE-045-003',
        name: 'Bomachoge Borabu',
        wards: [
          { code: 'KE-045-003-001', name: 'Chitago/Boochi' },
          { code: 'KE-045-003-002', name: 'Boochi/Tendere' },
          { code: 'KE-045-003-003', name: 'Bomachoge' },
          { code: 'KE-045-003-004', name: 'Borabu/Chitago' },
        ],
      },
      {
        code: 'KE-045-004',
        name: 'Bobasi',
        wards: [
          { code: 'KE-045-004-001', name: 'Bobasi Central' },
          { code: 'KE-045-004-002', name: 'Bobasi Boitangare' },
          { code: 'KE-045-004-003', name: 'Masige West' },
          { code: 'KE-045-004-004', name: 'Masige East' },
          { code: 'KE-045-004-005', name: 'Bobasi Chache' },
          { code: 'KE-045-004-006', name: 'Sengera/Tabaka' },
          { code: 'KE-045-004-007', name: 'Bobasi Bogetaorio' },
        ],
      },
      {
        code: 'KE-045-005',
        name: 'Bomachoge Chache',
        wards: [
          { code: 'KE-045-005-001', name: 'Boochi/Borabu' },
          { code: 'KE-045-005-002', name: 'Rigoma' },
          { code: 'KE-045-005-003', name: 'Gachuba' },
          { code: 'KE-045-005-004', name: 'Kembu' },
          { code: 'KE-045-005-005', name: 'Kiamokama' },
        ],
      },
      {
        code: 'KE-045-006',
        name: 'Nyaribari Masaba',
        wards: [
          { code: 'KE-045-006-001', name: 'Gesusu' },
          { code: 'KE-045-006-002', name: 'Ichuni' },
          { code: 'KE-045-006-003', name: 'Nyamasibi' },
          { code: 'KE-045-006-004', name: 'Masimba' },
          { code: 'KE-045-006-005', name: 'Bogiakumu' },
        ],
      },
      {
        code: 'KE-045-007',
        name: 'Nyaribari Chache',
        wards: [
          { code: 'KE-045-007-001', name: 'Kisii Central' },
          { code: 'KE-045-007-002', name: 'Monyerero' },
          { code: 'KE-045-007-003', name: 'Sensi' },
          { code: 'KE-045-007-004', name: 'Nyanchwa' },
          { code: 'KE-045-007-005', name: 'Bobaracho' },
          { code: 'KE-045-007-006', name: 'Kakimanyi' },
        ],
      },
      {
        code: 'KE-045-008',
        name: 'Kitutu Chache North',
        wards: [
          { code: 'KE-045-008-001', name: 'Bogeka' },
          { code: 'KE-045-008-002', name: 'Nyakoe' },
          { code: 'KE-045-008-003', name: 'Kitutu Central' },
          { code: 'KE-045-008-004', name: 'Boikine' },
        ],
      },
      {
        code: 'KE-045-009',
        name: 'Kitutu Chache South',
        wards: [
          { code: 'KE-045-009-001', name: 'Bogusero' },
          { code: 'KE-045-009-002', name: 'Bogeka' },
          { code: 'KE-045-009-003', name: 'Nyatieko' },
        ],
      },
    ],
  },

  // ── 6. NYAMIRA (KE-046) ────────────────────────────────────────────────────
  {
    code: 'KE-046',
    name: 'Nyamira',
    constituencies: [
      {
        code: 'KE-046-001',
        name: 'Kitutu Masaba',
        wards: [
          { code: 'KE-046-001-001', name: 'Rigena' },
          { code: 'KE-046-001-002', name: 'Manga' },
          { code: 'KE-046-001-003', name: 'Magwagwa' },
          { code: 'KE-046-001-004', name: 'Bomwagamo' },
        ],
      },
      {
        code: 'KE-046-002',
        name: 'West Mugirango',
        wards: [
          { code: 'KE-046-002-001', name: 'Nyamaiya' },
          { code: 'KE-046-002-002', name: 'Bogichora' },
          { code: 'KE-046-002-003', name: 'Bosamaro' },
          { code: 'KE-046-002-004', name: 'Bonyamatuta' },
          { code: 'KE-046-002-005', name: 'Township' },
        ],
      },
      {
        code: 'KE-046-003',
        name: 'North Mugirango',
        wards: [
          { code: 'KE-046-003-001', name: 'Boikang\'a' },
          { code: 'KE-046-003-002', name: 'Magombo' },
          { code: 'KE-046-003-003', name: 'Bokeira' },
          { code: 'KE-046-003-004', name: 'Bombaba Borabu' },
          { code: 'KE-046-003-005', name: 'Bomariba' },
        ],
      },
      {
        code: 'KE-046-004',
        name: 'Borabu',
        wards: [
          { code: 'KE-046-004-001', name: 'Metembe' },
          { code: 'KE-046-004-002', name: 'Bosamaro' },
          { code: 'KE-046-004-003', name: 'Bonyamatuta' },
          { code: 'KE-046-004-004', name: 'Nyansiongo' },
        ],
      },
    ],
  },
];

// ─── Seed Function ────────────────────────────────────────────────────────────

async function seedNyanzaLocations() {
  console.log('🌍 Seeding Nyanza Region location hierarchy...\n');
  console.log('   Counties: Siaya, Kisumu, Homa Bay, Migori, Kisii, Nyamira\n');

  let countyCount = 0;
  let constituencyCount = 0;
  let wardCount = 0;

  for (const countyData of NYANZA_DATA) {
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
      console.log(`     📍 Constituency: ${constituency.name}`);

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
  console.log('\n✅ Nyanza location hierarchy seeded successfully.\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await seedNyanzaLocations();
  } catch (err) {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
