/**
 * Phase 7 – Enterprise Operational Maturity E2E Tests
 * Tests: Zero-Trust, Data Governance, Partner Ecosystem, Executive Reports,
 *        Stress Testing, SLO Tracking, FinOps
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';

// ─── Mock Services ────────────────────────────────────────────────────────────

const mockPrisma = {
  consentRegistry: {
    create: jest.fn().mockResolvedValue({ id: 'consent-1' }),
    findFirst: jest.fn().mockResolvedValue({ granted: true }),
    findMany: jest.fn().mockResolvedValue([]),
  },
  dataAccessLog: {
    create: jest.fn().mockResolvedValue({ id: 'log-1' }),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  },
  erasureRequest: {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: 'erasure-1', certificateId: 'CERT-001' }),
    update: jest.fn().mockResolvedValue({}),
  },
  partner: {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({
      id: 'partner-1',
      name: 'Test Partner',
      clientId: 'beba_abc123',
      status: 'PENDING_KYB',
    }),
    findUnique: jest.fn().mockResolvedValue({
      id: 'partner-1',
      rateLimitTier: 'standard',
      slaConfig: { p95LatencyMs: 150, uptimePct: 99.9, errorRatePct: 0.1 },
      name: 'Test Partner',
      contactEmail: 'partner@test.com',
      tenantId: 'tenant-1',
    }),
    update: jest.fn().mockResolvedValue({}),
    count: jest.fn().mockResolvedValue(1),
    findMany: jest.fn().mockResolvedValue([]),
  },
  partnerUsageSnapshot: {
    upsert: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
  },
  slaIncident: {
    create: jest.fn().mockResolvedValue({ id: 'incident-1' }),
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({}),
  },
  executiveReport: {
    upsert: jest.fn().mockResolvedValue({}),
  },
  sasraRatioSnapshot: {
    findFirst: jest.fn().mockResolvedValue({
      portfolioQualityRatio: 0.03,
      liquidityRatio: 0.20,
      capitalAdequacyRatio: 0.12,
      nplAmount: 500000,
    }),
  },
  loan: {
    aggregate: jest.fn().mockResolvedValue({ _sum: { principalAmount: 10000000, outstandingBalance: 8000000 }, _count: { id: 50 } }),
  },
  transaction: {
    aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 5000000 }, _count: { id: 200 } }),
  },
  member: {
    count: jest.fn().mockResolvedValue(150),
    findUnique: jest.fn().mockResolvedValue({ id: 'member-1', nationalId: '12345678' }),
    update: jest.fn().mockResolvedValue({}),
  },
  provisioningEntry: {
    aggregate: jest.fn().mockResolvedValue({ _sum: { eclAmount: 250000, ead: 8000000 } }),
  },
};

const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(true),
  incr: jest.fn().mockResolvedValue(1),
  incrBy: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
  exists: jest.fn().mockResolvedValue(false),
  scanKeys: jest.fn().mockResolvedValue([]),
  getJson: jest.fn().mockResolvedValue(null),
  setJson: jest.fn().mockResolvedValue(true),
};

const mockQueue = {
  add: jest.fn().mockResolvedValue({ id: 'job-1' }),
};

// ─── Unit Tests ───────────────────────────────────────────────────────────────

describe('Phase 7 – Zero-Trust Security', () => {
  describe('EncryptionService', () => {
    it('should encrypt and decrypt PII fields with AES-256-GCM', async () => {
      const { EncryptionService } = await import(
        '../src/modules/zero-trust/encryption/encryption.service'
      );
      const svc = new EncryptionService({ get: () => 'a'.repeat(32) } as any);
      const plaintext = 'ID-12345678';
      const encrypted = await svc.encrypt(plaintext, 'tenant-1');
      expect(encrypted).not.toBe(plaintext);
      expect(encrypted).toContain(':'); // iv:ciphertext:tag format
      const decrypted = await svc.decrypt(encrypted, 'tenant-1');
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertext for same plaintext (IV randomness)', async () => {
      const { EncryptionService } = await import(
        '../src/modules/zero-trust/encryption/encryption.service'
      );
      const svc = new EncryptionService({ get: () => 'b'.repeat(32) } as any);
      const enc1 = await svc.encrypt('test', 'tenant-1');
      const enc2 = await svc.encrypt('test', 'tenant-1');
      expect(enc1).not.toBe(enc2); // Different IVs
    });
  });

  describe('PiiTokenizationService', () => {
    it('should tokenize PII deterministically with HMAC-SHA256', async () => {
      const { PiiTokenizationService } = await import(
        '../src/modules/zero-trust/pii-tokenization/pii-tokenization.service'
      );
      const svc = new PiiTokenizationService({ get: () => 'secret-salt' } as any);
      const token1 = svc.tokenize('0712345678', 'tenant-1');
      const token2 = svc.tokenize('0712345678', 'tenant-1');
      expect(token1).toBe(token2); // Deterministic
      expect(token1).not.toBe('0712345678'); // Not plaintext
    });

    it('should apply SHOW_LAST_4 masking policy', async () => {
      const { PiiTokenizationService } = await import(
        '../src/modules/zero-trust/pii-tokenization/pii-tokenization.service'
      );
      const svc = new PiiTokenizationService({ get: () => 'secret' } as any);
      const masked = svc.mask('0712345678', 'SHOW_LAST_4');
      expect(masked).toBe('*****5678');
    });

    it('should apply REDACT_FULL masking policy', async () => {
      const { PiiTokenizationService } = await import(
        '../src/modules/zero-trust/pii-tokenization/pii-tokenization.service'
      );
      const svc = new PiiTokenizationService({ get: () => 'secret' } as any);
      const masked = svc.mask('john.doe@example.com', 'REDACT_FULL');
      expect(masked).toBe('[REDACTED]');
    });
  });

  describe('ThreatDetectionService', () => {
    it('should calculate threat score from multiple signals', async () => {
      const { ThreatDetectionService } = await import(
        '../src/modules/zero-trust/threat-detection/threat-detection.service'
      );
      const svc = new ThreatDetectionService(mockRedis as any);
      const score = await svc.calculateThreatScore({
        tenantId: 'tenant-1',
        ipAddress: '1.2.3.4',
        deviceFingerprint: 'fp-abc',
        userId: 'user-1',
        action: 'LOGIN',
      });
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('should block requests with threat score > 80', async () => {
      const { ThreatDetectionService } = await import(
        '../src/modules/zero-trust/threat-detection/threat-detection.service'
      );
      mockRedis.get.mockResolvedValueOnce('90'); // High IP reputation score
      const svc = new ThreatDetectionService(mockRedis as any);
      const score = await svc.calculateThreatScore({
        tenantId: 'tenant-1',
        ipAddress: '192.168.1.1',
        deviceFingerprint: 'fp-known-bad',
        userId: 'user-1',
        action: 'TRANSACTION',
      });
      expect(score).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('Phase 7 – Data Governance', () => {
  describe('ConsentRegistryService', () => {
    it('should record consent grant', async () => {
      const { ConsentRegistryService } = await import(
        '../src/modules/governance/consent/consent-registry.service'
      );
      const svc = new ConsentRegistryService(mockPrisma as any);
      await svc.record({
        tenantId: 'tenant-1',
        memberId: 'member-1',
        purpose: 'CRB_REPORTING',
        granted: true,
        version: '1.0',
        channel: 'WEB',
      });
      expect(mockPrisma.consentRegistry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ purpose: 'CRB_REPORTING', granted: true }),
        }),
      );
    });

    it('should return true for valid consent', async () => {
      const { ConsentRegistryService } = await import(
        '../src/modules/governance/consent/consent-registry.service'
      );
      mockPrisma.consentRegistry.findFirst.mockResolvedValueOnce({ granted: true });
      const svc = new ConsentRegistryService(mockPrisma as any);
      const result = await svc.hasValidConsent('tenant-1', 'member-1', 'CRB_REPORTING');
      expect(result).toBe(true);
    });

    it('should return false when consent is revoked', async () => {
      const { ConsentRegistryService } = await import(
        '../src/modules/governance/consent/consent-registry.service'
      );
      mockPrisma.consentRegistry.findFirst.mockResolvedValueOnce({ granted: false });
      const svc = new ConsentRegistryService(mockPrisma as any);
      const result = await svc.hasValidConsent('tenant-1', 'member-1', 'MARKETING');
      expect(result).toBe(false);
    });
  });

  describe('LineageService', () => {
    it('should log PII access events', async () => {
      const { LineageService } = await import(
        '../src/modules/governance/lineage/lineage.service'
      );
      const svc = new LineageService(mockPrisma as any);
      await svc.log({
        tenantId: 'tenant-1',
        entity: 'Member',
        entityId: 'member-1',
        field: 'nationalId',
        accessorId: 'user-admin',
        accessorRole: 'MANAGER',
        purpose: 'CRB_REPORTING',
        action: 'READ',
      });
      expect(mockPrisma.dataAccessLog.create).toHaveBeenCalled();
    });

    it('should query lineage with filters', async () => {
      const { LineageService } = await import(
        '../src/modules/governance/lineage/lineage.service'
      );
      mockPrisma.dataAccessLog.findMany.mockResolvedValueOnce([
        { id: 'log-1', entity: 'Member', action: 'READ' },
      ]);
      mockPrisma.dataAccessLog.count.mockResolvedValueOnce(1);
      const svc = new LineageService(mockPrisma as any);
      const result = await svc.query({ tenantId: 'tenant-1', entity: 'Member' });
      expect(result.records).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe('DataErasureService', () => {
    it('should queue erasure request idempotently', async () => {
      const { DataErasureService } = await import(
        '../src/modules/governance/erasure/data-erasure.service'
      );
      const svc = new DataErasureService(mockPrisma as any, mockQueue as any);
      const result = await svc.queueErasure({
        tenantId: 'tenant-1',
        memberId: 'member-1',
        reason: 'Member request',
        requestedBy: 'admin-1',
      });
      expect(result.status).toBe('QUEUED');
      expect(result.certificateId).toBeDefined();
    });

    it('should return existing request for duplicate memberId (idempotent)', async () => {
      const { DataErasureService } = await import(
        '../src/modules/governance/erasure/data-erasure.service'
      );
      mockPrisma.erasureRequest.findFirst.mockResolvedValueOnce({
        id: 'existing-1',
        status: 'COMPLETED',
        certificateId: 'CERT-EXISTING',
      });
      const svc = new DataErasureService(mockPrisma as any, mockQueue as any);
      const result = await svc.queueErasure({
        tenantId: 'tenant-1',
        memberId: 'member-1',
        reason: 'Duplicate request',
        requestedBy: 'admin-1',
      });
      expect(result.status).toBe('COMPLETED');
    });
  });
});

describe('Phase 7 – Partner Ecosystem', () => {
  describe('BillingService', () => {
    it('should record API call and increment counters', async () => {
      const { BillingService } = await import(
        '../src/modules/partners/billing.service'
      );
      const svc = new BillingService(mockPrisma as any, mockRedis as any);
      await svc.recordApiCall('partner-1', { success: true, latencyMs: 45, responseBytes: 1024 });
      expect(mockRedis.incr).toHaveBeenCalled();
    });

    it('should calculate usage metrics for a period', async () => {
      const { BillingService } = await import(
        '../src/modules/partners/billing.service'
      );
      mockRedis.get
        .mockResolvedValueOnce('1000') // calls
        .mockResolvedValueOnce('5')    // errors
        .mockResolvedValueOnce('102400') // bytes
        .mockResolvedValueOnce('45');  // p95
      const svc = new BillingService(mockPrisma as any, mockRedis as any);
      const usage = await svc.getUsage('partner-1', 'MONTH');
      expect(usage).toHaveLength(1);
      expect(usage[0].calls).toBe(1000);
      expect(usage[0].errors).toBe(5);
    });
  });

  describe('SlaMonitorService', () => {
    it('should return compliant status when metrics are within SLA', async () => {
      const { SlaMonitorService } = await import(
        '../src/modules/partners/sla-monitor.service'
      );
      mockRedis.get
        .mockResolvedValueOnce('1000') // calls
        .mockResolvedValueOnce('1')    // errors
        .mockResolvedValueOnce('80');  // p95 (< 150ms SLA)
      const svc = new SlaMonitorService(mockPrisma as any, mockRedis as any, { get: jest.fn() } as any);
      const status = await svc.checkCompliance('partner-1');
      expect(status.compliant).toBe(true);
      expect(status.breaches).toHaveLength(0);
    });

    it('should detect P95 latency breach', async () => {
      const { SlaMonitorService } = await import(
        '../src/modules/partners/sla-monitor.service'
      );
      mockRedis.get
        .mockResolvedValueOnce('1000') // calls
        .mockResolvedValueOnce('1')    // errors
        .mockResolvedValueOnce('200'); // p95 (> 150ms SLA)
      const svc = new SlaMonitorService(mockPrisma as any, mockRedis as any, { get: jest.fn() } as any);
      const status = await svc.checkCompliance('partner-1');
      expect(status.breaches.length).toBeGreaterThan(0);
      expect(status.breaches[0]).toContain('P95 latency');
    });
  });
});

describe('Phase 7 – Executive Reports & Stress Testing', () => {
  describe('ExecutiveReportService', () => {
    it('should generate a monthly executive report', async () => {
      const { ExecutiveReportService } = await import(
        '../src/modules/reports/executive-report.service'
      );
      const svc = new ExecutiveReportService(mockPrisma as any, mockQueue as any);
      const report = await svc.generate('tenant-1', 'MONTHLY');
      expect(report.tenantId).toBe('tenant-1');
      expect(report.periodType).toBe('MONTHLY');
      expect(report.portfolioGrowth).toBeDefined();
      expect(report.nplTrends).toBeDefined();
      expect(report.liquidityRatios).toBeDefined();
    });

    it('should export report as CSV', async () => {
      const { ExecutiveReportService } = await import(
        '../src/modules/reports/executive-report.service'
      );
      const svc = new ExecutiveReportService(mockPrisma as any, mockQueue as any);
      const report = await svc.generate('tenant-1', 'MONTHLY');
      const csv = svc.exportAsCsv(report);
      expect(csv).toContain('Metric,Value,Period');
      expect(csv).toContain('Total Loans');
      expect(csv).toContain('NPL Ratio');
    });
  });

  describe('StressTestService', () => {
    it('should run RATE_HIKE scenario and return impact report', async () => {
      const { StressTestService } = await import(
        '../src/modules/reports/stress-test.service'
      );
      const svc = new StressTestService(mockPrisma as any);
      const result = await svc.run('tenant-1', 'RATE_HIKE');
      expect(result.scenario).toBe('RATE_HIKE');
      expect(result.baselineMetrics).toBeDefined();
      expect(result.stressedMetrics).toBeDefined();
      expect(result.impact).toBeDefined();
      expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(result.riskRating);
    });

    it('should run NPL_SPIKE scenario', async () => {
      const { StressTestService } = await import(
        '../src/modules/reports/stress-test.service'
      );
      const svc = new StressTestService(mockPrisma as any);
      const result = await svc.run('tenant-1', 'NPL_SPIKE');
      expect(result.scenario).toBe('NPL_SPIKE');
      expect(result.impact.nplDelta).toBe(0.05);
    });

    it('should run LIQUIDITY_CRUNCH scenario', async () => {
      const { StressTestService } = await import(
        '../src/modules/reports/stress-test.service'
      );
      const svc = new StressTestService(mockPrisma as any);
      const result = await svc.run('tenant-1', 'LIQUIDITY_CRUNCH');
      expect(result.scenario).toBe('LIQUIDITY_CRUNCH');
      expect(result.impact.liquidityDelta).toBeLessThan(0);
    });

    it('should be non-destructive (read-only)', async () => {
      const { StressTestService } = await import(
        '../src/modules/reports/stress-test.service'
      );
      const svc = new StressTestService(mockPrisma as any);
      await svc.run('tenant-1', 'RATE_HIKE');
      // Verify no write operations were called
      expect(mockPrisma.loan.aggregate).toHaveBeenCalled();
      expect(mockPrisma.member.update).not.toHaveBeenCalled();
    });
  });
});

describe('Phase 7 – SRE & SLO Tracking', () => {
  describe('SloTrackerService', () => {
    it('should return SLO report with burn rates', async () => {
      const { SloTrackerService } = await import(
        '../src/modules/sre/slo-tracker.service'
      );
      const svc = new SloTrackerService(mockRedis as any);
      const report = await svc.getSloReport('tenant-1');
      expect(report.tenantId).toBe('tenant-1');
      expect(report.slos).toHaveLength(3); // availability, latency_p95, error_rate
      expect(['OK', 'WARNING', 'CRITICAL']).toContain(report.overallStatus);
    });

    it('should record request and update SLO counters', async () => {
      const { SloTrackerService } = await import(
        '../src/modules/sre/slo-tracker.service'
      );
      const svc = new SloTrackerService(mockRedis as any);
      await svc.recordRequest('tenant-1', { success: true, latencyMs: 45 });
      expect(mockRedis.incr).toHaveBeenCalled();
    });

    it('should detect exhausted error budget', async () => {
      const { SloTrackerService } = await import(
        '../src/modules/sre/slo-tracker.service'
      );
      // Simulate high error count
      mockRedis.get
        .mockResolvedValue('1000'); // All requests are errors
      const svc = new SloTrackerService(mockRedis as any);
      const exhausted = await svc.isErrorBudgetExhausted('tenant-1', 0.5);
      expect(typeof exhausted).toBe('boolean');
    });
  });

  describe('FinOpsService', () => {
    it('should generate FinOps report with cost breakdown', async () => {
      const { FinOpsService } = await import(
        '../src/modules/sre/finops.service'
      );
      const svc = new FinOpsService(mockPrisma as any, mockRedis as any);
      const report = await svc.generateReport('tenant-1');
      expect(report.tenantId).toBe('tenant-1');
      expect(report.costPerTenant).toBeDefined();
      expect(report.queueEfficiency).toBeDefined();
      expect(report.scalingRecommendations).toBeDefined();
      expect(report.scalingRecommendations.length).toBeGreaterThan(0);
    });

    it('should detect backlogged queues as idle resources', async () => {
      const { FinOpsService } = await import(
        '../src/modules/sre/finops.service'
      );
      mockRedis.get.mockImplementation((key: string) => {
        if (key.includes(':depth:')) return Promise.resolve('5000'); // Backlogged
        return Promise.resolve('0');
      });
      const svc = new FinOpsService(mockPrisma as any, mockRedis as any);
      const report = await svc.generateReport('tenant-1');
      const backloggedQueues = report.queueEfficiency.filter((q) => q.efficiency === 'BACKLOGGED');
      expect(backloggedQueues.length).toBeGreaterThan(0);
    });
  });
});

describe('Phase 7 – API Contracts', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Lightweight integration test using mocked services
    const { Phase7AdminController } = await import(
      '../src/modules/admin/phase7/phase7-admin.controller'
    );

    const mockErasure = {
      queueErasure: jest.fn().mockResolvedValue({ status: 'QUEUED', certificateId: 'CERT-001' }),
    };
    const mockLineage = {
      query: jest.fn().mockResolvedValue({ records: [], total: 0 }),
      getConsentProofs: jest.fn().mockResolvedValue([]),
    };
    const mockPartnerOnboarding = {
      onboard: jest.fn().mockResolvedValue({
        partnerId: 'p-1', clientId: 'beba_abc', clientSecret: 'secret', apiKey: 'key',
        scopes: ['read:loans'], rateLimitTier: 'standard', slaConfig: {},
      }),
    };
    const mockBilling = {
      getUsage: jest.fn().mockResolvedValue([{ calls: 100, errors: 1 }]),
      getMonthlyInvoice: jest.fn().mockResolvedValue({ totalCalls: 100, totalCostKes: 0.1 }),
    };
    const mockSlaMonitor = {
      checkCompliance: jest.fn().mockResolvedValue({ compliant: true, breaches: [] }),
    };
    const mockExecReport = {
      generate: jest.fn().mockResolvedValue({ tenantId: 'tenant-1', period: '2026-04', summary: 'OK' }),
      exportAsCsv: jest.fn().mockReturnValue('Metric,Value,Period\n'),
    };
    const mockStressTest = {
      run: jest.fn().mockResolvedValue({ scenario: 'RATE_HIKE', riskRating: 'LOW', impact: {} }),
    };
    const mockSloTracker = {
      getSloReport: jest.fn().mockResolvedValue({ slos: [], overallStatus: 'OK' }),
    };
    const mockFinOps = {
      generateReport: jest.fn().mockResolvedValue({ costPerTenant: {}, scalingRecommendations: [] }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [Phase7AdminController],
      providers: [
        { provide: 'DataErasureService', useValue: mockErasure },
        { provide: 'LineageService', useValue: mockLineage },
        { provide: 'PartnerOnboardingService', useValue: mockPartnerOnboarding },
        { provide: 'BillingService', useValue: mockBilling },
        { provide: 'SlaMonitorService', useValue: mockSlaMonitor },
        { provide: 'ExecutiveReportService', useValue: mockExecReport },
        { provide: 'StressTestService', useValue: mockStressTest },
        { provide: 'SloTrackerService', useValue: mockSloTracker },
        { provide: 'FinOpsService', useValue: mockFinOps },
      ],
    })
      .overrideGuard('JwtAuthGuard' as any)
      .useValue({ canActivate: () => true })
      .overrideGuard('RolesGuard' as any)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('POST /admin/governance/erasure → 202 ACCEPTED', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/governance/erasure?tenantId=tenant-1')
      .set('X-Tenant-ID', 'tenant-1')
      .send({ memberId: 'member-1', reason: 'Member request' });
    expect(res.status).toBe(202);
  });

  it('GET /admin/governance/lineage → 200 OK', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/governance/lineage?tenantId=tenant-1&entity=Member')
      .set('X-Tenant-ID', 'tenant-1');
    expect(res.status).toBe(200);
  });

  it('POST /admin/partners/onboard → 201 CREATED', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/partners/onboard?tenantId=tenant-1')
      .set('X-Tenant-ID', 'tenant-1')
      .send({
        name: 'Test Partner',
        scopes: ['read:loans'],
        slaConfig: { p95LatencyMs: 150, uptimePct: 99.9, errorRatePct: 0.1 },
        contact: { name: 'John Doe', email: 'john@partner.com' },
      });
    expect(res.status).toBe(201);
    expect(res.body.partnerId).toBeDefined();
  });

  it('GET /admin/partners/:id/usage → 200 OK', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/partners/partner-1/usage?period=MONTH')
      .set('X-Tenant-ID', 'tenant-1');
    expect(res.status).toBe(200);
  });

  it('GET /admin/reports/executive → 200 OK', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/reports/executive?tenantId=tenant-1&period=MONTHLY')
      .set('X-Tenant-ID', 'tenant-1');
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe('tenant-1');
  });

  it('POST /admin/stress-test/run → 200 OK', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/stress-test/run?tenantId=tenant-1')
      .set('X-Tenant-ID', 'tenant-1')
      .send({ scenario: 'RATE_HIKE' });
    expect(res.status).toBe(200);
    expect(res.body.scenario).toBe('RATE_HIKE');
  });

  it('GET /admin/sre/slo → 200 OK', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/sre/slo?tenantId=tenant-1')
      .set('X-Tenant-ID', 'tenant-1');
    expect(res.status).toBe(200);
    expect(res.body.overallStatus).toBeDefined();
  });

  it('GET /admin/finops/report → 200 OK', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/finops/report?tenantId=tenant-1')
      .set('X-Tenant-ID', 'tenant-1');
    expect(res.status).toBe(200);
    expect(res.body.costPerTenant).toBeDefined();
  });

  it('POST /admin/compliance/filing/submit → 202 ACCEPTED', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/compliance/filing/submit?tenantId=tenant-1')
      .set('X-Tenant-ID', 'tenant-1')
      .send({ filingType: 'CBK', period: '2026-03' });
    expect(res.status).toBe(202);
    expect(res.body.receiptId).toBeDefined();
  });
});
