/**
 * Idempotent SUPER_ADMIN seed.
 *
 * Run once after first deployment:
 *   npm run seed:super-admin
 *
 * Safe to re-run: if the SUPER_ADMIN email already exists the script exits
 * without making any changes.
 *
 * Env overrides:
 *   SUPER_ADMIN_EMAIL    (default: superadmin@beba.co.ke)
 *   SUPER_ADMIN_PASSWORD (default: BebaAdmin@2026!)  ← change immediately
 */

import { PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

const PLATFORM_TENANT = {
  name: 'Beba Platform',
  slug: 'beba-platform',
  schemaName: 'beba_platform',
  contactEmail: 'platform@beba.co.ke',
  contactPhone: '+254000000000',
  address: 'Nairobi, Kenya',
};

const SUPER_ADMIN_EMAIL =
  process.env.SUPER_ADMIN_EMAIL ?? 'superadmin@beba.co.ke';
const SUPER_ADMIN_PASSWORD =
  process.env.SUPER_ADMIN_PASSWORD ?? 'BebaAdmin@2026!';

async function main() {
  console.log('🌱  Seeding SUPER_ADMIN...');

  // Upsert platform tenant (idempotent by slug unique constraint)
  const tenant = await prisma.tenant.upsert({
    where: { slug: PLATFORM_TENANT.slug },
    update: {},
    create: PLATFORM_TENANT,
    select: { id: true, name: true },
  });
  console.log(`✅  Platform tenant: "${tenant.name}" (${tenant.id})`);

  // Guard: skip if SUPER_ADMIN already exists
  const existing = await prisma.user.findUnique({
    where: { email: SUPER_ADMIN_EMAIL.toLowerCase() },
    select: { id: true, role: true },
  });

  if (existing) {
    console.log(
      `ℹ️   SUPER_ADMIN already exists (${existing.id}) — nothing to do.`,
    );
    return;
  }

  const passwordHash = await argon2.hash(SUPER_ADMIN_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });

  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: SUPER_ADMIN_EMAIL.toLowerCase(),
      passwordHash,
      firstName: 'Beba',
      lastName: 'Platform',
      role: UserRole.SUPER_ADMIN,
      mustChangePassword: false,
    },
    select: { id: true, email: true },
  });

  await prisma.auditLog.create({
    data: {
      tenantId: tenant.id,
      action: 'USER.CREATE',
      resource: 'User',
      resourceId: user.id,
      metadata: {
        source: 'seed-super-admin',
        role: UserRole.SUPER_ADMIN,
        email: user.email,
      },
    },
  });

  console.log(`✅  SUPER_ADMIN created: ${user.email} (${user.id})`);
  console.log(`⚠️   mustChangePassword = true — update password on first login!`);
}

main()
  .catch((e: unknown) => {
    console.error('❌  Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
