/**
 * Sprint 1 Safe Migration Script
 *
 * Uses @prisma/client $queryRawUnsafe, one statement at a time.
 * Safe: additive only, no data loss.
 *
 * Run: node scripts/sprint1-migrate.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Each array entry = exactly ONE SQL statement (no semicolons at end)
const STATEMENTS = [
  // ── Enums ──────────────────────────────────────────────────────────────────
  `DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ApplicationStatus') THEN
    CREATE TYPE "ApplicationStatus" AS ENUM ('SUBMITTED','PENDING_REVIEW','APPROVED','REJECTED');
  END IF;
END
$body$`,

  `DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StagePosition') THEN
    CREATE TYPE "StagePosition" AS ENUM ('CHAIRMAN','SECRETARY','TREASURER','MEMBER');
  END IF;
END
$body$`,

  // ── County ─────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "County" (
    "id"   TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    CONSTRAINT "County_pkey" PRIMARY KEY ("id")
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS "County_code_key" ON "County"("code")`,

  // ── Constituency ───────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "Constituency" (
    "id"       TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "code"     TEXT NOT NULL,
    "name"     TEXT NOT NULL,
    "countyId" TEXT NOT NULL,
    CONSTRAINT "Constituency_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Constituency_countyId_fkey"
      FOREIGN KEY ("countyId") REFERENCES "County"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS "Constituency_code_key" ON "Constituency"("code")`,

  // ── Ward ───────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "Ward" (
    "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "code"           TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "constituencyId" TEXT NOT NULL,
    CONSTRAINT "Ward_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Ward_constituencyId_fkey"
      FOREIGN KEY ("constituencyId") REFERENCES "Constituency"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS "Ward_code_key" ON "Ward"("code")`,

  // ── User extensions ────────────────────────────────────────────────────────
  `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "idNumber" TEXT`,
  `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phoneNumber" TEXT`,
  `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "wardId" TEXT`,
  `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "userStatus" TEXT NOT NULL DEFAULT 'ACTIVE'`,

  `DO $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'User_idNumber_key' AND table_name = 'User'
  ) THEN
    ALTER TABLE "User" ADD CONSTRAINT "User_idNumber_key" UNIQUE ("idNumber");
  END IF;
END
$body$`,

  `DO $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'User_phoneNumber_key' AND table_name = 'User'
  ) THEN
    ALTER TABLE "User" ADD CONSTRAINT "User_phoneNumber_key" UNIQUE ("phoneNumber");
  END IF;
END
$body$`,

  `DO $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'User_wardId_fkey' AND table_name = 'User'
  ) THEN
    ALTER TABLE "User" ADD CONSTRAINT "User_wardId_fkey"
      FOREIGN KEY ("wardId") REFERENCES "Ward"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$body$`,

  // ── Stage ──────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "Stage" (
    "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "name"      TEXT NOT NULL,
    "wardId"    TEXT NOT NULL,
    "tenantId"  TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Stage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Stage_wardId_fkey"
      FOREIGN KEY ("wardId") REFERENCES "Ward"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS "Stage_name_wardId_tenantId_key" ON "Stage"("name","wardId","tenantId")`,

  // ── StageAssignment ────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "StageAssignment" (
    "id"       TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId"   TEXT NOT NULL,
    "stageId"  TEXT NOT NULL,
    "position" "StagePosition" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "StageAssignment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StageAssignment_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StageAssignment_stageId_fkey"
      FOREIGN KEY ("stageId") REFERENCES "Stage"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS "StageAssignment_userId_stageId_key" ON "StageAssignment"("userId","stageId")`,

  // ── MemberApplication ──────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "MemberApplication" (
    "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "firstName"   TEXT NOT NULL,
    "lastName"    TEXT NOT NULL,
    "idNumber"    TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "stageName"   TEXT NOT NULL,
    "position"    TEXT NOT NULL DEFAULT 'MEMBER',
    "wardId"      TEXT NOT NULL,
    "status"      "ApplicationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "documentUrl" TEXT,
    "reviewedBy"  TEXT,
    "reviewNotes" TEXT,
    "tenantId"    TEXT NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemberApplication_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MemberApplication_wardId_fkey"
      FOREIGN KEY ("wardId") REFERENCES "Ward"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
  )`,

  // ── updatedAt trigger function ─────────────────────────────────────────────
  `CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $func$
BEGIN
  NEW."updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$func$ language 'plpgsql'`,

  `DROP TRIGGER IF EXISTS update_stage_updated_at ON "Stage"`,

  `CREATE TRIGGER update_stage_updated_at
    BEFORE UPDATE ON "Stage"
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`,

  `DROP TRIGGER IF EXISTS update_member_application_updated_at ON "MemberApplication"`,

  `CREATE TRIGGER update_member_application_updated_at
    BEFORE UPDATE ON "MemberApplication"
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`,
];

async function runMigration() {
  console.log('🚀 Sprint 1 Safe Migration Starting...');
  console.log('📍 Database: Neon PostgreSQL (no data loss)\n');

  let ok = 0;
  let skip = 0;
  let fail = 0;

  for (const sql of STATEMENTS) {
    const label = sql.trim().replace(/\s+/g, ' ').substring(0, 80);
    try {
      await prisma.$queryRawUnsafe(sql);
      console.log(`  ✅ ${label}`);
      ok++;
    } catch (err) {
      const msg = (err.message ?? '').toLowerCase();
      if (
        msg.includes('already exists') ||
        msg.includes('duplicate') ||
        msg.includes('does not exist')
      ) {
        console.log(`  ⏭️  SKIP: ${label}`);
        skip++;
      } else {
        console.error(`  ❌ FAIL: ${label}`);
        console.error(`     ${(err.message ?? '').substring(0, 150)}`);
        fail++;
      }
    }
  }

  console.log(`\n📊 Results: ${ok} applied, ${skip} skipped, ${fail} failed`);

  if (fail === 0) {
    // Verify tables
    const tables = await prisma.$queryRaw`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('County','Constituency','Ward','Stage','StageAssignment','MemberApplication')
      ORDER BY table_name
    `;

    console.log('\n📋 Sprint 1 Tables in DB:');
    for (const r of tables) console.log(`  ✅ ${r.table_name}`);

    // Verify User columns
    const cols = await prisma.$queryRaw`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'User'
        AND column_name IN ('idNumber','phoneNumber','wardId','userStatus')
      ORDER BY column_name
    `;

    console.log('\n👤 User Table Extensions:');
    for (const r of cols) console.log(`  ✅ ${r.column_name}`);

    console.log('\n🎉 Sprint 1 migration complete!');
    console.log('   Next: node scripts/seed-locations.js');
  } else {
    console.log('\n⚠️  Some statements failed. Review errors above.');
    process.exitCode = 1;
  }

  await prisma.$disconnect();
}

runMigration().catch(async (err) => {
  console.error('Fatal:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
