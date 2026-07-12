import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { UsersService } from './users.service';

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }));
import * as Sentry from '@sentry/nestjs';

describe('UsersService â€” role hierarchy enforcement (canManageRole consolidation)', () => {
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
  let encryptionMock: any;
  let configMock: any;
  let emailQueueMock: any;

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
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Test SACCO' }),
      },
    };
    auditMock = { create: jest.fn().mockResolvedValue(undefined) };
    configMock = { get: jest.fn().mockReturnValue(undefined) };
    const pinServiceMock = {
      generateAndIssuePin: jest.fn(),
      validatePin: jest.fn(),
      regenerateAndRevealPin: jest.fn(),
      assertIssuanceRateLimit: jest.fn().mockResolvedValue(undefined),
    } as any;
    smsServiceMock = { enqueueSms: jest.fn().mockResolvedValue(true) };
    emailQueueMock = { add: jest.fn().mockResolvedValue(undefined) };
    encryptionMock = {
      encrypt: jest.fn().mockResolvedValue({
        ciphertext: 'ciphertext',
        iv: 'iv',
        tag: 'tag',
        keyId: 'key-1',
        algorithm: 'aes-256-gcm',
      }),
      decrypt: jest.fn().mockResolvedValue('decrypted-temp-password'),
    };
    service = new UsersService(
      prismaMock,
      auditMock,
      {} as any,
      pinServiceMock,
      smsServiceMock,
      encryptionMock,
      configMock,
      emailQueueMock,
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

    it('generates a temp password, hashes it, expires it, and enqueues email instead of SMS', async () => {
      prismaMock.user.findFirst.mockResolvedValue(null); // email not already registered
      prismaMock.user.create.mockResolvedValue({ id: 'new-user-id', ...newUserDto });
      const before = Date.now();

      const result = await service.create(newUserDto, 'tenant-1', manager);

      expect(result.success).toBe(true);
      expect((result as any).temporaryPassword).toBeUndefined(); // never returned - use reveal-temp-password
      expect((result as any).smsEnqueued).toBeUndefined();
      expect(result.emailEnqueued).toBe(true);
      expect(result.tempPasswordExpiresAt).toEqual(expect.any(Date));

      const { data } = prismaMock.user.create.mock.calls[0][0];
      expect(data.passwordHash).toMatch(/^\$argon2id\$/);
      expect(data.mustChangePassword).toBe(true);
      expect(data.emailVerified).toBe(true);
      expect(data.phoneVerified).toBe(true);
      expect(data.pinLoginRequired).toBeUndefined(); // no longer set - PIN flow retired for new accounts
      expect(typeof data.tempPasswordEncrypted).toBe('string');
      expect(JSON.parse(data.tempPasswordEncrypted)).toEqual(
        await encryptionMock.encrypt.mock.results[0].value,
      );
      expect(encryptionMock.encrypt).toHaveBeenCalledWith(expect.any(String), 'tenant-1');
      expect(data.tempPasswordExpiresAt).toEqual(expect.any(Date));
      expect(data.tempPasswordExpiresAt.getTime()).toBeGreaterThan(before + 23 * 60 * 60 * 1000);
      expect(data.tempPasswordExpiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 24 * 60 * 60 * 1000,
      );

      expect(smsServiceMock.enqueueSms).not.toHaveBeenCalled();
      expect(emailQueueMock.add).toHaveBeenCalledWith(
        'send',
        expect.objectContaining({
          type: 'STAFF_ACCOUNT_CREATED',
          to: newUserDto.email,
          role: newUserDto.role,
          expiresAt: data.tempPasswordExpiresAt.toISOString(),
          purpose: 'ACCOUNT_CREATED',
          encryptedPayload: data.tempPasswordEncrypted,
          tenantId: 'tenant-1',
        }),
        expect.any(Object),
      );
    });

    it('reports emailEnqueued: false without failing the request when the email queue is down', async () => {
      prismaMock.user.findFirst.mockResolvedValue(null);
      prismaMock.user.create.mockResolvedValue({ id: 'new-user-id', ...newUserDto });
      emailQueueMock.add.mockRejectedValueOnce(new Error('email queue down'));

      const result = await service.create(newUserDto, 'tenant-1', manager);

      expect(result.success).toBe(true);
      expect(result.emailEnqueued).toBe(false);
      expect((result as any).smsEnqueued).toBeUndefined();
      expect((result as any).temporaryPassword).toBeUndefined();
      expect(smsServiceMock.enqueueSms).not.toHaveBeenCalled();
    });

    it('enqueues a STAFF_ACCOUNT_CREATED email without plaintext in the payload', async () => {
      prismaMock.user.findFirst.mockResolvedValue(null);
      prismaMock.user.create.mockResolvedValue({ id: 'new-user-id', ...newUserDto });

      const result = await service.create(newUserDto, 'tenant-1', manager);

      expect(result.emailEnqueued).toBe(true);
      expect(prismaMock.tenant.findUnique).toHaveBeenCalledWith({
        where: { id: 'tenant-1' },
        select: { name: true },
      });
      const [, payload] = emailQueueMock.add.mock.calls[0];
      expect(payload).toEqual(
        expect.objectContaining({
          type: 'STAFF_ACCOUNT_CREATED',
          to: newUserDto.email,
          role: newUserDto.role,
          saccoName: 'Test SACCO',
          tenantId: 'tenant-1',
          expiresAt: expect.any(String),
          purpose: 'ACCOUNT_CREATED',
        }),
      );
      expect(payload).not.toHaveProperty('tempPassword'); // plaintext must never enter the job payload
      expect(typeof payload.encryptedPayload).toBe('string');
    });

    it('blocks MANAGER from creating a TENANT_ADMIN account', async () => {
      await expect(
        service.create({ ...newUserDto, role: UserRole.TENANT_ADMIN }, 'tenant-1', manager),
      ).rejects.toThrow(ForbiddenException);

      expect(prismaMock.user.create).not.toHaveBeenCalled();
    });

    it.each([UserRole.MEMBER, UserRole.CHAIRMAN])(
      'blocks creating a %s account via this endpoint (would be an orphaned User with no Member row)',
      async (role) => {
        await expect(service.create({ ...newUserDto, role }, 'tenant-1', manager)).rejects.toThrow(
          BadRequestException,
        );

        expect(prismaMock.user.create).not.toHaveBeenCalled();
      },
    );

    it('reports a broken audit chain to Sentry without failing the request', async () => {
      prismaMock.user.findFirst.mockResolvedValue(null);
      prismaMock.user.create.mockResolvedValue({ id: 'new-user-id', ...newUserDto });
      const auditError = new Error('audit db unreachable');
      auditMock.create.mockRejectedValueOnce(auditError);

      const result = await service.create(newUserDto, 'tenant-1', manager);

      expect(result.success).toBe(true); // audit failure never blocks account creation
      expect(Sentry.captureException).toHaveBeenCalledWith(
        auditError,
        expect.objectContaining({ tags: { audit_chain_broken: true, action: 'USER.CREATED' } }),
      );
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
      await expect(service.forcePasswordReset('target-id', 'tenant-1', manager)).resolves.toEqual(
        expect.objectContaining({ success: true }),
      );
    });

    it('blocks MANAGER from force-resetting a TENANT_ADMIN target', async () => {
      prismaMock.user.findFirst.mockResolvedValue(makeTarget(UserRole.TENANT_ADMIN));
      await expect(service.forcePasswordReset('target-id', 'tenant-1', manager)).rejects.toThrow(
        ForbiddenException,
      );
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

  describe('revealTemporaryPassword()', () => {
    it('decrypts and returns the temp password for a revealable target', async () => {
      prismaMock.user.findFirst.mockResolvedValue({
        id: 'target-id',
        role: UserRole.LOAN_OFFICER,
        tempPasswordEncrypted: JSON.stringify({
          ciphertext: 'c',
          iv: 'i',
          tag: 't',
          keyId: 'k',
          algorithm: 'aes-256-gcm',
        }),
      });

      const result = await service.revealTemporaryPassword('target-id', 'tenant-1', manager);

      expect(result).toEqual({ temporaryPassword: 'decrypted-temp-password' });
      expect(encryptionMock.decrypt).toHaveBeenCalledWith(
        { ciphertext: 'c', iv: 'i', tag: 't', keyId: 'k', algorithm: 'aes-256-gcm' },
        'tenant-1',
      );
      expect(auditMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'USER.TEMPORARY_PASSWORD_REVEALED',
          entityId: 'target-id',
        }),
      );
      // Never logs the decrypted value itself
      const auditCall = auditMock.create.mock.calls[0][0];
      expect(JSON.stringify(auditCall)).not.toContain('decrypted-temp-password');
    });

    it('rejects when the temp password has already been cleared (user set their own password)', async () => {
      prismaMock.user.findFirst.mockResolvedValue({
        id: 'target-id',
        role: UserRole.LOAN_OFFICER,
        tempPasswordEncrypted: null,
      });

      await expect(
        service.revealTemporaryPassword('target-id', 'tenant-1', manager),
      ).rejects.toThrow('already set their own password');
    });

    it('rejects when the temp password has expired', async () => {
      prismaMock.user.findFirst.mockResolvedValue({
        id: 'target-id',
        role: UserRole.LOAN_OFFICER,
        tempPasswordEncrypted: JSON.stringify({
          ciphertext: 'c',
          iv: 'i',
          tag: 't',
          keyId: 'k',
          algorithm: 'aes-256-gcm',
        }),
        tempPasswordExpiresAt: new Date(Date.now() - 1000),
      });

      await expect(
        service.revealTemporaryPassword('target-id', 'tenant-1', manager),
      ).rejects.toThrow('expired');
      expect(encryptionMock.decrypt).not.toHaveBeenCalled();
    });

    it('blocks MANAGER from revealing a temp password for a TENANT_ADMIN target', async () => {
      prismaMock.user.findFirst.mockResolvedValue({
        id: 'target-id',
        role: UserRole.TENANT_ADMIN,
        tempPasswordEncrypted: JSON.stringify({
          ciphertext: 'c',
          iv: 'i',
          tag: 't',
          keyId: 'k',
          algorithm: 'aes-256-gcm',
        }),
      });

      await expect(
        service.revealTemporaryPassword('target-id', 'tenant-1', manager),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('deactivate() â€” now routed through canManageRole()', () => {
    it.each([UserRole.LOAN_OFFICER, UserRole.ACCOUNTANT])(
      'allows MANAGER to deactivate a %s target',
      async (role) => {
        prismaMock.user.findFirst.mockResolvedValue(makeTarget(role));
        prismaMock.user.update.mockResolvedValue(makeTarget(role));
        await expect(service.deactivate('target-id', 'tenant-1', manager)).resolves.toBeDefined();
      },
    );

    it('blocks MANAGER from deactivating a TENANT_ADMIN target (unchanged from the old inline check)', async () => {
      prismaMock.user.findFirst.mockResolvedValue(makeTarget(UserRole.TENANT_ADMIN));
      await expect(service.deactivate('target-id', 'tenant-1', manager)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('blocks MANAGER from deactivating a peer MANAGER target (behavior change: previously allowed, no inline check covered this pair)', async () => {
      prismaMock.user.findFirst.mockResolvedValue(makeTarget(UserRole.MANAGER));
      await expect(service.deactivate('target-id', 'tenant-1', manager)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
