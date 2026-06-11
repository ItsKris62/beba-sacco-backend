import { BadRequestException, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { Request, Response, NextFunction } from 'express';
import request = require('supertest');
import { AuthController } from '../auth.controller';
import { AuthService } from '../auth.service';
import { JwtBlocklistService } from '../jwt-blocklist.service';
import { OtpService } from '../otp.service';
import { SessionService } from '../session.service';
import { AuditService } from '../../audit/audit.service';
import { AUDIT_ACTIONS } from '../../audit/audit-actions';
import { QUEUE_NAMES } from '../../queue/queue.constants';
import { SmsService } from '../../sms/sms.service';
import { PrismaService } from '../../../prisma/prisma.service';

jest.mock('argon2', () => ({
  hash: jest.fn(),
}));

const TENANT_ID = 'tenant-uuid-1234';
const USER_ID = 'user-uuid-1234';
const LAST_FIVE_DIGITS = '45678';
const TEST_PHONE = '+254712345678';
const TEST_OTP = '123456';
const NEW_PASSWORD = 'NewSecure@2025!';
const HASHED_PASSWORD = '$argon2id$v=19$m=65536,t=3,p=1$mock';

interface TenantRequest extends Request {
  tenant?: { id: string };
}

interface MockPrismaService {
  user: {
    findMany: jest.Mock;
    update: jest.Mock;
  };
}

interface MockOtpService {
  generate: jest.Mock<Promise<string>, [string]>;
  validate: jest.Mock<Promise<boolean>, [string, string]>;
  delete: jest.Mock<Promise<void>, [string]>;
}

interface MockSmsService {
  enqueueSms: jest.Mock<Promise<void>, [unknown, string]>;
}

interface MockAuditService {
  create: jest.Mock<Promise<void>, [unknown]>;
}

describe('AuthController SMS password reset endpoints', () => {
  let app: INestApplication;
  let prisma: MockPrismaService;
  let otpService: MockOtpService;
  let smsService: MockSmsService;
  let auditService: MockAuditService;

  const activeMemberUser = {
    id: USER_ID,
    email: 'member@beba.co.ke',
    phone: TEST_PHONE,
    phoneNumber: '254712345678',
  };

  const postRequest = () =>
    request(app.getHttpServer())
      .post('/auth/password-reset/request')
      .set('X-Tenant-ID', TENANT_ID)
      .send({ lastFiveDigits: LAST_FIVE_DIGITS });

  const postVerify = (body: Record<string, string>) =>
    request(app.getHttpServer())
      .post('/auth/password-reset/verify')
      .set('X-Tenant-ID', TENANT_ID)
      .send(body);

  beforeEach(async () => {
    prisma = {
      user: {
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: USER_ID }),
      },
    };
    otpService = {
      generate: jest.fn().mockResolvedValue(TEST_OTP),
      validate: jest.fn().mockResolvedValue(true),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    smsService = {
      enqueueSms: jest.fn().mockResolvedValue(undefined),
    };
    auditService = {
      create: jest.fn().mockResolvedValue(undefined),
    };

    jest.mocked(argon2.hash).mockResolvedValue(HASHED_PASSWORD);

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            name: 'global',
            ttl: 60_000,
            limit: 100,
          },
        ]),
      ],
      controllers: [AuthController],
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { sign: jest.fn(), verify: jest.fn(), decode: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn(), getOrThrow: jest.fn() } },
        { provide: AuditService, useValue: auditService },
        { provide: JwtBlocklistService, useValue: { add: jest.fn() } },
        { provide: SessionService, useValue: {} },
        { provide: getQueueToken(QUEUE_NAMES.EMAIL), useValue: { add: jest.fn() } },
        { provide: OtpService, useValue: otpService },
        { provide: SmsService, useValue: smsService },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();

    app = module.createNestApplication();
    app.use((req: TenantRequest, _res: Response, next: NextFunction) => {
      req.tenant = { id: TENANT_ID };
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    if (app) {
      await app.close();
    }
  });

  describe('POST /auth/password-reset/request', () => {
    it('returns 200, generates an OTP, queues SMS, and audits a valid last-five lookup', async () => {
      prisma.user.findMany.mockResolvedValue([activeMemberUser]);

      const response = await postRequest().expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'If your phone number is registered, an OTP has been sent via SMS.',
      });
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: TENANT_ID,
            role: UserRole.MEMBER,
            isActive: true,
            OR: [
              { phone: { endsWith: LAST_FIVE_DIGITS } },
              { phoneNumber: { endsWith: LAST_FIVE_DIGITS } },
            ],
          }),
        }),
      );
      expect(otpService.generate).toHaveBeenCalledWith(TEST_PHONE);
      expect(smsService.enqueueSms).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PASSWORD_RESET_OTP',
          phone: TEST_PHONE,
          message: expect.stringContaining(TEST_OTP),
        }),
        `auth.password-reset-sms:${USER_ID}`,
      );
      expect(auditService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_ACTIONS.AUTH.PASSWORD_RESET_SMS_REQUESTED,
          tenantId: TENANT_ID,
          userId: USER_ID,
        }),
      );
    });

    it('returns 200 and does not generate an OTP when no user matches', async () => {
      prisma.user.findMany.mockResolvedValue([]);

      await postRequest().send({ lastFiveDigits: '99999' }).expect(200);

      expect(otpService.generate).not.toHaveBeenCalled();
      expect(smsService.enqueueSms).not.toHaveBeenCalled();
    });

    it('returns 200 and does not send an OTP when multiple users match', async () => {
      prisma.user.findMany.mockResolvedValue([
        activeMemberUser,
        { ...activeMemberUser, id: 'second-user-id', email: 'second@beba.co.ke' },
      ]);

      await postRequest().expect(200);

      expect(otpService.generate).not.toHaveBeenCalled();
      expect(smsService.enqueueSms).not.toHaveBeenCalled();
    });

    it('returns 429 on the fourth request inside the throttling window', async () => {
      prisma.user.findMany.mockResolvedValue([]);

      await postRequest().expect(200);
      await postRequest().expect(200);
      await postRequest().expect(200);
      await postRequest().expect(429);
    });
  });

  describe('POST /auth/password-reset/verify', () => {
    const validVerifyBody = {
      lastFiveDigits: LAST_FIVE_DIGITS,
      otp: TEST_OTP,
      newPassword: NEW_PASSWORD,
    };

    it('returns 200, updates the password hash, deletes OTP, and audits completion', async () => {
      prisma.user.findMany.mockResolvedValue([activeMemberUser]);
      otpService.validate.mockResolvedValue(true);

      const response = await postVerify(validVerifyBody).expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'Password reset successfully. Please log in with your new password.',
      });
      expect(otpService.validate).toHaveBeenCalledWith(TEST_PHONE, TEST_OTP);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: expect.objectContaining({
          passwordHash: HASHED_PASSWORD,
          mustChangePassword: false,
          refreshToken: null,
        }),
      });
      expect(otpService.delete).toHaveBeenCalledWith(TEST_PHONE);
      expect(auditService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_ACTIONS.AUTH.PASSWORD_RESET_SMS_COMPLETED,
          tenantId: TENANT_ID,
          userId: USER_ID,
        }),
      );
    });

    it('returns 400 and does not update the password when OTP validation fails', async () => {
      prisma.user.findMany.mockResolvedValue([activeMemberUser]);
      otpService.validate.mockResolvedValue(false);

      await postVerify({ ...validVerifyBody, otp: '999999' }).expect(400);

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(otpService.delete).not.toHaveBeenCalled();
      expect(auditService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_ACTIONS.AUTH.PASSWORD_RESET_SMS_FAILED,
          userId: USER_ID,
        }),
      );
    });

    it('returns 400 and does not update the password when the OTP is expired', async () => {
      prisma.user.findMany.mockResolvedValue([activeMemberUser]);
      otpService.validate.mockResolvedValue(false);

      await postVerify(validVerifyBody).expect(400);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('returns 400 for a weak password and does not attempt an update', async () => {
      await postVerify({ ...validVerifyBody, newPassword: '123' }).expect(400);

      expect(otpService.validate).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('propagates OTP service BadRequestException and avoids password updates', async () => {
      prisma.user.findMany.mockResolvedValue([activeMemberUser]);
      otpService.validate.mockRejectedValue(new BadRequestException('Invalid OTP'));

      await postVerify({ ...validVerifyBody, otp: '999999' }).expect(400);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
