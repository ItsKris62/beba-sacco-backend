export const NOTIFICATION_QUEUE_NAMES = {
  EMAIL_QUEUE: 'email-queue',
  SMS_QUEUE: 'sms-queue',
  IN_APP_QUEUE: 'in-app-queue',
  // Bare colon-namespaced names ('failed:email-queue') are rejected outright
  // by the current bullmq version ("Queue name cannot contain :") — this was
  // a full-app-boot blocker, invisible until something actually instantiated
  // NotificationsQueueModule end-to-end. Matches the `.dlq` suffix convention
  // used by every other dead-letter queue in this codebase (e.g.
  // QUEUE_NAMES.MPESA_CALLBACK_DLQ = 'mpesa.callback.dlq').
  EMAIL_DLQ: 'email-queue.dlq',
  SMS_DLQ: 'sms-queue.dlq',
  IN_APP_DLQ: 'in-app-queue.dlq',
} as const;

export type NotificationQueueName =
  (typeof NOTIFICATION_QUEUE_NAMES)[keyof typeof NOTIFICATION_QUEUE_NAMES];

export const NOTIFICATION_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: false,
} as const;

export const NOTIFICATION_DLQ_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { age: 86_400, count: 1000 },
  removeOnFail: { age: 604_800, count: 1000 },
} as const;
