#!/usr/bin/env node
/*
 * Dry-run by default. Use --apply to remove repeatable BullMQ schedules that are
 * not part of the current application schedule allowlist.
 */
const fs = require('fs');
const path = require('path');
const { Queue } = require('bullmq');

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const queueArg = process.argv.find((arg) => arg.startsWith('--queue='));
const onlyQueue = queueArg ? queueArg.slice('--queue='.length) : undefined;

function bullConnection() {
  if (process.env.BULL_REDIS_URL) {
    const parsed = new URL(process.env.BULL_REDIS_URL);
    return {
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      tls: parsed.protocol === 'rediss:' ? { rejectUnauthorized: false } : undefined,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    };
  }

  if (process.env.BULL_REDIS_HOST) {
    return {
      host: process.env.BULL_REDIS_HOST.replace(/^https?:\/\//, ''),
      port: Number(process.env.BULL_REDIS_PORT || 6379),
      password: process.env.BULL_REDIS_PASSWORD || undefined,
      tls: process.env.BULL_REDIS_TLS === 'true' ? { rejectUnauthorized: false } : undefined,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    };
  }

  throw new Error('Bull Redis is not configured. Set BULL_REDIS_URL or BULL_REDIS_HOST; refusing to use app Redis.');
}

const schedules = {
  'financial.mpesa-reconciliation': {
    ids: new Set(['daily-recon-job-v1']),
  },
  'loan.daily-penalties': {
    ids: new Set(['apply-daily-penalties:daily-midnight-eat']),
  },
  'loan.guarantor-forfeiture': {
    ids: new Set(['process-guarantor-forfeiture:daily-midnight-eat']),
  },
  'mpesa.stk-expiry': {
    ids: new Set(['stk-expiry-scheduler']),
  },
  'support.workflows': {
    ids: new Set(['check-sla:system:every-5-minutes', 'auto-close:system:hourly']),
  },
  'compliance.policy-check': {
    prefixes: ['compliance:hourly:'],
  },
};

function isExpected(queueName, job) {
  const rule = schedules[queueName];
  if (!rule) return false;
  const identity = `${job.id || ''} ${job.key || ''}`;
  if ([...(rule.ids || [])].some((id) => identity.includes(id))) return true;
  if (rule.prefixes?.some((prefix) => identity.includes(prefix))) return true;
  return false;
}

async function main() {
  const connection = bullConnection();
  const queueNames = Object.keys(schedules).filter((queueName) => !onlyQueue || queueName === onlyQueue);
  if (onlyQueue && queueNames.length === 0) {
    throw new Error(`Unknown queue "${onlyQueue}". Known queues: ${Object.keys(schedules).join(', ')}`);
  }

  let staleCount = 0;
  for (const queueName of queueNames) {
    const queue = new Queue(queueName, { connection });
    try {
      const repeatables = await queue.getRepeatableJobs();
      const stale = repeatables.filter((job) => !isExpected(queueName, job));
      console.log(`${queueName}: ${repeatables.length} repeatable job(s), ${stale.length} stale`);

      for (const job of stale) {
        staleCount += 1;
        const label = `id=${job.id || '[none]'} name=${job.name} key=${job.key}`;
        if (apply) {
          await queue.removeRepeatableByKey(job.key);
          console.log(`  removed ${label}`);
        } else {
          console.log(`  would remove ${label}`);
        }
      }
    } finally {
      await queue.close();
    }
  }

  console.log(apply ? `Removed ${staleCount} stale repeatable job(s).` : `Dry run complete. ${staleCount} stale repeatable job(s) would be removed. Re-run with --apply to delete.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});