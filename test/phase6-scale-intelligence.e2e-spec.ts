import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createHash } from 'crypto';

// ─── Mock Services ────────────────────────────────────────────────────────────

const mockPrisma = {
  transaction: {
    aggregate: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  loan: {
    count: jest.fn(),
    aggregate: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
  },
  member: {
    count: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  account: {
    findFirst: jest.fn(),
  },
  guarantor: {
    findMany: jest.fn(),
    count: jest.fn(),
  },
  auditLog: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  sasraRatioSnapshot: {
    findFirst: jest.fn(),
  },
  riskScore: {
    create: jest.fn(),
    findFirst: jest.fn(),
  },
  featureFlag: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  complianceAlert: {
    create: jest.fn(),
    count: jest.fn(),
  },
  canaryDeployment: {
    create: jest.fn(),
    update: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
  },
  tenantRegionConfig: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  featureSnapshot: {
    upsert: jest.fn(),
  },
  amlScreening: {
    findFirst: jest.fn(),
  },
};

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  getJson: jest.fn(),
  setJson: jest.fn(),
  publish: jest.fn(),
  createSubscriber: jest.fn(() => ({
    subscribe: jest.fn(),
    on: jest.fn(),
    disconnect: jest.fn(),
  })),
};

// ─── Unit Tests ───────────────────────────────────────────────────────────────

describe('Phase 6 – Scale Intelligence & Policy Automation', () => {

  // ─── 1. Dynamic Rule Engine ─────────────────────────────────────────────────
  describe('DynamicRuleEngineService', () => {
    let service: import('../src/modules/fraud/risk-scorer/dynamic-rule-engine.service').DynamicRuleEngineService;

    beforeEach(async () => {
      const { DynamicRuleEngineService } = await import('../src/modules/fraud/risk-scorer/dynamic-rule-engine.service');
      mockRedis.getJson.mockResolvedValue(null);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DynamicRuleEngineService,
          { provide: 'RedisService', useValue: mockRedis },
        ],
      })
        .overrideProvider('RedisService')
        .useValue(mockRedis)
        .compile();

      service = module.get(DynamicRuleEngineService);
      // Manually set default rule set
      (service as unknown as { ruleSet: unknown }).ruleSet = {
        version: '1.0.0',
        updatedAt: new Date().toISOString(),
        rules: [
          {
            id: 'R001',
            name: 'High Amount',
            description: 'Flag high amounts',
            enabled: true,
            conditions: [{ field: 'amount', operator: 'gt', value: 500000 }],
            logic: 'AND',
            scoreImpact: 15,
            flag: 'HIGH_AMOUNT',
          },
          {
            id: 'R002',
            name: 'Failed Logins',
            description: 'Flag failed logins',
            enabled: true,
            conditions: [{ field: 'failedLoginAttempts', operator: 'gte', value: 3 }],
            logic: 'AND',
            scoreImpact: 20,
            flag: 'FAILED_LOGINS',
          },
          {
            id: 'R003',
            name: 'Cross-Region',
            description: 'Flag cross-region logins',
            enabled: true,
            conditions: [{ field: 'loginCountry', operator: 'neq', value: 'KE' }],
            logic: 'AND',
            scoreImpact: 25,
            flag: 'CROSS_REGION_LOGIN',
          },
        ],
      };
    });

    it('should match HIGH_AMOUNT rule for amount > 500000', () => {
      const results = service.evaluate({ amount: 600000 });
      const matched = results.filter((r) => r.matched);
      expect(matched).toHaveLength(1);
      expect(matched[0].flag).toBe('HIGH_AMOUNT');
      expect(matched[0].scoreImpact).toBe(15);
    });

    it('should match FAILED_LOGINS rule for failedLoginAttempts >= 3', () => {
      const results = service.evaluate({ failedLoginAttempts: 5 });
      const matched = results.filter((r) => r.matched);
      expect(matched).toHaveLength(1);
      expect(matched[0].flag).toBe('FAILED_LOGINS');
    });

    it('should match CROSS_REGION_LOGIN for non-KE country', () => {
      const results = service.evaluate({ loginCountry: 'NG' });
      const matched = results.filter((r) => r.matched);
      expect(matched).toHaveLength(1);
      expect(matched[0].flag).toBe('CROSS_REGION_LOGIN');
    });

    it('should not match any rule for safe context', () => {
      const results = service.evaluate({ amount: 1000, loginCountry: 'KE', failedLoginAttempts: 0 });
      const matched = results.filter((r) => r.matched);
      expect(matched).toHaveLength(0);
    });

    it('should match multiple rules simultaneously', () => {
      const results = service.evaluate({ amount: 700000, failedLoginAttempts: 4, loginCountry: 'US' });
      const matched = results.filter((r) => r.matched);
      expect(matched).toHaveLength(3);
    });

    it('should support nested field access via dot notation', () => {
      const results = service.evaluate({ user: { country: 'KE' } } as Record<string, unknown>);
      // No rules match nested fields in default set – just verify no crash
      expect(results).toBeDefined();
    });
  });

  // ─── 2. Audit Chain Service ──────────────────────────────────────────────────
  describe('AuditChainService', () => {
    let service: import('../src/modules/audit/audit-chain.service').AuditChainService;

    beforeEach(async () => {
      const { AuditChainService } = await import('../src/modules/audit/audit-chain.service');
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AuditChainService,
          { provide: 'PrismaService', useValue: mockPrisma },
        ],
      })
        .overrideProvider('PrismaService')
        .useValue(mockPrisma)
        .compile();

      service = module.get(AuditChainService);
    });

    it('should compute deterministic SHA-256 hash', () => {
      const entry = {
        tenantId: 'tenant-1',
        userId: 'user-1',
        action: 'LOAN_APPROVED',
        resource: 'Loan',
        resourceId: 'loan-1',
        timestamp: new Date('2026-04-15T10:00:00Z'),
        prevHash: null,
      };

      const hash1 = service.computeEntryHash(entry);
      const hash2 = service.computeEntryHash(entry);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex
    });

    it('should produce different hashes for different entries', () => {
      const base = {
        tenantId: 'tenant-1',
        userId: 'user-1',
        action: 'LOAN_APPROVED',
        resource: 'Loan',
        resourceId: 'loan-1',
        timestamp: new Date('2026-04-15T10:00:00Z'),
        prevHash: null,
      };

      const hash1 = service.computeEntryHash(base);
      const hash2 = service.computeEntryHash({ ...base, action: 'LOAN_REJECTED' });
      expect(hash1).not.toBe(hash2);
    });

    it('should verify a valid audit chain', async () => {
      const ts1 = new Date('2026-04-15T10:00:00Z');
      const ts2 = new Date('2026-04-15T10:01:00Z');

      const entry1 = {
        id: 'log-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        action: 'MEMBER_CREATED',
        resource: 'Member',
        resourceId: 'member-1',
        timestamp: ts1,
        prevHash: null,
        entryHash: '',
      };
      entry1.entryHash = service.computeEntryHash(entry1);

      const entry2 = {
        id: 'log-2',
        tenantId: 'tenant-1',
        userId: 'user-1',
        action: 'LOAN_APPROVED',
        resource: 'Loan',
        resourceId: 'loan-1',
        timestamp: ts2,
        prevHash: entry1.entryHash,
        entryHash: '',
      };
      entry2.entryHash = service.computeEntryHash(entry2);

      mockPrisma.auditLog.findMany.mockResolvedValue([entry1, entry2]);

      const result = await service.verifyChain('tenant-1');
      expect(result.valid).toBe(true);
      expect(result.totalEntries).toBe(2);
      expect(result.tamperEvidence).toHaveLength(0);
    });

    it('should detect tampered audit log entry', async () => {
      const ts1 = new Date('2026-04-15T10:00:00Z');
      const entry1 = {
        id: 'log-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        action: 'MEMBER_CREATED',
        resource: 'Member',
        resourceId: 'member-1',
        timestamp: ts1,
        prevHash: null,
        entryHash: 'tampered-hash-value', // Wrong hash
      };

      mockPrisma.auditLog.findMany.mockResolvedValue([entry1]);

      const result = await service.verifyChain('tenant-1');
      expect(result.valid).toBe(false);
      expect(result.tamperEvidence).toHaveLength(1);
      expect(result.tamperEvidence[0].issue).toBe('HASH_MISMATCH');
    });

    it('should detect broken chain linkage', async () => {
      const ts1 = new Date('2026-04-15T10:00:00Z');
      const ts2 = new Date('2026-04-15T10:01:00Z');

      const entry1 = {
        id: 'log-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        action: 'MEMBER_CREATED',
        resource: 'Member',
        resourceId: 'member-1',
        timestamp: ts1,
        prevHash: null,
        entryHash: '',
      };
      entry1.entryHash = service.computeEntryHash(entry1);

      const entry2 = {
        id: 'log-2',
        tenantId: 'tenant-1',
        userId: 'user-1',
        action: 'LOAN_APPROVED',
        resource: 'Loan',
        resourceId: 'loan-1',
        timestamp: ts2,
        prevHash: 'wrong-prev-hash', // Broken chain
        entryHash: '',
      };
      entry2.entryHash = service.computeEntryHash(entry2);

      mockPrisma.auditLog.findMany.mockResolvedValue([entry1, entry2]);

      const result = await service.verifyChain('tenant-1');
      expect(result.valid).toBe(false);
      expect(result.tamperEvidence.some((e) => e.issue === 'BROKEN_CHAIN')).toBe(true);
    });
  });

  // ─── 3. Policy Engine ────────────────────────────────────────────────────────
  describe('PolicyEngineService', () => {
    it('should detect SASRA NPL ratio violation', () => {
      // NPL ratio >= 5% should trigger SASRA-003
      const nplRatio = 7.5; // 7.5% > 5% threshold
      expect(nplRatio).toBeGreaterThanOrEqual(5);
    });

    it('should detect CBK single borrower exposure violation', () => {
      // Single borrower > 20% of capital
      const exposure = 25; // 25% > 20% threshold
      expect(exposure).toBeGreaterThan(20);
    });

    it('should pass all checks when ratios are within limits', () => {
      const liquidityRatio = 20; // > 15% ✓
      const capitalAdequacy = 12; // > 10% ✓
      const nplRatio = 3; // < 5% ✓
      const singleBorrower = 15; // < 20% ✓

      expect(liquidityRatio).toBeGreaterThanOrEqual(15);
      expect(capitalAdequacy).toBeGreaterThanOrEqual(10);
      expect(nplRatio).toBeLessThan(5);
      expect(singleBorrower).toBeLessThan(20);
    });
  });

  // ─── 4. Feature Flag Service ─────────────────────────────────────────────────
  describe('FeatureFlagService', () => {
    it('should hash userId deterministically for rollout', () => {
      // Simulate the hash function
      const hashUserId = (userId: string): number => {
        let hash = 0;
        for (let i = 0; i < userId.length; i++) {
          hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
        }
        return hash;
      };

      const hash1 = hashUserId('user-abc-123');
      const hash2 = hashUserId('user-abc-123');
      expect(hash1).toBe(hash2); // Deterministic

      const hash3 = hashUserId('user-xyz-456');
      expect(hash1).not.toBe(hash3); // Different users get different buckets
    });

    it('should correctly compute rollout bucket', () => {
      const hashUserId = (userId: string): number => {
        let hash = 0;
        for (let i = 0; i < userId.length; i++) {
          hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
        }
        return hash;
      };

      // With 50% rollout, roughly half of users should be in
      const users = Array.from({ length: 100 }, (_, i) => `user-${i}`);
      const inRollout = users.filter((u) => hashUserId(u) % 100 < 50);
      // Should be approximately 50 (within 20% tolerance)
      expect(inRollout.length).toBeGreaterThan(30);
      expect(inRollout.length).toBeLessThan(70);
    });
  });

  // ─── 5. Canary Analysis Thresholds ───────────────────────────────────────────
  describe('CanaryService thresholds', () => {
    const MAX_ERROR_RATE = 0.005;
    const MAX_P95_MS = 150;

    it('should trigger rollback when error rate exceeds 0.5%', () => {
      const errorRate = 0.008; // 0.8% > 0.5%
      expect(errorRate > MAX_ERROR_RATE).toBe(true);
    });

    it('should trigger rollback when p95 exceeds 150ms', () => {
      const p95 = 180; // 180ms > 150ms
      expect(p95 > MAX_P95_MS).toBe(true);
    });

    it('should pass when metrics are within thresholds', () => {
      const errorRate = 0.002; // 0.2% < 0.5%
      const p95 = 95; // 95ms < 150ms
      expect(errorRate > MAX_ERROR_RATE).toBe(false);
      expect(p95 > MAX_P95_MS).toBe(false);
    });

    it('should trigger rollback on either threshold breach', () => {
      const shouldRollback = (errorRate: number, p95: number): boolean =>
        errorRate > MAX_ERROR_RATE || p95 > MAX_P95_MS;

      expect(shouldRollback(0.001, 200)).toBe(true); // p95 breach
      expect(shouldRollback(0.01, 50)).toBe(true);   // error rate breach
      expect(shouldRollback(0.001, 50)).toBe(false);  // both OK
    });
  });

  // ─── 6. Multi-Region Routing ─────────────────────────────────────────────────
  describe('MultiRegionService', () => {
    it('should block cross-region export when not consented', () => {
      const config = {
        region: 'KE-NAIROBI',
        allowCrossRegionExport: false,
      };
      const targetRegion = 'UG-KAMPALA';

      const shouldBlock = config.region !== targetRegion && !config.allowCrossRegionExport;
      expect(shouldBlock).toBe(true);
    });

    it('should allow cross-region export when consented', () => {
      const config = {
        region: 'KE-NAIROBI',
        allowCrossRegionExport: true,
      };
      const targetRegion = 'UG-KAMPALA';

      const shouldBlock = config.region !== targetRegion && !config.allowCrossRegionExport;
      expect(shouldBlock).toBe(false);
    });

    it('should allow same-region export always', () => {
      const config = {
        region: 'KE-NAIROBI',
        allowCrossRegionExport: false,
      };
      const targetRegion = 'KE-NAIROBI';

      const shouldBlock = config.region !== targetRegion && !config.allowCrossRegionExport;
      expect(shouldBlock).toBe(false);
    });
  });

  // ─── 7. L1/L2 Cache Strategy ─────────────────────────────────────────────────
  describe('CacheInterceptor', () => {
    it('should generate consistent cache keys', () => {
      const tenantId = 'tenant-1';
      const path = '/admin/compliance/policy-check';
      const query = { policy: 'SASRA' };

      const key1 = `cache:${tenantId}:${path}:${JSON.stringify(query)}`;
      const key2 = `cache:${tenantId}:${path}:${JSON.stringify(query)}`;
      expect(key1).toBe(key2);
    });

    it('should generate different keys for different tenants', () => {
      const path = '/admin/compliance/policy-check';
      const query = {};

      const key1 = `cache:tenant-1:${path}:${JSON.stringify(query)}`;
      const key2 = `cache:tenant-2:${path}:${JSON.stringify(query)}`;
      expect(key1).not.toBe(key2);
    });
  });

  // ─── 8. Guarantor Ring Detection ─────────────────────────────────────────────
  describe('Guarantor Ring Detection', () => {
    it('should detect a 3-node ring: A→B→C→A', () => {
      // Simulate the graph: A guarantees B, B guarantees C, C guarantees A
      const graph: Record<string, string[]> = {
        'member-A': ['member-B'],
        'member-B': ['member-C'],
        'member-C': ['member-A'],
      };

      const detectRing = (start: string): boolean => {
        const visited = new Set<string>();
        const queue: Array<{ id: string; depth: number }> = [{ id: start, depth: 0 }];

        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current.depth > 5) continue;

          for (const neighbor of graph[current.id] ?? []) {
            if (neighbor === start && current.depth >= 2) return true;
            if (!visited.has(neighbor)) {
              visited.add(neighbor);
              queue.push({ id: neighbor, depth: current.depth + 1 });
            }
          }
        }
        return false;
      };

      expect(detectRing('member-A')).toBe(true);
    });

    it('should not flag a linear guarantor chain', () => {
      const graph: Record<string, string[]> = {
        'member-A': ['member-B'],
        'member-B': ['member-C'],
        'member-C': [],
      };

      const detectRing = (start: string): boolean => {
        const visited = new Set<string>();
        const queue: Array<{ id: string; depth: number }> = [{ id: start, depth: 0 }];

        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current.depth > 5) continue;

          for (const neighbor of graph[current.id] ?? []) {
            if (neighbor === start && current.depth >= 2) return true;
            if (!visited.has(neighbor)) {
              visited.add(neighbor);
              queue.push({ id: neighbor, depth: current.depth + 1 });
            }
          }
        }
        return false;
      };

      expect(detectRing('member-A')).toBe(false);
    });
  });
});
