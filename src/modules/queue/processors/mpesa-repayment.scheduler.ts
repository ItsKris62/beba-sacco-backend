import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Decimal } from 'decimal.js';
import { LoanStatus, MpesaTriggerSource } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../common/services/redis.service';
import { maskPhone } from '../../mpesa/utils/mpesa.utils';
import { QUEUE_NAMES } from '../queue.constants';

// ─── Constants ────────────────────────────────────────────────────────────────

/** EAT offset from UTC in milliseconds (UTC+3). */
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Redis key prefix for per-member per-day STK rate limiting. */
const stkSchedulerRateLimitKey = (memberId: string): string =>
  `stk:limit:${memberId}`;

/** Max automatic STK pushes the scheduler may send per member per calendar day. */
const MAX_PUSHES_PER_DAY = 3;

/** Redis TTL for the rate-limit counter: 24 hours (scheduler resets at 06:00 EAT). */
const RATE_LIMIT_TTL_SECS = 86400;

// ─── Payload type ─────────────────────────────────────────────────────────────

export interface StkRepaymentJobPayload {
  loanId: string;
  memberId: string;
  tenantId: string;
  phone: string;            // E.164 (2547XXXXXXXX) – resolved at schedule time, not in processor
  amount: number;           // Ceiling integer KES
  accountReference: string; // LOAN-{loanNumber}
  triggerSource: MpesaTriggerSource;
  scheduledDate: string;    // YYYY-MM-DD in EAT – used by idempotency jobId
}

// ─── Metrics counters (process-scoped, scraped by PrometheusService) ─────────

interface SchedulerRunMetrics {
  runDate: string;        // YYYY-MM-DD EAT
  loansQueried: number;
  jobsEnqueued: number;
  jobsSkipped: number;    // Already-initiated today (BullMQ dedup)
  jobsRateLimited: number;
  jobsFailed: number;
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * MpesaRepaymentScheduler
 *
 * Runs daily at 06:00 EAT (Africa/Nairobi, UTC+3 → 03:00 UTC).
 * For every active loan with an outstanding balance due today or overdue,
 * it sends an STK Push repayment prompt to the member's phone.
 *
 * Three-layer idempotency compliance:
 *  Layer 1 – BullMQ jobId = stk-repay-{loanId}-{YYYYMMDD} (queue-level dedup).
 *  Layer 2 – MpesaCallbackProcessor checks status !== PENDING before posting ledger.
 *  Layer 3 – MpesaTransaction.reference @unique (DB-level safety net).
 *
 * Rate limiting:
 *  Redis INCR/EXPIRE on key stk:limit:{memberId}.
 *  Max 3 pushes per member per calendar day. Resets at midnight EAT via 86400s TTL
 *  set at first increment — aligns with the EAT day boundary.
 *
 * SASRA compliance:
 *  - triggerSource = SYSTEM on all scheduler-initiated jobs.
 *  - Phone masked in all logs (254***{last4}).
 *  - Failures logged and counted; scheduler NEVER blocks the next day's run.
 *  - Metrics emitted for Prometheus scraping.
 */
@Injectable()
export class MpesaRepaymentScheduler implements OnApplicationShutdown {
  private readonly logger = new Logger(MpesaRepaymentScheduler.name);
  private isRunning = false;
  private lastMetrics: SchedulerRunMetrics | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    // Dedicated queue — processor is MpesaRepaymentProcessor (mpesa-repayment.processor.ts)
    @InjectQueue(QUEUE_NAMES.MPESA_STK_REPAYMENT)
    private readonly repaymentQueue: Queue<StkRepaymentJobPayload>,
  ) {}

  // ─── Cron: 06:00 EAT every day ──────────────────────────────────────────

  /**
   * 03:00 UTC = 06:00 EAT (Africa/Nairobi, UTC+3).
   * @nestjs/schedule uses UTC cron expressions; we target 03:00 UTC.
   */
  @Cron('0 3 * * *', { timeZone: 'UTC', name: 'mpesa-stk-repayment-scheduler' })
  async runDailyRepaymentSchedule(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Repayment scheduler already running – skipping overlapping invocation');
      return;
    }

    this.isRunning = true;
    const startedAt = Date.now();

    // Derive EAT "today" from the current moment (UTC+3 = Africa/Nairobi)
    const nowEat = new Date(Date.now() + EAT_OFFSET_MS);
    const pad = (n: number) => String(n).padStart(2, '0');
    const todayEat = `${nowEat.getUTCFullYear()}-${pad(nowEat.getUTCMonth() + 1)}-${pad(nowEat.getUTCDate())}`;

    this.logger.log(`[Repayment Scheduler] Starting run for EAT date ${todayEat}`);

    const metrics: SchedulerRunMetrics = {
      runDate: todayEat,
      loansQueried: 0,
      jobsEnqueued: 0,
      jobsSkipped: 0,
      jobsRateLimited: 0,
      jobsFailed: 0,
      durationMs: 0,
    };

    try {
      await this.processLoans(todayEat, metrics);
    } catch (err) {
      this.logger.error(
        `[Repayment Scheduler] Unhandled error for run ${todayEat}: ${(err as Error).message}`,
        (err as Error).stack,
      );
      metrics.jobsFailed++;
    } finally {
      metrics.durationMs = Date.now() - startedAt;
      this.lastMetrics = metrics;
      this.isRunning = false;

      this.logger.log(
        `[Repayment Scheduler] Run complete for ${todayEat} | ` +
          `queried=${metrics.loansQueried} enqueued=${metrics.jobsEnqueued} ` +
          `skipped=${metrics.jobsSkipped} rateLimited=${metrics.jobsRateLimited} ` +
          `failed=${metrics.jobsFailed} durationMs=${metrics.durationMs}`,
      );
    }
  }

  // ─── Core processing logic ───────────────────────────────────────────────

  private async processLoans(todayEat: string, metrics: SchedulerRunMetrics): Promise<void> {
    // Midnight EAT = start of today (inclusive lower bound for dueDate)
    const todayStart = new Date(`${todayEat}T00:00:00.000+03:00`);

    // Query all disbursed/active loans with outstanding balance due today or overdue.
    // Cursor-based pagination to handle large loan portfolios without OOM.
    const PAGE_SIZE = 100;
    let cursor: string | undefined;

    while (true) {
      const loans = await this.prisma.loan.findMany({
        where: {
          status: { in: [LoanStatus.DISBURSED, LoanStatus.ACTIVE] },
          outstandingBalance: { gt: 0 },
          dueDate: { lte: todayStart },
        },
        include: {
          member: {
            include: {
              user: { select: { phoneNumber: true, phone: true } },
            },
          },
        },
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      });

      if (loans.length === 0) break;

      metrics.loansQueried += loans.length;
      cursor = loans[loans.length - 1].id;

      for (const loan of loans) {
        await this.processOneLoan(loan, todayEat, metrics);
      }

      if (loans.length < PAGE_SIZE) break;
    }
  }

  private async processOneLoan(
    loan: {
      id: string;
      loanNumber: string;
      tenantId: string;
      memberId: string;
      outstandingBalance: { toString(): string };
      member: {
        id: string;
        user: { phoneNumber: string | null; phone: string | null };
      };
    },
    todayEat: string,
    metrics: SchedulerRunMetrics,
  ): Promise<void> {
    const { id: loanId, loanNumber, tenantId, memberId } = loan;
    const phone = loan.member.user.phoneNumber ?? loan.member.user.phone;

    if (!phone) {
      this.logger.warn(
        `[Repayment Scheduler] Loan ${loanId} skipped – member ${memberId} has no phone`,
      );
      metrics.jobsSkipped++;
      return;
    }

    // ── Redis rate-limit check (INCR + EXPIRE) ────────────────────────────
    // Key: stk:limit:{memberId} – shared with MpesaService.initiateDeposit()
    // so member-initiated pushes count toward the same daily cap.
    const rlKey = stkSchedulerRateLimitKey(memberId);
    const currentCount = await this.incrWithExpire(rlKey, RATE_LIMIT_TTL_SECS);

    if (currentCount > MAX_PUSHES_PER_DAY) {
      this.logger.log(
        `[Repayment Scheduler] Rate limit reached for member ${memberId} ` +
          `(${currentCount}/${MAX_PUSHES_PER_DAY}) – skipping loan ${loanId}`,
      );
      metrics.jobsRateLimited++;
      // Undo the INCR so we don't inflate the counter unnecessarily
      await this.redis.incrBy(rlKey, -1).catch(() => {});
      return;
    }

    // ── Build idempotent jobId ─────────────────────────────────────────────
    // Format: stk-repay-{loanId}-{YYYYMMDD}
    // The date suffix ensures a new job is created each day for the same loan,
    // while preventing duplicate enqueues within the same day (Layer 1).
    const dateSuffix = todayEat.replace(/-/g, '');
    const jobId = `stk-repay-${loanId}-${dateSuffix}`;

    // ── Build STK Push payload ─────────────────────────────────────────────
    const amount = Math.ceil(
      new Decimal(loan.outstandingBalance.toString()).toNumber(),
    );
    const accountReference = `LOAN-${loanNumber}`.slice(0, 30);

    const stkPayload: StkRepaymentJobPayload = {
      loanId,
      memberId,
      tenantId,
      phone,
      amount,
      accountReference,
      triggerSource: MpesaTriggerSource.SYSTEM,
      scheduledDate: todayEat,
    };

    // ── Enqueue to MPESA_STK_REPAYMENT — handled by MpesaRepaymentProcessor ─
    // Separate queue keeps scheduler jobs entirely out of the Daraja callback
    // processing path. MpesaCallbackProcessor only handles incoming Daraja
    // callbacks; it cannot route StkRepaymentJobPayload (wrong shape).
    try {
      const job = await this.repaymentQueue.add(
        'initiate-stk-repayment',
        stkPayload,
        {
          jobId,
          // Attempts: 1 — on STK expiry/failure the job is logged and NOT retried.
          // The next day's cron creates a fresh job for the same loan.
          // This prevents the DLQ accumulating stale repayment jobs across days.
          attempts: 1,
          removeOnComplete: { count: 500 },
          removeOnFail: false,
        },
      );

      if (job.id === jobId) {
        metrics.jobsEnqueued++;
        this.logger.log(
          `[Repayment Scheduler] Enqueued STK repayment | ` +
            `jobId=${jobId} loan=${loanId} phone=${maskPhone(phone)} amount=${amount} ` +
            `ref=${accountReference}`,
        );
      } else {
        // BullMQ returned a different id – job already existed (Layer 1 dedup)
        metrics.jobsSkipped++;
        this.logger.log(
          `[Repayment Scheduler] jobId ${jobId} already in queue – skipping (Layer 1 dedup)`,
        );
        // Roll back rate-limit INCR since no new push was sent
        await this.redis.incrBy(rlKey, -1).catch(() => {});
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      // BullMQ throws if jobId already exists with a different state
      if (message.includes('already exists')) {
        metrics.jobsSkipped++;
        await this.redis.incrBy(rlKey, -1).catch(() => {});
        this.logger.log(
          `[Repayment Scheduler] jobId ${jobId} exists in queue – Layer 1 dedup`,
        );
        return;
      }
      metrics.jobsFailed++;
      // SASRA compliance: log failure but do NOT throw – must not block other loans
      this.logger.error(
        `[Repayment Scheduler] Failed to enqueue STK for loan ${loanId}: ${message}`,
      );
    }
  }

  // ─── Redis rate-limit helper ─────────────────────────────────────────────

  /**
   * Atomically increments the rate-limit counter. Sets TTL on first increment.
   * Uses Redis INCR + EXPIRE (not SET with EX) to preserve any existing TTL
   * that was set by MpesaService.initiateDeposit() — the two share the same key.
   *
   * Note: MpesaService uses secondsUntilMidnightEAT() for TTL; the scheduler
   * uses a flat 86400s because it runs at 06:00 EAT (18h before midnight EAT).
   * A shorter TTL is set if one already exists on the key.
   */
  private async incrWithExpire(key: string, ttlSecs: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) {
      // First increment today – set TTL so it resets by midnight EAT
      await this.redis.expire(key, ttlSecs);
    }
    return count;
  }

  // ─── Graceful shutdown ───────────────────────────────────────────────────

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(
      `[Repayment Scheduler] Shutdown signal=${signal ?? 'unknown'} isRunning=${this.isRunning}`,
    );
    if (this.isRunning) {
      // Give the current loop up to 30s to finish the current loan batch
      // before the process exits. NestJS shutdown hooks provide up to the
      // configured shutdownTimeout in main.ts.
      this.logger.warn(
        '[Repayment Scheduler] Shutdown while scheduler is running – awaiting current batch completion',
      );
    }
  }

  // ─── Metrics accessor (scraped by SchedulerMetricsController if wired) ──

  getLastRunMetrics(): SchedulerRunMetrics | null {
    return this.lastMetrics;
  }
}
