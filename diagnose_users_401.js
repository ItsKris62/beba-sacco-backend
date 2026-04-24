/**
 * diagnose_users_401.js
 *
 * Diagnoses why a SUPER_ADMIN gets a 401 when accessing the Staff Users tab.
 *
 * Run from the backend directory:
 *   node diagnose_users_401.js
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('\n========================================================');
  console.log('  SUPER_ADMIN → Staff Users Tab  |  401 Diagnosis');
  console.log('========================================================\n');

  // ── 1. Find all SUPER_ADMIN users ──────────────────────────────────────────
  const superAdmins = await prisma.user.findMany({
    where: { role: 'SUPER_ADMIN' },
    select: {
      id: true,
      email: true,
      role: true,
      isActive: true,
      mustChangePassword: true,
      tenantId: true,
      refreshToken: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });

  if (superAdmins.length === 0) {
    console.log('❌  No SUPER_ADMIN users found in the database.');
    console.log('    Run: node seed2.js  to create one.\n');
    return;
  }

  console.log(`Found ${superAdmins.length} SUPER_ADMIN user(s):\n`);

  for (const sa of superAdmins) {
    console.log(`  Email:              ${sa.email}`);
    console.log(`  ID:                 ${sa.id}`);
    console.log(`  tenantId (own):     ${sa.tenantId}`);
    console.log(`  isActive:           ${sa.isActive}`);
    console.log(`  mustChangePassword: ${sa.mustChangePassword}`);
    console.log(`  lastLoginAt:        ${sa.lastLoginAt ?? 'never'}`);
    console.log(`  refreshToken in DB: ${sa.refreshToken ? '✅ present (hashed)' : '❌ NULL — session is dead'}`);
    console.log('');

    // ── Diagnose each issue ──────────────────────────────────────────────────
    const issues = [];

    if (!sa.isActive) {
      issues.push('ACCOUNT DEACTIVATED — JwtStrategy throws 401 "Account has been deactivated"');
    }

    if (sa.mustChangePassword) {
      issues.push(
        'mustChangePassword = true — JwtAuthGuard throws 403 "Password change required"\n' +
        '    → User must visit /change-password before accessing any other route',
      );
    }

    if (!sa.refreshToken) {
      issues.push(
        'refreshToken is NULL — token refresh will fail with 401 "Invalid refresh token"\n' +
        '    → This happens after: seed scripts, fix_super_admin.js, or force-password-reset\n' +
        '    → The SUPER_ADMIN must log in again to get a new session',
      );
    }

    if (issues.length === 0) {
      console.log('  ✅  No session issues detected for this SUPER_ADMIN.');
      console.log('      If you still see 401, the access token may have expired (15-min TTL).');
      console.log('      → Log out and log back in to get a fresh token pair.\n');
    } else {
      console.log('  ⚠️   Issues found:');
      issues.forEach((issue, i) => console.log(`    ${i + 1}. ${issue}`));
      console.log('');
    }
  }

  // ── 2. Check the Beba SACCO tenant (the one the frontend uses) ─────────────
  const FRONTEND_TENANT_ID = 'b2ae96e2-2ad4-491a-8808-42152e2462a6';
  const bebaTenant = await prisma.tenant.findUnique({
    where: { id: FRONTEND_TENANT_ID },
    select: { id: true, name: true, slug: true, status: true },
  });

  console.log('── Frontend Tenant (NEXT_PUBLIC_TENANT_ID) ──────────────────');
  if (!bebaTenant) {
    console.log(`  ❌  Tenant ${FRONTEND_TENANT_ID} NOT FOUND in database.`);
    console.log('      TenantInterceptor will throw 400 "Unknown tenant" on every request.');
    console.log('      Run: node seed2.js  to seed the Beba SACCO tenant.\n');
  } else {
    console.log(`  Name:   ${bebaTenant.name}`);
    console.log(`  Slug:   ${bebaTenant.slug}`);
    console.log(`  Status: ${bebaTenant.status}`);
    if (bebaTenant.status !== 'ACTIVE') {
      console.log(
        `  ⚠️   Tenant is ${bebaTenant.status}.\n` +
        '      Non-SUPER_ADMIN users will get 401 from TenantInterceptor.\n' +
        '      SUPER_ADMIN is now exempt from this check (after the fix applied today).',
      );
    } else {
      console.log('  ✅  Tenant is ACTIVE — TenantInterceptor will pass.');
    }
    console.log('');
  }

  // ── 3. Check users in the Beba SACCO tenant ────────────────────────────────
  if (bebaTenant) {
    const userCount = await prisma.user.count({ where: { tenantId: FRONTEND_TENANT_ID } });
    console.log(`── Users in Beba SACCO tenant ───────────────────────────────`);
    console.log(`  Total users: ${userCount}`);
    if (userCount === 0) {
      console.log('  ⚠️   No users in this tenant — the Staff Users tab will show an empty list.');
    } else {
      console.log('  ✅  Users exist — GET /users should return data.');
    }
    console.log('');
  }

  // ── 4. Summary & fix instructions ─────────────────────────────────────────
  console.log('── Root Cause Summary ───────────────────────────────────────');
  console.log('');
  console.log('  The 401 on the Staff Users tab is caused by ONE of these:');
  console.log('');
  console.log('  A) Access token expired (15-min TTL) AND refresh token is NULL in DB');
  console.log('     → Fix: Log out and log back in as SUPER_ADMIN');
  console.log('');
  console.log('  B) mustChangePassword = true on the SUPER_ADMIN account');
  console.log('     → Fix: Visit /change-password and set a new password');
  console.log('');
  console.log('  C) SUPER_ADMIN account is deactivated (isActive = false)');
  console.log('     → Fix: Run the SQL below to reactivate:');
  console.log("     UPDATE \"User\" SET \"isActive\" = true WHERE role = 'SUPER_ADMIN';");
  console.log('');
  console.log('  Code fixes applied today:');
  console.log('  ✅  TenantInterceptor: SUPER_ADMIN now bypasses SUSPENDED/INACTIVE tenant check');
  console.log('  ✅  UsersController: SUPER_ADMIN explicitly listed in @Roles on GET /users');
  console.log('');
  console.log('  The @Roles guard already had a SUPER_ADMIN bypass in RolesGuard,');
  console.log('  but adding SUPER_ADMIN to @Roles makes the intent explicit and');
  console.log('  ensures Swagger docs reflect the correct access level.');
  console.log('');
  console.log('========================================================\n');
}

main()
  .catch((e) => {
    console.error('Diagnosis failed:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
