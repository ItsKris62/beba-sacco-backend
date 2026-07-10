export interface NotificationPayload {
  tenantId: string;
  recipient: string;
  subject?: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderResponse {
  success: boolean;
  providerRef?: string;
  rawResponse?: unknown;
}

export interface INotificationProvider {
  send(payload: NotificationPayload): Promise<ProviderResponse>;
}
