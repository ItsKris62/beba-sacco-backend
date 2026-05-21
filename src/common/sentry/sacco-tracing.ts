import * as Sentry from '@sentry/nestjs';

export interface SaccoSpanLike {
  setAttribute?: (name: string, value: string | number | boolean | undefined) => void;
  setStatus?: (status: { code: number } | string) => void;
  recordException?: (error: unknown) => void;
}

interface SaccoSpanOperation {
  name: string;
  op: string;
  tenantId?: string;
  memberId?: string;
  correlationId?: string;
  metadata?: Record<string, string | number | boolean | undefined>;
}

type SentryWithSpans = typeof Sentry & {
  startSpan?: <T>(
    context: {
      name: string;
      op: string;
      attributes?: Record<string, string | number | boolean | undefined>;
    },
    callback: (span: SaccoSpanLike) => Promise<T>,
  ) => Promise<T>;
  metrics?: {
    increment?: (
      metric: string,
      value?: number,
      options?: { tags?: Record<string, string> },
    ) => void;
  };
};

export async function withSaccoSpan<T>(
  operation: SaccoSpanOperation,
  callback: (span: SaccoSpanLike) => Promise<T>,
): Promise<T> {
  const attributes = {
    'sacco.tenant_id': operation.tenantId,
    'sacco.member_id': operation.memberId,
    'sacco.correlation_id': operation.correlationId,
    'sacco.operation': operation.name,
    ...operation.metadata,
  };
  const sentry = Sentry as SentryWithSpans;

  const run = async (span: SaccoSpanLike = {}): Promise<T> => {
    try {
      const result = await callback(span);
      span.setStatus?.({ code: 1 });
      return result;
    } catch (error) {
      span.setStatus?.({ code: 2 });
      span.recordException?.(error);
      throw error;
    }
  };

  if (typeof sentry.startSpan === 'function') {
    return sentry.startSpan({ name: operation.name, op: operation.op, attributes }, run);
  }

  return run();
}

export function recordSaccoMetric(
  name: string,
  value = 1,
  tags: Record<string, unknown> = {},
): void {
  const sentry = Sentry as SentryWithSpans;
  const normalizedTags = Object.fromEntries(
    Object.entries({
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'unknown',
      ...tags,
    })
      .filter(([, tagValue]) => tagValue !== undefined && tagValue !== null)
      .map(([key, tagValue]) => [key, String(tagValue)]),
  );

  sentry.metrics?.increment?.(name, value, { tags: normalizedTags });
}
