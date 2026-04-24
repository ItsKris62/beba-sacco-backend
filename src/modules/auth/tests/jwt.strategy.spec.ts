import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { JwtStrategy, JwtPayload } from '../strategies/jwt.strategy';
import { PrismaService } from '../../../prisma/prisma.service';

const mockPrismaService = {
  user: {
    findUnique: jest.fn(),
  },
};

const mockConfigService = {
  getOrThrow: jest.fn().mockReturnValue('test-secret-32-chars-or-more!!!!!!'),
};

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;

  const payload: JwtPayload = {
    sub: 'user-uuid',
    email: 'user@kcboda.co.ke',
    role: UserRole.MEMBER,
    tenantId: 'tenant-uuid',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    strategy = module.get<JwtStrategy>(JwtStrategy);
    jest.clearAllMocks();
  });

  it('returns the user when found and active', async () => {
    const dbUser = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      tenantId: payload.tenantId,
      isActive: true,
      mustChangePassword: false,
    };
    mockPrismaService.user.findUnique.mockResolvedValue(dbUser);

    const result = await strategy.validate(payload);

    expect(result).toEqual(dbUser);
  });

  it('throws UnauthorizedException when user does not exist', async () => {
    mockPrismaService.user.findUnique.mockResolvedValue(null);

    await expect(strategy.validate(payload)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when user is deactivated', async () => {
    mockPrismaService.user.findUnique.mockResolvedValue({ ...payload, isActive: false });

    await expect(strategy.validate(payload)).rejects.toThrow(UnauthorizedException);
  });
});
