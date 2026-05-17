import { AccountType, Prisma, TenantStatus, UserRole } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { tenantAsyncStorage } from '../../src/common/services/tenant-context.service';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Tenant Isolation', () => {
  let prisma: PrismaService;
  let tenantA: { id: string; slug: string };
  let tenantB: { id: string; slug: string };

  const withoutTenantId = <T>(data: Record<string, unknown>): T => data as unknown as T;

  const cleanDatabase = async (): Promise<void> => {
    const tables = ['AuditLog', 'Account', 'Member', 'User', 'Tenant'];
    for (const table of tables) {
      await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE 1=1`);
    }
  };

  const createTenant = async (label: string): Promise<{ id: string; slug: string }> => {
    const slug = `${label}-${uuidv4()}`;
    const tenant = await prisma.tenant.create({
      data: {
        id: uuidv4(),
        name: `${label} SACCO`,
        slug,
        schemaName: `tenant_${label.replace(/-/g, '_')}_${Date.now()}`,
        status: TenantStatus.ACTIVE,
        contactEmail: `${label}@sacco.co.ke`,
        contactPhone: '254700000000',
      },
      select: { id: true, slug: true },
    });

    return tenant;
  };

  const createMemberAccount = async (
    tenant: { id: string; slug: string },
    prefix: string,
  ): Promise<{ userId: string; memberId: string; accountId: string; accountTenantId: string }> =>
    tenantAsyncStorage.run({ tenantId: tenant.id, tenantSlug: tenant.slug }, async () => {
      const user = await prisma.user.create({
        data: withoutTenantId<Prisma.UserUncheckedCreateInput>({
          email: `${prefix}-${uuidv4()}@example.co.ke`,
          passwordHash: 'not-used-in-this-test',
          role: UserRole.MEMBER,
          firstName: prefix,
          lastName: 'Member',
          isActive: true,
          emailVerified: true,
          status: 'APPROVED',
        }),
      });

      const member = await prisma.member.create({
        data: withoutTenantId<Prisma.MemberUncheckedCreateInput>({
          userId: user.id,
          memberNumber: `${prefix.toUpperCase()}-000001`,
          nationalId: uuidv4().replace(/-/g, '').slice(0, 8),
          isActive: true,
          kycStatus: 'APPROVED',
        }),
      });

      const account = await prisma.account.create({
        data: withoutTenantId<Prisma.AccountUncheckedCreateInput>({
          memberId: member.id,
          accountNumber: `ACC-${prefix.toUpperCase()}-000001`,
          accountType: AccountType.FOSA,
          balance: '2500.0000',
          isActive: true,
        }),
      });

      return {
        userId: user.id,
        memberId: member.id,
        accountId: account.id,
        accountTenantId: account.tenantId,
      };
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    await cleanDatabase();
    tenantA = await createTenant('tenant-a');
    tenantB = await createTenant('tenant-b');
  });

  afterAll(async () => {
    if (prisma) {
      await cleanDatabase();
      await prisma.onModuleDestroy();
    }
  });

  it('injects tenantId on creates and hides tenant B data while querying as tenant A', async () => {
    const tenantAAccount = await createMemberAccount(tenantA, 'a');
    const tenantBAccount = await createMemberAccount(tenantB, 'b');

    expect(tenantAAccount.accountTenantId).toBe(tenantA.id);
    expect(tenantBAccount.accountTenantId).toBe(tenantB.id);

    const tenantAViewOfTenantBAccount = await tenantAsyncStorage.run(
      { tenantId: tenantA.id, tenantSlug: tenantA.slug },
      async () => prisma.account.findMany({ where: { id: tenantBAccount.accountId } }),
    );

    expect(tenantAViewOfTenantBAccount).toHaveLength(0);

    const tenantAAccounts = await tenantAsyncStorage.run(
      { tenantId: tenantA.id, tenantSlug: tenantA.slug },
      async () => prisma.account.findMany(),
    );

    expect(tenantAAccounts.length).toBeGreaterThan(0);
    expect(tenantAAccounts.every((account) => account.tenantId === tenantA.id)).toBe(true);
  });

  it('scopes updateMany to the active tenant only', async () => {
    const tenantBAccount = await createMemberAccount(tenantB, 'b-update');

    const result = await tenantAsyncStorage.run(
      { tenantId: tenantA.id, tenantSlug: tenantA.slug },
      async () =>
        prisma.user.updateMany({
          where: { id: tenantBAccount.userId },
          data: { firstName: 'WrongTenant' },
        }),
    );

    expect(result.count).toBe(0);

    const unchangedTenantBUser = await tenantAsyncStorage.run(
      { tenantId: tenantB.id, tenantSlug: tenantB.slug },
      async () => prisma.user.findUnique({ where: { id: tenantBAccount.userId } }),
    );

    expect(unchangedTenantBUser?.firstName).toBe('b-update');
  });

  it('blocks AuditLog update and delete mutations at the Prisma extension layer', async () => {
    const auditLog = await tenantAsyncStorage.run(
      { tenantId: tenantA.id, tenantSlug: tenantA.slug },
      async () =>
        prisma.auditLog.create({
          data: withoutTenantId<Prisma.AuditLogUncheckedCreateInput>({
            action: 'TENANT_ISOLATION.TEST',
            entityType: 'TenantIsolationSpec',
            entityId: tenantA.id,
          }),
        }),
    );

    await expect(
      tenantAsyncStorage.run(
        { tenantId: tenantA.id, tenantSlug: tenantA.slug },
        async () =>
          prisma.auditLog.updateMany({
            where: { id: auditLog.id },
            data: { action: 'TENANT_ISOLATION.MUTATED' },
          }),
      ),
    ).rejects.toThrow('AuditLog is append-only');

    await expect(
      tenantAsyncStorage.run(
        { tenantId: tenantA.id, tenantSlug: tenantA.slug },
        async () => prisma.auditLog.delete({ where: { id: auditLog.id } }),
      ),
    ).rejects.toThrow('AuditLog is append-only');
  });
});
