import { UserRole } from '@prisma/client';
import { AdminAuditController } from '../audit.controller';
import { AuditService } from '../audit.service';

describe('AdminAuditController — GET /admin/audit-logs', () => {
  function buildController() {
    const auditService = {
      findAll: jest.fn().mockResolvedValue({ data: [], nextCursor: null, hasMore: false }),
    };
    const controller = new AdminAuditController(auditService as unknown as AuditService);
    return { controller, auditService };
  }

  const tenant = { id: 'tenant-1' } as any;

  it('forces tenantId scoping for MANAGER — ignores any ?tenantId= query override', async () => {
    const { controller, auditService } = buildController();
    const manager = { id: 'user-1', role: UserRole.MANAGER } as any;

    await controller.findAdminAuditLogs(tenant, manager, undefined, 1, 50, undefined, undefined, undefined, undefined, undefined, undefined, 'other-tenant', undefined, undefined);

    expect(auditService.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', crossTenant: false }),
    );
  });

  it('forces tenantId scoping for AUDITOR', async () => {
    const { controller, auditService } = buildController();
    const auditor = { id: 'user-2', role: UserRole.AUDITOR } as any;

    await controller.findAdminAuditLogs(tenant, auditor, undefined, 1, 50);

    expect(auditService.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', crossTenant: false }),
    );
  });

  it('allows SUPER_ADMIN to cross tenants via ?tenantId=', async () => {
    const { controller, auditService } = buildController();
    const superAdmin = { id: 'user-3', role: UserRole.SUPER_ADMIN } as any;

    await controller.findAdminAuditLogs(tenant, superAdmin, undefined, 1, 50, undefined, undefined, undefined, undefined, undefined, undefined, 'other-tenant', undefined, undefined);

    expect(auditService.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'other-tenant', crossTenant: true }),
    );
  });

  it('maps action/userId/date filters through to AuditService.findAll', async () => {
    const { controller, auditService } = buildController();
    const manager = { id: 'user-1', role: UserRole.MANAGER } as any;

    await controller.findAdminAuditLogs(
      tenant,
      manager,
      undefined,
      1,
      50,
      'member-uuid-1',
      'LOAN.APPROVED',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '2026-07-01',
      '2026-07-10',
    );

    // endDate has no time component, so the controller extends it to end-of-day
    // (23:59:59.999) so the range is inclusive of the whole final day.
    const expectedToDate = new Date('2026-07-10');
    expectedToDate.setHours(23, 59, 59, 999);

    expect(auditService.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'member-uuid-1',
        action: 'LOAN.APPROVED',
        fromDate: new Date('2026-07-01'),
        toDate: expectedToDate,
      }),
    );
  });
});
