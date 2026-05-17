import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { SuperAdminIpGuard } from '../src/modules/security/guards/super-admin-ip.guard';
import { AlertsService } from '../src/modules/alerts/alerts.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('SuperAdminIpGuard (e2e)', () => {
  let guard: SuperAdminIpGuard;
  let mockAlertsService: Partial<AlertsService>;
  let mockPrismaService: Partial<PrismaService>;

  beforeEach(async () => {
    process.env.SUPER_ADMIN_ALLOWED_IPS = '192.168.1.100,10.0.0.1';

    mockAlertsService = { sendSlackAlert: jest.fn() };
    mockPrismaService = {
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null), // Simulate new IP by default
      } as any,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SuperAdminIpGuard,
        { provide: AlertsService, useValue: mockAlertsService },
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    guard = module.get<SuperAdminIpGuard>(SuperAdminIpGuard);
  });

  const createMockContext = (role: string, ip: string): ExecutionContext => ({
    switchToHttp: () => ({
      getRequest: () => ({
        user: { id: 'usr_123', role },
        headers: { 'x-forwarded-for': ip },
        socket: { remoteAddress: ip },
      }),
    }),
  } as any);

  it('should allow non-SUPER_ADMIN users regardless of IP', async () => {
    const context = createMockContext('MEMBER', '9.9.9.9');
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('should deny SUPER_ADMIN from unauthorized IP and trigger an alert', async () => {
    const context = createMockContext('SUPER_ADMIN', '9.9.9.9');
    
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    expect(mockAlertsService.sendSlackAlert).toHaveBeenCalled();
  });

  it('should allow SUPER_ADMIN from authorized IP but trigger new IP alert', async () => {
    const context = createMockContext('SUPER_ADMIN', '192.168.1.100');
    
    await expect(guard.canActivate(context)).resolves.toBe(true);
    // Because mockPrismaService returned null (meaning no prior login), an alert is sent
    expect(mockAlertsService.sendSlackAlert).toHaveBeenCalled();
  });
});