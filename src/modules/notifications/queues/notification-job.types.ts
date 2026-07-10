import { NotificationChannel } from '@prisma/client';
import { DomainEventName } from '../../../common/constants/events';

export const SEND_NOTIFICATION_JOB = 'send-notification';

export interface SendNotificationJobPayload {
  tenantId: string;
  eventType: DomainEventName;
  channel: NotificationChannel;
  recipient: string;
  templateId: string;
  subject?: string;
  body: string;
  memberId?: string;
  userId?: string;
  entityId?: string;
  dedupeKey: string;
  metadata?: Record<string, unknown>;
}
