export const NOTIFICATION_QUEUE_NAMES = {
  EMAIL_QUEUE: 'email-queue',
  SMS_QUEUE: 'sms-queue',
  IN_APP_QUEUE: 'in-app-queue',
  EMAIL_DLQ: 'failed:email-queue',
  SMS_DLQ: 'failed:sms-queue',
  IN_APP_DLQ: 'failed:in-app-queue',
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
