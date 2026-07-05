import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { UsersService } from './users.service';

describe('UsersService — role hierarchy enforcement (canManageRole consolidation)', () => {
  let service: UsersService;
  let prismaMock: any;
  let auditMock: any;

  const makeTarget = (role: UserRole) => ({
    id: 'target-id',
    role,
    accountStatus: 'ACTIVE',
    email: 'target@example.com',
    firstName: 'Target',
    lastName: 'User',
  });

  const manager = { id: 'actor-id', role: UserRole.MANAGER };

  beforeEach(() => {
    prismaMock = {
      user: {
        findFirst: jest.fn(),
        update: jest.fn().mockImplementation(({ data }: { data: unknown }) => ({
          id: 'target-id',
          ...(data as Record<string, unknown>),
        })),
      },
    };
    auditMock = { create: jest.fn().mockResolvedValue(undefined) };
    const pinServiceMock = {
      generateAndIssuePin: jest.fn(),
      validatePin: jest.fn(),
      regenerateAndRevealPin: jest.fn(),
    } as any;
    service = new UsersService(prismaMock, auditMock, {} as any, pinServiceMock, { add: jest.fn() } as any);
  });

  describe('update()', () => {
    it('allows MANAGER to reassign a LOAN_OFFICER target to ACCOUNTANT', async () => {
      prismaMock.user.findFirst.mockResolvedValue(makeTarget(UserRole.LOAN_OFFICER));
      await expect(
        service.update('target-id', { role: UserRole.ACCOUNTANT } as any, 'tenant-1', manager),
      ).resolves.toBeDefined();
    });

    it('blocks MANAGER from modifying a TENANT_ADMIN target', async () => {
      prismaMock.user.findFirst.mockResolvedValue(makeTarget(UserRole.TENANT_ADMIN));
      await expect(
        service.update('target-id', { firstName: 'X' } as any, 'tenant-1', manager),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks MANAGER from modifying a peer MANAGER target', async () => {
      prismaMock.user.findFirst.mockResolvedValue(makeTarget(UserRole.MANAGER));
      await expect(
        service.update('target-id', { firstName: 'X' } as any, 'tenant-1', manager),
      ).rejects.toThrow(ForbiddenException);
    });

    it.each([UserRole.LOAN_OFFICER, UserRole.ACCOUNTANT])(
      'service layer allows MANAGER to reassign a LOAN_OFFICER target to %s (see update-user.dto.spec.ts for the DTO-layer gap fix)',
      async (role) => {
        prismaMock.user.findFirst.mockResolvedValue(makeTarget(UserRole.LOAN_OFFICER));
        await expect(
          service.update('target-id', { role } as any, 'tenant-1', manager),
        ).resolves.toBeDefined();
      },
    );
  });

  describe('forcePasswordReset()', () => {
    it('allows MANAGER to force-reset an ACCOUNTANT target', async () => {
      prismaMock.user.findFirst.mockResolvedValue(makeTarget(UserRole.ACCOUNTANT));
      prismaMock.user.update.mockResolvedValue({});
      await expect(
        service.forcePasswordReset('target-id', 'tenant-1', manager),
      ).resolves.toEqual(expect.objectContaining({ success: true }));
    });

    it('blocks MANAGER from force-resetting a TENANT_ADMIN target', async () => {
      prismaMock.user.findFirst.mockResolvedValue(makeTarget(UserRole.TENANT_ADMIN));
      await expect(
        service.forcePasswordReset('target-id', 'tenant-1', manager),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('generateTemporaryPassword()', () => {
    it('allows MANAGER to generate a temp password for a LOAN_OFFICER target', async () => {
      prismaMock.user.findFirst.mockResolvedValue(makeTarget(UserRole.LOAN_OFFICER));
      prismaMock.user.update.mockResolvedValue({});
      await expect(
        service.generateTemporaryPassword('target-id', 'tenant-1', manager),
      ).resolves.toEqual(expect.objectContaining({ success: true }));
    });

    it('blocks MANAGER from generating a temp password for a TENANT_ADMIN target', async () => {
      prismaMock.user.findFirst.mockResolvedValue(makeTarget(UserRole.TENANT_ADMIN));
      await expect(
        service.generateTemporaryPassword('target-id', 'tenant-1', manager),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('deactivate() — now routed through canManageRole()', () => {
    it.each([UserRole.LOAN_OFFICER, UserRole.ACCOUNTANT])(
      'allows MANAGER to deactivate a %s target',
      async (role) => {
        prismaMock.user.findFirst.mockResolvedValue(makeTarget(role));
        prismaMock.user.update.mockResolvedValue(makeTarget(role));
        await expect(
          service.deactivate('target-id', 'tenant-1', manager),
        ).resolves.toBeDefined();
      },
    );

    it('blocks MANAGER from deactivating a TENANT_ADMIN target (unchanged from the old inline check)', async () => {
      prismaMock.user.findFirst.mockResolvedValue(makeTarget(UserRole.TENANT_ADMIN));
      await expect(
        service.deactivate('target-id', 'tenant-1', manager),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks MANAGER from deactivating a peer MANAGER target (behavior change: previously allowed, no inline check covered this pair)', async () => {
      prismaMock.user.findFirst.mockResolvedValue(makeTarget(UserRole.MANAGER));
      await expect(
        service.deactivate('target-id', 'tenant-1', manager),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
