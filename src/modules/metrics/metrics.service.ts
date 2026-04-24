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
      registers: [this.registry],
    });

    this.mpesaStkPushSuccess = new client.Counter({
      name: 'beba_mpesa_stk_push_success_total',
      help: 'Total successful M-Pesa STK push callbacks',
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

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
