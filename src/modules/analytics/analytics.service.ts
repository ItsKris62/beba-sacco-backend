import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Analytics Service
 * 
 * Tinybird HTTP ingestion for real-time analytics
 * 
 * Events tracked:
 * - User login/logout
 * - Loan applications
 * - Transactions
 * - M-Pesa payments
 * - API usage
 * - Errors and exceptions
 * 
 * TODO: Phase 2 - Implement event ingestion
 * TODO: Phase 3 - Add batch event sending
 * TODO: Phase 4 - Add analytics querying (dashboards)
 * TODO: Phase 5 - Add anomaly detection
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private readonly tinybirdUrl: string;
  private readonly tinybirdToken: string;

  constructor(private readonly configService: ConfigService) {
    this.tinybirdUrl = this.configService.get<string>('app.tinybird.apiUrl', 'https://api.tinybird.co');
    this.tinybirdToken = this.configService.get<string>('app.tinybird.token', '');
  }

  /**
   * Send single event to Tinybird
   * 
   * TODO: Phase 2 - Implement HTTP ingestion
   */
  async sendEvent(eventName: string, data: Record<string, any>): Promise<void> {
    // TODO: Phase 2
    // POST to Tinybird Events API
    // https://api.tinybird.co/v0/events?name={datasource_name}
    // Authorization: Bearer {token}
    // Body: NDJSON format

    this.logger.debug(`Sending event: ${eventName}`, data);

    try {
      // TODO: Phase 2
      // const response = await fetch(`${this.tinybirdUrl}/v0/events?name=${eventName}`, {
      //   method: 'POST',
      //   headers: {
      //     'Authorization': `Bearer ${this.tinybirdToken}`,
      //     'Content-Type': 'application/json',
      //   },
      //   body: JSON.stringify(data),
      // });
    } catch (error) {
      this.logger.error(`Failed to send event: ${eventName}`, error);
      // Don't throw - analytics shouldn't break the app
    }
  }

  /**
   * Send batch events
   * TODO: Phase 3 - Implement for performance
   */
  async sendBatch(eventName: string, events: Record<string, any>[]): Promise<void> {
    throw new Error('Not implemented - Phase 3');
  }

  /**
   * Track user action
   * TODO: Phase 2 - Implement
   */
  async trackAction(
    userId: string,
    tenantId: string,
    action: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    await this.sendEvent('user_actions', {
      timestamp: new Date().toISOString(),
      userId,
      tenantId,
      action,
      ...metadata,
    });
  }

  /**
   * Track API request
   * TODO: Phase 2 - Called from AuditInterceptor
   */
  async trackApiRequest(
    method: string,
    path: string,
    statusCode: number,
    duration: number,
    tenantId?: string,
    userId?: string,
  ): Promise<void> {
    await this.sendEvent('api_requests', {
      timestamp: new Date().toISOString(),
      method,
      path,
      statusCode,
      duration,
      tenantId,
      userId,
    });
  }

  /**
   * Track error
   * TODO: Phase 2 - Called from GlobalExceptionFilter
   */
  async trackError(
    error: Error,
    context: string,
    tenantId?: string,
    userId?: string,
  ): Promise<void> {
    await this.sendEvent('errors', {
      timestamp: new Date().toISOString(),
      error: error.message,
      stack: error.stack,
      context,
      tenantId,
      userId,
    });
  }
}

