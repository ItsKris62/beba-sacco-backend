/**
 * Sprint 2 Migration Script
 * 
 * Runs the Prisma migration for Sprint 2 schema additions:
 *   - User: nextOfKinPhone, legacyMemberNo, importBatchId
 *   - DataImportLog: new model with full audit trail
 *   - ImportJobStatus: new enum
 * 
 * Usage:
 *   node scripts/sprint2-migrate.js
 * 
 * Or via npm:
 *   npm run migrate:sprint2
 */

const { execSync } = require('child_process');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, '..', 'src', 'prisma', 'schema.prisma');

console.log('🚀 Sprint 2 Migration: Legacy Data Import Schema');
console.log('================================================');
console.log(`Schema: ${SCHEMA_PATH}`);
console.log('');

try {
  // Step 1: Generate Prisma client
  console.log('📦 Step 1: Generating Prisma client...');
  execSync(`npx prisma generate --schema="${SCHEMA_PATH}"`, {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
  });
  console.log('✅ Prisma client generated\n');

  // Step 2: Create and apply migration
  console.log('🗄️  Step 2: Creating migration...');
  execSync(
    `npx prisma migrate dev --name sprint2_data_import --schema="${SCHEMA_PATH}"`,
    {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
    }
  );
  console.log('✅ Migration applied\n');

  console.log('🎉 Sprint 2 migration complete!');
  console.log('');
  console.log('New schema additions:');
  console.log('  ✓ User.nextOfKinPhone (nullable String)');
  console.log('  ✓ User.legacyMemberNo (nullable String)');
  console.log('  ✓ User.importBatchId (nullable String)');
  console.log('  ✓ DataImportLog model (full audit trail)');
  console.log('  ✓ ImportJobStatus enum (QUEUED/PROCESSING/COMPLETED/FAILED/PARTIAL)');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Restart the backend server');
  console.log('  2. Navigate to /admin/import/upload in the frontend');
  console.log('  3. Upload the Kolwa Central Boda CSV file');

} catch (error) {
  console.error('❌ Migration failed:', error.message);
  console.error('');
  console.error('Troubleshooting:');
  console.error('  1. Ensure DATABASE_URL is set in backend/.env');
  console.error('  2. Ensure the backend server is stopped (to release DLL lock on Windows)');
  console.error('  3. Run: cd backend && npx prisma migrate dev --name sprint2_data_import');
  process.exit(1);
}
