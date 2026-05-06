import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../common/services/redis.service';
import { QUEUE_NAMES } from '../../queue/queue.constants';

const HEALTH_CACHE_TTL = 10; // seconds — avoid hammering services on every poll

// ─── Response types ───────────────────────────────────────────────────────────

export interface ServiceStatus {
  id: string;
  name: string;
  status: 'online' | 'degraded' | 'offline';
  latencyMs: number | null;
  uptime: number | null; // process uptime in seconds (null for external services)
  lastCheckedAt: string;
  details?: Record<string, unknown>;
}

export interface ErrorLogEntry {
  id: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  source: string;
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface BackgroundJobStatus {
  id: string;
  name: string;
  displayName: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  status: 'idle' | 'running' | 'failed';
}

export interface BlockedIPEntry {
  id: string;
  ipAddress: string;
  reason: string;
  blockedAt: string;
  expiresAt: string | null;
  isActive: boolean;
}

export interface FailedLoginEntry {
  username: string;
  ipAddress: string;
  attempts: number;
  lastAttemptAt: string;
}

// ─── Queue display config ─────────────────────────────────────────────────────

const MONITORED_QUEUES: Array<{ key: string; displayName: string }> = [
  { key: QUEUE_NAMES.EMAIL,               displayName: 'Email Notifications' },
  { key: QUEUE_NAMES.AUDIT_LOG,           displayName: 'Audit Log Writer' },
  { key: QUEUE_NAMES.LOAN_DISBURSE,       displayName: 'Loan Disbursement' },
  { key: QUEUE_NAMES.MPESA_CALLBACK,      displayName: 'M-Pesa Callback' },
  { key: QUEUE_NAMES.MPESA_DISBURSEMENT,  displayName: 'M-Pesa B2C Disbursement' },
  { key: QUEUE_NAMES.MPESA_CALLBACK_DLQ,  displayName: 'M-Pesa Callback DLQ' },
  { key: QUEUE_NAMES.INTEREST_ACCRUAL,    displayName: 'Interest Accrual (EOD)' },
  { key: QUEUE_NAMES.REPAYMENT_SCHEDULE,  displayName: 'Repayment Schedule' },
  { key: QUEUE_NAMES.LEDGER_INTEGRITY,    displayName: 'Ledger Integrity Check' },
  { key: QUEUE_NAMES.OUTBOUND_WEBHOOK,    displayName: 'Outbound Webhooks' },
];

// AuditLog actions that map to ERROR or higher severity
const ERROR_ACTION_PATTERNS = [
  'AUTH.LOGIN.FAILED',
  'AUTH.TOKEN.REUSE',
  'MPESA.CALLBACK.FAILED',
  'MPESA.DISBURSEMENT.FAILED',
  'LOAN.DISBURSE.FAILED',
  'WEBHOOK.DELIVERY.FAILED',
  'CRB.EXPORT.FAILED',
  'AML.SCREEN.FAILED',
  'LEDGER.INTEGRITY.FAIL',
];

const WARN_ACTION_PATTERNS = [
  'AUTH.REFRESH.REUSE',
  'MPESA.STK.TIMEOUT',
  'QUEUE.DLQ',
  'RATE_LIMIT',
  'SUSPICIOUS',
];

@Injectable()
export class AdminHealthService {
  private readonly logger = new Logger(AdminHealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    @InjectQueue(QUEUE_NAMES.EMAIL)               private readonly emailQueue: Queue,
    @InjectQueue(QUEUE_NAMES.AUDIT_LOG)           private readonly auditQueue: Queue,
    @InjectQueue(QUEUE_NAMES.LOAN_DISBURSE)       private readonly loanQueue: Queue,
    @InjectQueue(QUEUE_NAMES.MPESA_CALLBACK)      private readonly mpesaCallbackQueue: Queue,
    @InjectQueue(QUEUE_NAMES.MPESA_DISBURSEMENT)  private readonly mpesaDisbQueue: Queue,
    @InjectQueue(QUEUE_NAMES.MPESA_CALLBACK_DLQ)  private readonly mpesaDlqQueue: Queue,
    @InjectQueue(QUEUE_NAMES.INTEREST_ACCRUAL)    private readonly interestQueue: Queue,
    @InjectQueue(QUEUE_NAMES.REPAYMENT_SCHEDULE)  private readonly repaymentQueue: Queue,
    @InjectQueue(QUEUE_NAMES.LEDGER_INTEGRITY)    private readonly ledgerQueue: Queue,
    @InjectQueue(QUEUE_NAMES.OUTBOUND_WEBHOOK)    private readonly webhookQueue: Queue,
  ) {}

  // ─── Services Health ──────────────────────────────────────────────────────

  async getServicesHealth(): Promise<ServiceStatus[]> {
    const cacheKey = 'admin:health:services';
    const cached = await this.redis.getJson<ServiceStatus[]>(cacheKey);
    if (cached) return cached;

    const [db, redis, mpesa] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkMpesa(),
    ]);

    const services: ServiceStatus[] = [
      {
        id: 'core-banking',
        name: 'Core Banking API',
        status: 'online',
        latencyMs: null,
        uptime: Math.floor(process.uptime()),
        lastCheckedAt: new Date().toISOString(),
        details: { pid: process.pid, node: process.version },
      },
      db,
      redis,
      mpesa,
    ];

    await this.redis.setJson(cacheKey, services, HEALTH_CACHE_TTL);
    return services;
  }

  async testService(serviceId: string): Promise<ServiceStatus> {
    // Bypass cache for individual test
    switch (serviceId) {
      case 'database':
        return this.checkDatabase();
      case 'redis':
        return this.checkRedis();
      case 'mpesa':
        return this.checkMpesa();
      case 'core-banking':
        return {
          id: 'core-banking',
          name: 'Core Banking API',
          status: 'online',
          latencyMs: null,
          uptime: Math.floor(process.uptime()),
          lastCheckedAt: new Date().toISOString(),
          details: { pid: process.pid, node: process.version },
        };
      default:
        return {
          id: serviceId,
          name: serviceId,
          status: 'offline',
          latencyMs: null,
          uptime: null,
          lastCheckedAt: new Date().toISOString(),
          details: { error: 'Unknown service ID' },
        };
    }
  }

  private async checkDatabase(): Promise<ServiceStatus> {
    const start = Date.now();
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('DB ping timed out')), 5000),
        ),
      ]);
      const latencyMs = Date.now() - start;
      return {
        id: 'database',
        name: 'Database (PostgreSQL)',
        status: latencyMs > 1000 ? 'degraded' : 'online',
        latencyMs,
        uptime: null,
        lastCheckedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        id: 'database',
        name: 'Database (PostgreSQL)',
        status: 'offline',
        latencyMs: Date.now() - start,
        uptime: null,
        lastCheckedAt: new Date().toISOString(),
        details: { error: (err as Error).message },
      };
    }
  }

  private async checkRedis(): Promise<ServiceStatus> {
    const start = Date.now();
    try {
      const ok = await Promise.race([
        this.redis.ping(),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      const latencyMs = Date.now() - start;
      return {
        id: 'redis',
        name: 'Redis Cache (Upstash)',
        status: ok ? (latencyMs > 500 ? 'degraded' : 'online') : 'offline',
        latencyMs,
        uptime: null,
        lastCheckedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        id: 'redis',
        name: 'Redis Cache (Upstash)',
        status: 'offline',
        latencyMs: Date.now() - start,
        uptime: null,
        lastCheckedAt: new Date().toISOString(),
        details: { error: (err as Error).message },
      };
    }
  }

  private async checkMpesa(): Promise<ServiceStatus> {
    const start = Date.now();
    const mpesaEnv = this.config.get<string>('app.mpesa.environment', 'sandbox');
    const baseUrl =
      mpesaEnv === 'production'
        ? 'https://api.safaricom.co.ke'
        : 'https://sandbox.safaricom.co.ke';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'User-Agent': 'Beba-SACCO/1.0 health-check' },
      }).finally(() => clearTimeout(timeout));
      const latencyMs = Date.now() - start;
      // 401 is expected (no creds) — it means Daraja API is reachable
      const reachable = res.status < 500;
      return {
        id: 'mpesa',
        name: 'M-Pesa Gateway (Daraja)',
        status: reachable ? (latencyMs > 2000 ? 'degraded' : 'online') : 'degraded',
        latencyMs,
        uptime: null,
        lastCheckedAt: new Date().toISOString(),
        details: { environment: mpesaEnv, httpStatus: res.status },
      };
    } catch (err) {
      return {
        id: 'mpesa',
        name: 'M-Pesa Gateway (Daraja)',
        status: 'offline',
        latencyMs: Date.now() - start,
        uptime: null,
        lastCheckedAt: new Date().toISOString(),
        details: { error: (err as Error).message, environment: mpesaEnv },
      };
    }
  }

  // ─── Error Logs ───────────────────────────────────────────────────────────

  async getErrorLogs(opts: {
    level?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: ErrorLogEntry[]; total: number }> {
    const { level = 'all', page = 1, limit = 50 } = opts;
    const skip = (page - 1) * limit;

    // Build action pattern filter
    const errorPatterns = [...ERROR_ACTION_PATTERNS];
    const warnPatterns = [...WARN_ACTION_PATTERNS];

    let actionFilter: Record<string, unknown>;
    if (level === 'ERROR' || level === 'FATAL') {
      actionFilter = { action: { in: errorPatterns } };
    } else if (level === 'WARN') {
      actionFilter = { action: { in: warnPatterns } };
    } else if (level === 'INFO') {
      // INFO = everything NOT in error or warn lists
      actionFilter = {
        NOT: { action: { in: [...errorPatterns, ...warnPatterns] } },
      };
    } else {
      // 'all' — no filter
      actionFilter = {};
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { timestamp: { gte: sevenDaysAgo }, ...actionFilter },
        orderBy: { timestamp: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          action: true,
          entityType: true,
          metadata: true,
          ipAddress: true,
          timestamp: true,
        },
      }),
      this.prisma.auditLog.count({
        where: { timestamp: { gte: sevenDaysAgo }, ...actionFilter },
      }),
    ]);

    const data: ErrorLogEntry[] = rows.map((row) => {
      const meta = row.metadata as Record<string, unknown> | null;
      const derivedLevel = this.deriveLevel(row.action);
      const source = row.entityType ?? row.action.split('.')[0] ?? 'System';
      const message = this.deriveMessage(row.action, meta);

      return {
        id: row.id,
        level: derivedLevel,
        source,
        message,
        timestamp: row.timestamp.toISOString(),
        metadata: meta ?? undefined,
      };
    });

    return { data, total };
  }

  private deriveLevel(action: string): ErrorLogEntry['level'] {
    if (ERROR_ACTION_PATTERNS.some((p) => action.startsWith(p) || action === p)) return 'ERROR';
    if (WARN_ACTION_PATTERNS.some((p) => action.includes(p))) return 'WARN';
    if (action.includes('FAIL') || action.includes('ERROR') || action.includes('REJECT')) return 'ERROR';
    if (action.includes('WARN') || action.includes('LIMIT') || action.includes('TIMEOUT')) return 'WARN';
    return 'INFO';
  }

  private deriveMessage(action: string, meta: Record<string, unknown> | null): string {
    if (meta?.message && typeof meta.message === 'string') return meta.message;
    if (meta?.reason && typeof meta.reason === 'string') {
      return `${action}: ${meta.reason}`;
    }
    // Human-readable action label
    return action.replace(/\./g, ' › ').replace(/_/g, ' ').toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // ─── Background Jobs ──────────────────────────────────────────────────────

  async getBackgroundJobs(): Promise<BackgroundJobStatus[]> {
    const queues: Array<[Queue, string, string]> = [
      [this.emailQueue,         QUEUE_NAMES.EMAIL,              'Email Notifications'],
      [this.auditQueue,         QUEUE_NAMES.AUDIT_LOG,          'Audit Log Writer'],
      [this.loanQueue,          QUEUE_NAMES.LOAN_DISBURSE,      'Loan Disbursement'],
      [this.mpesaCallbackQueue, QUEUE_NAMES.MPESA_CALLBACK,     'M-Pesa Callback'],
      [this.mpesaDisbQueue,     QUEUE_NAMES.MPESA_DISBURSEMENT, 'M-Pesa B2C Disbursement'],
      [this.mpesaDlqQueue,      QUEUE_NAMES.MPESA_CALLBACK_DLQ, 'M-Pesa Callback DLQ'],
      [this.interestQueue,      QUEUE_NAMES.INTEREST_ACCRUAL,   'Interest Accrual (EOD)'],
      [this.repaymentQueue,     QUEUE_NAMES.REPAYMENT_SCHEDULE, 'Repayment Schedule'],
      [this.ledgerQueue,        QUEUE_NAMES.LEDGER_INTEGRITY,   'Ledger Integrity Check'],
      [this.webhookQueue,       QUEUE_NAMES.OUTBOUND_WEBHOOK,   'Outbound Webhooks'],
    ];

    const results = await Promise.allSettled(
      queues.map(async ([queue, key, displayName]) => {
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'completed',
          'failed',
          'delayed',
          'paused',
        );
        const status: BackgroundJobStatus['status'] =
          counts.active > 0 ? 'running' : counts.failed > 0 ? 'failed' : 'idle';
        return {
          id: key,
          name: key,
          displayName,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          completed: counts.completed ?? 0,
          failed: counts.failed ?? 0,
          delayed: counts.delayed ?? 0,
          status,
        } satisfies BackgroundJobStatus;
      }),
    );

    return results.map((r: PromiseSettledResult<BackgroundJobStatus>, i: number): BackgroundJobStatus => {
      if (r.status === 'fulfilled') return r.value;
      this.logger.warn(`Queue stats failed for ${queues[i][1]}: ${(r as PromiseRejectedResult).reason}`);
      return {
        id: queues[i][1],
        name: queues[i][1],
        displayName: queues[i][2],
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        status: 'idle' as const,
      };
    });
  }

  // ─── Blocked IPs ──────────────────────────────────────────────────────────

  async getBlockedIPs(opts: {
    page?: number;
    limit?: number;
  }): Promise<{ data: BlockedIPEntry[]; total: number }> {
    const { page = 1, limit = 50 } = opts;
    const skip = (page - 1) * limit;

    // Auto-expire: deactivate records where expiresAt has passed
    await this.prisma.blockedIP.updateMany({
      where: { expiresAt: { lt: new Date() }, isActive: true },
      data: { isActive: false },
    });

    const [rows, total] = await Promise.all([
      this.prisma.blockedIP.findMany({
        where: { isActive: true },
        orderBy: { blockedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.blockedIP.count({ where: { isActive: true } }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        ipAddress: r.ipAddress,
        reason: r.reason,
        blockedAt: r.blockedAt.toISOString(),
        expiresAt: r.expiresAt?.toISOString() ?? null,
        isActive: r.isActive,
      })),
      total,
    };
  }

  async unblockIP(id: string): Promise<void> {
    await this.prisma.blockedIP.update({
      where: { id },
      data: { isActive: false },
    });
  }

  // ─── Failed Logins ────────────────────────────────────────────────────────

  async getFailedLogins(): Promise<FailedLoginEntry[]> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    // Query AuditLog for AUTH.LOGIN.FAILED events in last hour
    const rows = await this.prisma.auditLog.findMany({
      where: {
        action: 'AUTH.LOGIN.FAILED',
        timestamp: { gte: oneHourAgo },
      },
      orderBy: { timestamp: 'desc' },
      take: 200,
      select: {
        metadata: true,
        ipAddress: true,
        timestamp: true,
      },
    });

    // Group by IP address + username
    const grouped = new Map<
      string,
      { username: string; ipAddress: string; attempts: number; lastAttemptAt: Date }
    >();

    for (const row of rows) {
      const meta = row.metadata as Record<string, unknown> | null;
      const username = (meta?.identifier as string | undefined) ?? 'unknown';
      const ip = row.ipAddress ?? 'unknown';
      const key = `${ip}::${username}`;

      const existing = grouped.get(key);
      if (existing) {
        existing.attempts += 1;
        if (row.timestamp > existing.lastAttemptAt) {
          existing.lastAttemptAt = row.timestamp;
        }
      } else {
        grouped.set(key, { username, ipAddress: ip, attempts: 1, lastAttemptAt: row.timestamp });
      }
    }

    return Array.from(grouped.values())
      .sort((a, b) => b.attempts - a.attempts)
      .map((entry) => ({
        username: entry.username,
        ipAddress: entry.ipAddress,
        attempts: entry.attempts,
        lastAttemptAt: entry.lastAttemptAt.toISOString(),
      }));
  }

}
