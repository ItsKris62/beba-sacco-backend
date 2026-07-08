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

  let smsServiceMock: any;

  beforeEach(() => {
    prismaMock = {
      user: {
        findFirst: jest.fn(),
        create: jest.fn(),
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
    smsServiceMock = { enqueueSms: jest.fn().mockResolvedValue(true) };
    service = new UsersService(
      prismaMock,
      auditMock,
      {} as any,
      pinServiceMock,
      smsServiceMock,
      { add: jest.fn() } as any,
    );
  });

  describe('create()', () => {
    const newUserDto = {
      email: 'newteller@example.com',
      firstName: 'New',
      lastName: 'Teller',
      phone: '+254700000000',
      role: UserRole.TELLER,
    } as any;

    it('generates a temp password, hashes it, and enqueues an SMS instead of using PinService', async () => {
      prismaMock.user.findFirst.mockResolvedValue(null); // email not already registered
      prismaMock.user.create.mockResolvedValue({ id: 'new-user-id', ...newUserDto });

      const result = await service.create(newUserDto, 'tenant-1', manager);

      expect(result.success).toBe(true);
      expect(typeof result.temporaryPassword).toBe('string');
      expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(12);
      expect(result.smsEnqueued).toBe(true);

      const { data } = prismaMock.user.create.mock.calls[0][0];
      expect(data.passwordHash).toMatch(/^\$argon2id\$/);
      expect(data.mustChangePassword).toBe(true);
      expect(data.pinLoginRequired).toBeUndefined(); // no longer set — PIN flow retired for new accounts

      expect(smsServiceMock.enqueueSms).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'TEMP_PASSWORD', phone: newUserDto.phone }),
        expect.any(String),
      );
    });

    it('reports smsEnqueued: false (without failing the request) when the SMS queue is down', async () => {
      prismaMock.user.findFirst.mockResolvedValue(null);
      prismaMock.user.create.mockResolvedValue({ id: 'new-user-id', ...newUserDto });
      smsServiceMock.enqueueSms.mockResolvedValueOnce(false);

      const result = await service.create(newUserDto, 'tenant-1', manager);

      expect(result.success).toBe(true);
      expect(result.smsEnqueued).toBe(false);
      expect(typeof result.temporaryPassword).toBe('string');
    });

    it('blocks MANAGER from creating a TENANT_ADMIN account', async () => {
      await expect(
        service.create({ ...newUserDto, role: UserRole.TENANT_ADMIN }, 'tenant-1', manager),
      ).rejects.toThrow(ForbiddenException);

      expect(prismaMock.user.create).not.toHaveBeenCalled();
    });
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
