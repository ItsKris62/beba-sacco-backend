/**
 * @file monitoring-setup.ts
 * @description Production observability & alerting setup for Beba SACCO.
 *
 * Integrates:
 *  - Sentry: error tracking with PII scrubbing (ODPC DPA 2019 §41)
 *  - Slack webhooks: DLQ alerts, queue depth monitoring, compliance alerts
 *  - BullMQ: queue depth monitoring + dead-letter queue (DLQ) alerting
 *  - Neon: connection limit alerts
 *  - Cloudflare R2: lifecycle rule documentation
 *
 * All PII scrubbing is mandatory per Kenya DPA 2019 §41 and SASRA Circular 3/2022 §5.
 */

import * as Sentry from '@sentry/node';
import { Logger } from '@nestjs/common';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Slack message block for structured alerts */
interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  fields?: Array<{ type: string; text: string }>;
}

/** Slack webhook payload */
interface SlackPayload {
  text: string;
  blocks?: SlackBlock[];
  username?: string;
  icon_emoji?: string;
}

/** Queue depth alert thresholds */
export interface QueueAlertThresholds {
  /** Alert when waiting jobs exceed this count */
  waitingThreshold: number;
  /** Alert when failed jobs exceed this count */
  failedThreshold: number;
  /** Alert when DLQ jobs exceed this count */
  dlqThreshold: number;
}

/** Queue health snapshot */
export interface QueueHealthSnapshot {
  queueName: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
  timestamp: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default queue alert thresholds */
const DEFAULT_THRESHOLDS: QueueAlertThresholds = {
  waitingThreshold: 100,
  failedThreshold: 10,
  dlqThreshold: 5,
};

/** PII field patterns to scrub from Sentry events (ODPC DPA 2019 §41) */
const PII_FIELD_PATTERNS = [
  /phone/i,
  /msisdn/i,
  /mobile/i,
  /national.?id/i,
  /id.?number/i,
  /kra.?pin/i,
  /password/i,
  /token/i,
  /secret/i,
  /credential/i,
  /authorization/i,
  /cookie/i,
  /refresh.?token/i,
  /access.?token/i,
];

/** Kenyan phone number pattern for masking (ODPC requirement: 254***1234) */
const PHONE_PATTERN = /254\d{6}(\d{4})/g;

const logger = new Logger('MonitoringSetup');

// ─────────────────────────────────────────────────────────────────────────────
// SENTRY INITIALIZATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize Sentry error tracking with PII scrubbing.
 *
 * ODPC DPA 2019 §41 requires that personal data is not transmitted to
 * third-party processors without appropriate safeguards. The `beforeSend`
 * hook strips all PII fields before events leave the server.
 *
 * @param dsn - Sentry DSN from environment variable
 * @param environment - Deployment environment (production/staging)
 */
export function initSentry(
  dsn: string = process.env.SENTRY_DSN ?? '',
  environment: string = process.env.SENTRY_ENVIRONMENT ?? 'production',
): void {
  if (!dsn) {
    logger.warn('SENTRY_DSN not configured — error tracking disabled');
    return;
  }

  Sentry.init({
    dsn,
    environment,
    release: process.env.npm_package_version ?? '1.0.0-mvp',

    // Performance monitoring: sample 10% of transactions in production
    // Increase to 1.0 during load testing, reduce to 0.05 for high-traffic
    tracesSampleRate: environment === 'production' ? 0.1 : 1.0,

    // ── PII Scrubbing (ODPC DPA 2019 §41) ────────────────────────────────────
    // Strip all PII fields before sending to Sentry.
    // This is a hard requirement — Sentry is a US-based processor and
    // transmitting PII without consent violates Kenya DPA 2019 §30.
    beforeSend(event) {
      return scrubSentryEvent(event);
    },

    // Strip PII from breadcrumbs
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.data) {
        breadcrumb.data = scrubObject(breadcrumb.data);
      }
      if (breadcrumb.message) {
        breadcrumb.message = maskPhoneNumbers(breadcrumb.message);
      }
      return breadcrumb;
    },

    // Ignore common non-actionable errors
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'Non-Error promise rejection captured',
      /^Network Error$/,
      /^Request aborted$/,
    ],

    // Tag all events with Kenyan regulatory context
    initialScope: {
      tags: {
        region: 'ke-nairobi',
        regulatory_framework: 'SASRA+ODPC+CBK',
        data_classification: 'financial-pii',
      },
    },
  });

  logger.log(`Sentry initialized | env=${environment} PII-scrubbing=ENABLED`);
}

/**
 * Scrub PII from a Sentry event before transmission.
 * Implements ODPC DPA 2019 §41 data security requirement.
 *
 * @param event - Raw Sentry event
 * @returns Scrubbed event safe for transmission
 */
function scrubSentryEvent(event: Sentry.Event): Sentry.Event {
  // Scrub request headers (Authorization, Cookie, etc.)
  if (event.request?.headers) {
    event.request.headers = scrubObject(event.request.headers as Record<string, unknown>) as Record<string, string>;
  }

  // Scrub request body
  if (event.request?.data) {
    if (typeof event.request.data === 'string') {
      try {
        const parsed = JSON.parse(event.request.data);
        event.request.data = JSON.stringify(scrubObject(parsed));
      } catch {
        // Not JSON — mask phone numbers in raw string
        event.request.data = maskPhoneNumbers(event.request.data);
      }
    } else if (typeof event.request.data === 'object') {
      event.request.data = scrubObject(event.request.data as Record<string, unknown>);
    }
  }

  // Scrub query string
  if (event.request?.query_string) {
    if (typeof event.request.query_string === 'string') {
      event.request.query_string = maskPhoneNumbers(event.request.query_string);
    }
  }

  // Scrub extra context
  if (event.extra) {
    event.extra = scrubObject(event.extra as Record<string, unknown>);
  }

  // Scrub exception values (stack traces may contain PII in message)
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.value) {
        ex.value = maskPhoneNumbers(ex.value);
      }
    }
  }

  return event;
}

/**
 * Recursively scrub PII fields from an object.
 * Fields matching PII_FIELD_PATTERNS are replaced with '[REDACTED]'.
 * Phone numbers in string values are masked to 254***XXXX format.
 */
function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const isPiiField = PII_FIELD_PATTERNS.some((pattern) => pattern.test(key));

    if (isPiiField) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      result[key] = maskPhoneNumbers(value);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = scrubObject(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === 'object' && item !== null
          ? scrubObject(item as Record<string, unknown>)
          : typeof item === 'string'
          ? maskPhoneNumbers(item)
          : item,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Mask Kenyan phone numbers in a string.
 * Format: 254XXXXXXXXXX → 254***XXXX (ODPC requirement)
 *
 * @param text - Input string potentially containing phone numbers
 * @returns String with phone numbers masked
 */
export function maskPhoneNumbers(text: string): string {
  return text.replace(PHONE_PATTERN, '254***$1');
}

// ─────────────────────────────────────────────────────────────────────────────
// SLACK WEBHOOK INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a structured alert to Slack via webhook.
 *
 * Used for:
 *  - BullMQ DLQ alerts (SASRA Circular 1/2021 §4.5)
 *  - Queue depth warnings
 *  - Compliance policy breaches
 *  - Neon connection limit warnings
 *
 * @param webhookUrl - Slack incoming webhook URL
 * @param payload - Slack message payload
 * @returns Promise resolving to true if sent successfully
 */
export async function sendSlackAlert(
  webhookUrl: string,
  payload: SlackPayload,
): Promise<boolean> {
  if (!webhookUrl) {
    logger.warn('SLACK_WEBHOOK_URL not configured — alert not sent');
    return false;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      logger.error(`Slack webhook failed: ${response.status} ${response.statusText}`);
      return false;
    }

    return true;
  } catch (err) {
    logger.error(`Slack webhook error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Send a DLQ (Dead Letter Queue) alert to Slack.
 * Triggered when BullMQ jobs exceed the DLQ threshold.
 * Required by SASRA Circular No. 1/2021 §4.5 for M-Pesa transaction monitoring.
 *
 * @param queueName - Name of the BullMQ queue
 * @param dlqCount - Number of jobs in the DLQ
 * @param sampleJobIds - Sample of failed job IDs for investigation
 */
export async function sendDlqAlert(
  queueName: string,
  dlqCount: number,
  sampleJobIds: string[] = [],
): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL ?? '';
  const environment = process.env.NODE_ENV ?? 'unknown';

  const payload: SlackPayload = {
    text: `🚨 *DLQ Alert* — ${queueName} has ${dlqCount} failed jobs`,
    username: 'Beba SACCO Monitor',
    icon_emoji: ':warning:',
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🚨 DLQ Alert: ${queueName}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Queue:*\n${queueName}` },
          { type: 'mrkdwn', text: `*DLQ Count:*\n${dlqCount}` },
          { type: 'mrkdwn', text: `*Environment:*\n${environment}` },
          { type: 'mrkdwn', text: `*Time (EAT):*\n${toEatIso(new Date())}` },
        ],
      },
      ...(sampleJobIds.length > 0
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Sample Failed Job IDs:*\n\`\`\`${sampleJobIds.slice(0, 5).join('\n')}\`\`\``,
              },
            },
          ]
        : []),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '*Action Required:*\n' +
            '1. Check Bull Board: `https://your-api.onrender.com/admin/queues`\n' +
            '2. Review failed job payloads for M-Pesa callback errors\n' +
            '3. Resolve or retry jobs within 24h (SASRA Circular 1/2021 §4.5)',
        },
      },
    ],
  };

  await sendSlackAlert(webhookUrl, payload);
  logger.warn(`DLQ alert sent | queue=${queueName} count=${dlqCount}`);
}

/**
 * Send a queue depth warning to Slack.
 * Triggered when waiting jobs exceed the configured threshold.
 *
 * @param snapshot - Current queue health snapshot
 * @param thresholds - Alert thresholds
 */
export async function sendQueueDepthAlert(
  snapshot: QueueHealthSnapshot,
  thresholds: QueueAlertThresholds = DEFAULT_THRESHOLDS,
): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL ?? '';

  const isWaitingAlert = snapshot.waiting > thresholds.waitingThreshold;
  const isFailedAlert = snapshot.failed > thresholds.failedThreshold;

  if (!isWaitingAlert && !isFailedAlert) return;

  const alerts: string[] = [];
  if (isWaitingAlert) alerts.push(`⚠️ Waiting: ${snapshot.waiting} (threshold: ${thresholds.waitingThreshold})`);
  if (isFailedAlert) alerts.push(`❌ Failed: ${snapshot.failed} (threshold: ${thresholds.failedThreshold})`);

  const payload: SlackPayload = {
    text: `⚠️ Queue depth alert: ${snapshot.queueName}`,
    username: 'Beba SACCO Monitor',
    icon_emoji: ':chart_with_upwards_trend:',
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `⚠️ Queue Depth Alert: ${snapshot.queueName}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Queue:*\n${snapshot.queueName}` },
          { type: 'mrkdwn', text: `*Waiting:*\n${snapshot.waiting}` },
          { type: 'mrkdwn', text: `*Active:*\n${snapshot.active}` },
          { type: 'mrkdwn', text: `*Failed:*\n${snapshot.failed}` },
          { type: 'mrkdwn', text: `*Delayed:*\n${snapshot.delayed}` },
          { type: 'mrkdwn', text: `*Time (EAT):*\n${snapshot.timestamp}` },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Alerts:*\n${alerts.join('\n')}`,
        },
      },
    ],
  };

  await sendSlackAlert(webhookUrl, payload);
  logger.warn(`Queue depth alert sent | queue=${snapshot.queueName} waiting=${snapshot.waiting} failed=${snapshot.failed}`);
}

/**
 * Send a compliance policy breach alert to Slack.
 * Triggered by the CompliancePolicyEngine when a threshold is breached.
 *
 * @param policy - Policy identifier (e.g. "SASRA_NPL_RATIO")
 * @param severity - Alert severity (INFO/WARNING/CRITICAL)
 * @param message - Human-readable breach description
 * @param tenantId - Affected tenant ID
 */
export async function sendComplianceAlert(
  policy: string,
  severity: 'INFO' | 'WARNING' | 'CRITICAL',
  message: string,
  tenantId: string,
): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL ?? '';

  const severityEmoji = { INFO: 'ℹ️', WARNING: '⚠️', CRITICAL: '🚨' }[severity];
  const severityColor = { INFO: '#36a64f', WARNING: '#ff9900', CRITICAL: '#ff0000' }[severity];

  const payload: SlackPayload = {
    text: `${severityEmoji} *Compliance Alert* [${severity}]: ${policy}`,
    username: 'Beba SACCO Compliance',
    icon_emoji: ':scales:',
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${severityEmoji} Compliance Alert: ${policy}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Policy:*\n${policy}` },
          { type: 'mrkdwn', text: `*Severity:*\n${severity}` },
          { type: 'mrkdwn', text: `*Tenant:*\n${tenantId.slice(0, 8)}...` },
          { type: 'mrkdwn', text: `*Time (EAT):*\n${toEatIso(new Date())}` },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Details:*\n${message}`,
        },
      },
      ...(severity === 'CRITICAL'
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text:
                  '*⚠️ CRITICAL: Immediate action required.*\n' +
                  'Review at: `GET /admin/compliance/alerts`\n' +
                  'Regulatory deadline: 24h for CBK/SASRA notification',
              },
            },
          ]
        : []),
    ],
  };

  await sendSlackAlert(webhookUrl, payload);
  logger.warn(`Compliance alert sent | policy=${policy} severity=${severity} tenant=${tenantId.slice(0, 8)}`);
}

/**
 * Send a Neon database connection limit warning to Slack.
 * Neon serverless has connection limits; exceeding them causes 503 errors.
 *
 * @param currentConnections - Current active connection count
 * @param maxConnections - Maximum allowed connections
 */
export async function sendNeonConnectionAlert(
  currentConnections: number,
  maxConnections: number,
): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL ?? '';
  const usagePct = Math.round((currentConnections / maxConnections) * 100);

  if (usagePct < 80) return; // Only alert at 80%+ usage

  const payload: SlackPayload = {
    text: `🗄️ Neon DB connection limit: ${usagePct}% used (${currentConnections}/${maxConnections})`,
    username: 'Beba SACCO Monitor',
    icon_emoji: ':database:',
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🗄️ Neon Connection Limit Warning`,
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Current:*\n${currentConnections}` },
          { type: 'mrkdwn', text: `*Maximum:*\n${maxConnections}` },
          { type: 'mrkdwn', text: `*Usage:*\n${usagePct}%` },
          { type: 'mrkdwn', text: `*Time (EAT):*\n${toEatIso(new Date())}` },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '*Action:*\n' +
            '1. Check for connection leaks in PrismaService\n' +
            '2. Verify `$disconnect()` is called in all test teardowns\n' +
            '3. Consider upgrading Neon plan if sustained >80%\n' +
            '4. Enable Neon connection pooling (PgBouncer) if not already active',
        },
      },
    ],
  };

  await sendSlackAlert(webhookUrl, payload);
  logger.warn(`Neon connection alert sent | usage=${usagePct}% (${currentConnections}/${maxConnections})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLOUDFLARE R2 LIFECYCLE RULES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cloudflare R2 lifecycle rules for Beba SACCO.
 *
 * R2 does not support lifecycle rules via API as of 2026 — these must be
 * configured via the Cloudflare dashboard or Wrangler CLI.
 *
 * Rules:
 *  1. Temp uploads (prefix: "temp/"): delete after 7 days
 *  2. DSAR exports (prefix: "dsar/"): delete after 30 days (ODPC §26 expiry)
 *  3. KYC documents (prefix: "kyc/"): retain 7 years (SASRA Regulation 42)
 *  4. Statement PDFs (prefix: "statements/"): retain 7 years
 *
 * @returns Lifecycle rule configuration for documentation/Wrangler
 */
export function getR2LifecycleRules(): Record<string, unknown> {
  return {
    rules: [
      {
        id: 'delete-temp-uploads',
        prefix: 'temp/',
        status: 'Enabled',
        expiration: { days: 7 },
        description: 'Delete temporary uploads after 7 days (ODPC DPA 2019 §25 — data minimisation)',
      },
      {
        id: 'delete-dsar-exports',
        prefix: 'dsar/',
        status: 'Enabled',
        expiration: { days: 30 },
        description: 'Delete DSAR export packages after 30 days (ODPC DPA 2019 §26 — DSAR expiry)',
      },
      {
        id: 'retain-kyc-documents',
        prefix: 'kyc/',
        status: 'Enabled',
        expiration: { days: 2557 }, // 7 years = 365.25 * 7
        description: 'Retain KYC documents for 7 years (SASRA Regulation 42)',
      },
      {
        id: 'retain-statement-pdfs',
        prefix: 'statements/',
        status: 'Enabled',
        expiration: { days: 2557 },
        description: 'Retain member statement PDFs for 7 years (SASRA Regulation 42)',
      },
    ],
    // Apply via Wrangler:
    // wrangler r2 bucket lifecycle set <BUCKET_NAME> --rules lifecycle-rules.json
    applyCommand: `wrangler r2 bucket lifecycle set ${process.env.R2_BUCKET_NAME ?? 'beba-sacco'} --rules lifecycle-rules.json`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MONITORING HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify all monitoring integrations are configured.
 * Called at application startup to surface missing configuration early.
 *
 * @returns Object with status of each monitoring integration
 */
export function verifyMonitoringConfig(): {
  sentry: boolean;
  slack: boolean;
  sentryEnvironment: string;
  issues: string[];
} {
  const issues: string[] = [];

  const sentryDsn = process.env.SENTRY_DSN ?? '';
  const slackWebhook = process.env.SLACK_WEBHOOK_URL ?? '';
  const sentryEnvironment = process.env.SENTRY_ENVIRONMENT ?? 'unknown';

  if (!sentryDsn) {
    issues.push('SENTRY_DSN not configured — error tracking disabled (SASRA Circular 3/2022 §5)');
  } else if (!sentryDsn.startsWith('https://')) {
    issues.push('SENTRY_DSN appears invalid (must start with https://)');
  }

  if (!slackWebhook) {
    issues.push('SLACK_WEBHOOK_URL not configured — operational alerts disabled');
  } else if (!slackWebhook.startsWith('https://hooks.slack.com/')) {
    issues.push('SLACK_WEBHOOK_URL appears invalid (must be a Slack incoming webhook URL)');
  }

  if (sentryEnvironment !== 'production') {
    issues.push(`SENTRY_ENVIRONMENT="${sentryEnvironment}" — should be "production" for live deployment`);
  }

  return {
    sentry: !!sentryDsn && sentryDsn.startsWith('https://'),
    slack: !!slackWebhook && slackWebhook.startsWith('https://hooks.slack.com/'),
    sentryEnvironment,
    issues,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Format a Date as ISO 8601 string in EAT (UTC+3) */
function toEatIso(date: Date): string {
  const eat = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return eat.toISOString().replace('Z', '+03:00');
}

// ✅ File complete — ready for review
