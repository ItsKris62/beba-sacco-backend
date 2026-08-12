import { Injectable, OnModuleInit } from '@nestjs/common';
import * as client from 'prom-client';

/**
 * Prometheus Metrics Service
 *
 * Registers:
 *   - Default Node.js metrics (event loop lag, memory, GC, CPU)
 *   - HTTP request duration histogram (labelled by method, route, status)
 *   - Custom business counters (loans disbursed, M-Pesa transactions, email queue depth)
 *
 * Usage: inject MetricsService and call the increment/observe helpers from
 * service methods that need instrumentation.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly registry: client.Registry;

  // ── HTTP ─────────────────────────────────────────────────────────
  readonly httpRequestDuration: client.Histogram<string>;

  // ── Business ─────────────────────────────────────────────────────
  readonly loansApplied: client.Counter<string>;
  readonly loansDisbursed: client.Counter<string>;
  readonly loansRepaid: client.Counter<string>;
  readonly mpesaStkPushTotal: client.Counter<string>;
  readonly mpesaStkPushSuccess: client.Counter<string>;
  readonly mpesaCallbackFailures: client.Counter<string>;
  readonly withdrawalsRequestedTotal: client.Counter<string>;
  readonly withdrawalsCompletedTotal: client.Counter<string>;
  readonly withdrawalsFailedTotal: client.Counter<string>;
  readonly withdrawalsReversedTotal: client.Counter<string>;
  readonly b2cProviderSendAttemptTotal: client.Counter<string>;
  readonly b2cProviderSendAmbiguousTotal: client.Counter<string>;
  readonly b2cReconciliationAttemptTotal: client.Counter<string>;
  readonly b2cReconciliationSuccessTotal: client.Counter<string>;
  readonly b2cReconciliationFailureTotal: client.Counter<string>;
  readonly b2cCallbackMismatchTotal: client.Counter<string>;
  readonly b2cStaleWithdrawalsCount: client.Gauge<string>;
  readonly b2cDeadLetterCount: client.Gauge<string>;
  readonly b2cOldestPendingAgeSeconds: client.Gauge<string>;
  readonly b2cReconOldestAgeSeconds: client.Gauge<string>;
  readonly emailQueueTotal: client.Counter<string>;

  constructor() {
    this.registry = new client.Registry();

    // Collect default Node.js process metrics
    client.collectDefaultMetrics({ register: this.registry, prefix: 'beba_' });

    this.httpRequestDuration = new client.Histogram({
      name: 'beba_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [this.registry],
    });

    this.loansApplied = new client.Counter({
      name: 'beba_loans_applied_total',
      help: 'Total loan applications submitted',
      labelNames: ['tenant_id'],
      registers: [this.registry],
    });

    this.loansDisbursed = new client.Counter({
      name: 'beba_loans_disbursed_total',
      help: 'Total loans disbursed',
      labelNames: ['tenant_id'],
      registers: [this.registry],
    });

    this.loansRepaid = new client.Counter({
      name: 'beba_loan_repayments_total',
      help: 'Total loan repayment transactions',
      labelNames: ['tenant_id'],
      registers: [this.registry],
    });

    this.mpesaStkPushTotal = new client.Counter({
      name: 'beba_mpesa_stk_push_total',
      help: 'Total M-Pesa STK push requests initiated',
      labelNames: ['tenant_id'],
      registers: [this.registry],
    });

    this.mpesaStkPushSuccess = new client.Counter({
      name: 'beba_mpesa_stk_push_success_total',
      help: 'Total successful M-Pesa STK push callbacks',
      labelNames: ['tenant_id'],
      registers: [this.registry],
    });

    this.mpesaCallbackFailures = new client.Counter({
      name: 'beba_mpesa_callback_failures_total',
      help: 'Total M-Pesa callback processing failures',
      labelNames: ['tenant_id', 'type'],
      registers: [this.registry],
    });

    this.withdrawalsRequestedTotal = new client.Counter({
      name: 'beba_withdrawals_requested_total',
      help: 'Total member FOSA-to-M-Pesa withdrawal requests accepted for processing',
      labelNames: ['tenant_id'],
      registers: [this.registry],
    });

    this.withdrawalsCompletedTotal = new client.Counter({
      name: 'beba_withdrawals_completed_total',
      help: 'Total member FOSA-to-M-Pesa withdrawals completed',
      labelNames: ['tenant_id', 'source'],
      registers: [this.registry],
    });

    this.withdrawalsFailedTotal = new client.Counter({
      name: 'beba_withdrawals_failed_total',
      help: 'Total member FOSA-to-M-Pesa withdrawals failed',
      labelNames: ['tenant_id', 'source', 'reason'],
      registers: [this.registry],
    });

    this.withdrawalsReversedTotal = new client.Counter({
      name: 'beba_withdrawals_reversed_total',
      help: 'Total member FOSA-to-M-Pesa withdrawals reversed through the ledger',
      labelNames: ['tenant_id', 'source'],
      registers: [this.registry],
    });

    this.b2cProviderSendAttemptTotal = new client.Counter({
      name: 'beba_b2c_provider_send_attempt_total',
      help: 'Total B2C provider send attempts',
      labelNames: ['tenant_id', 'provider'],
      registers: [this.registry],
    });

    this.b2cProviderSendAmbiguousTotal = new client.Counter({
      name: 'beba_b2c_provider_send_ambiguous_total',
      help: 'Total B2C provider send attempts with unknown outcome',
      labelNames: ['tenant_id', 'provider'],
      registers: [this.registry],
    });

    this.b2cReconciliationAttemptTotal = new client.Counter({
      name: 'beba_b2c_reconciliation_attempt_total',
      help: 'Total B2C withdrawal reconciliation attempts',
      labelNames: ['tenant_id', 'trigger', 'provider'],
      registers: [this.registry],
    });

    this.b2cReconciliationSuccessTotal = new client.Counter({
      name: 'beba_b2c_reconciliation_success_total',
      help: 'Total B2C withdrawal reconciliation attempts that resolved successfully',
      labelNames: ['tenant_id', 'outcome'],
      registers: [this.registry],
    });

    this.b2cReconciliationFailureTotal = new client.Counter({
      name: 'beba_b2c_reconciliation_failure_total',
      help: 'Total B2C withdrawal reconciliation attempts that failed or remained unresolved',
      labelNames: ['tenant_id', 'reason'],
      registers: [this.registry],
    });

    this.b2cCallbackMismatchTotal = new client.Counter({
      name: 'beba_b2c_callback_mismatch_total',
      help: 'Total B2C callbacks rejected into reconciliation due to correlation mismatch',
      labelNames: ['tenant_id', 'mismatch_type'],
      registers: [this.registry],
    });

    this.b2cStaleWithdrawalsCount = new client.Gauge({
      name: 'beba_b2c_stale_withdrawals_count',
      help: 'Current number of stale non-terminal B2C withdrawals detected by reconciliation',
      labelNames: ['tenant_id', 'state'],
      registers: [this.registry],
    });

    this.b2cDeadLetterCount = new client.Gauge({
      name: 'beba_b2c_dead_letter_count',
      help: 'Current number of B2C-related dead-letter items surfaced to operations',
      labelNames: ['tenant_id', 'queue'],
      registers: [this.registry],
    });

    this.b2cOldestPendingAgeSeconds = new client.Gauge({
      name: 'beba_b2c_oldest_pending_age_seconds',
      help: 'Age in seconds of the oldest non-terminal B2C withdrawal still pending provider result',
      labelNames: ['tenant_id'],
      registers: [this.registry],
    });

    this.b2cReconOldestAgeSeconds = new client.Gauge({
      name: 'beba_b2c_recon_oldest_age_seconds',
      help: 'Age in seconds of the oldest B2C withdrawal in reconciliation/manual review',
      labelNames: ['tenant_id'],
      registers: [this.registry],
    });

    this.emailQueueTotal = new client.Counter({
      name: 'beba_email_queue_total',
      help: 'Total emails enqueued',
      labelNames: ['type'],
      registers: [this.registry],
    });
  }

  onModuleInit() {
    // Registry is fully configured by constructor — nothing async needed here.
  }

  recordMpesaStkPush(tenantId: string): void {
    this.mpesaStkPushTotal.inc({ tenant_id: tenantId });
  }

  recordMpesaStkPushSuccess(tenantId: string): void {
    this.mpesaStkPushSuccess.inc({ tenant_id: tenantId });
  }

  recordMpesaCallbackFailure(tenantId: string | undefined, type: string | undefined): void {
    this.mpesaCallbackFailures.inc({
      tenant_id: tenantId || 'unresolved',
      type: this.normalizeCallbackType(type),
    });
  }

  recordWithdrawalRequested(tenantId: string): void {
    this.withdrawalsRequestedTotal.inc({ tenant_id: tenantId });
  }

  recordWithdrawalCompleted(tenantId: string, source: string): void {
    this.withdrawalsCompletedTotal.inc({ tenant_id: tenantId, source: this.safeLabel(source) });
  }

  recordWithdrawalFailed(tenantId: string, source: string, reason: string): void {
    this.withdrawalsFailedTotal.inc({
      tenant_id: tenantId,
      source: this.safeLabel(source),
      reason: this.safeLabel(reason),
    });
  }

  recordWithdrawalReversed(tenantId: string, source: string): void {
    this.withdrawalsReversedTotal.inc({ tenant_id: tenantId, source: this.safeLabel(source) });
  }

  recordB2cProviderSendAttempt(tenantId: string, provider: string): void {
    this.b2cProviderSendAttemptTotal.inc({
      tenant_id: tenantId,
      provider: this.safeLabel(provider),
    });
  }

  recordB2cProviderSendAmbiguous(tenantId: string, provider: string): void {
    this.b2cProviderSendAmbiguousTotal.inc({
      tenant_id: tenantId,
      provider: this.safeLabel(provider),
    });
  }

  recordB2cReconciliationAttempt(tenantId: string, trigger: string, provider = 'MWALONI'): void {
    this.b2cReconciliationAttemptTotal.inc({
      tenant_id: tenantId,
      trigger: this.safeLabel(trigger),
      provider: this.safeLabel(provider),
    });
  }

  recordB2cReconciliationSuccess(tenantId: string, outcome: string): void {
    this.b2cReconciliationSuccessTotal.inc({
      tenant_id: tenantId,
      outcome: this.safeLabel(outcome),
    });
  }

  recordB2cReconciliationFailure(tenantId: string, reason: string): void {
    this.b2cReconciliationFailureTotal.inc({
      tenant_id: tenantId,
      reason: this.safeLabel(reason),
    });
  }

  recordB2cCallbackMismatch(tenantId: string, mismatchType: string): void {
    this.b2cCallbackMismatchTotal.inc({
      tenant_id: tenantId,
      mismatch_type: this.safeLabel(mismatchType),
    });
  }

  setB2cStaleWithdrawals(tenantId: string, state: string, count: number): void {
    this.b2cStaleWithdrawalsCount.set({ tenant_id: tenantId, state: this.safeLabel(state) }, count);
  }

  setB2cDeadLetterCount(tenantId: string, queue: string, count: number): void {
    this.b2cDeadLetterCount.set({ tenant_id: tenantId, queue: this.safeLabel(queue) }, count);
  }

  setB2cOldestPendingAgeSeconds(tenantId: string, seconds: number): void {
    this.b2cOldestPendingAgeSeconds.set({ tenant_id: tenantId }, Math.max(0, seconds));
  }

  setB2cReconOldestAgeSeconds(tenantId: string, seconds: number): void {
    this.b2cReconOldestAgeSeconds.set({ tenant_id: tenantId }, Math.max(0, seconds));
  }

  private normalizeCallbackType(type: string | undefined): string {
    switch (type) {
      case 'STK_PUSH':
        return 'stk_push';
      case 'C2B':
        return 'c2b';
      case 'B2C_RESULT':
        return 'b2c';
      case 'B2C_TIMEOUT':
        return 'b2c_timeout';
      default:
        return 'unknown';
    }
  }

  private safeLabel(value: string | undefined): string {
    return String(value || 'unknown')
      .toLowerCase()
      .replace(/[^a-z0-9_:-]+/g, '_')
      .slice(0, 80);
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
