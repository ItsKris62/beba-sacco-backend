import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class TinybirdService {
  private readonly logger = new Logger(TinybirdService.name);
  private readonly token = process.env.TINYBIRD_TOKEN;
  private readonly endpoint = process.env.TINYBIRD_ENDPOINT || 'https://api.tinybird.co/v0/events';

  /**
   * Streams high-volume events to Tinybird for real-time analytics.
   * Ideal for Audit Logs, Dashboard KPIs, and M-Pesa Webhook tracking.
   * 
   * @param datasource The name of the Tinybird datasource (e.g., 'audit_logs_events')
   * @param payload JSON object representing the event
   */
  async trackEvent(datasource: string, payload: Record<string, any>): Promise<void> {
    if (!this.token) {
      this.logger.warn('Tinybird token is not configured. Event tracking skipped.');
      return;
    }

    try {
      // Add standard timestamp if missing
      const eventPayload = {
        timestamp: new Date().toISOString(),
        ...payload,
      };

      // Fire-and-forget HTTP request to Tinybird Events API
      axios.post(`${this.endpoint}?name=${datasource}`, eventPayload, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Tinybird ingestion failed for datasource: ${datasource}`, message);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error preparing Tinybird event: ${message}`);
    }
  }

  /**
   * Fetches real-time API error statistics from the published Tinybird Pipe.
   * Powered by the 'http_api_audit_events' datasource.
   * 
   * @param tenantId Optional tenant ID to filter the dashboard
   */
  async getApiErrorStats(tenantId?: string): Promise<any[]> {
    if (!this.token) {
      this.logger.warn('Tinybird token is not configured. Cannot fetch error stats.');
      return [];
    }

    try {
      // Dynamically switch the ingestion URL to the query API URL
      const url = new URL(this.endpoint.replace('/events', '/pipes/api_errors_dashboard.json'));
      url.searchParams.append('token', this.token);
      
      if (tenantId) {
        url.searchParams.append('tenantId', tenantId);
      }

      const response = await axios.get(url.toString());
      return response.data.data; // Tinybird responses wrap rows in a 'data' array
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to fetch API error stats from Tinybird: ${message}`);
      return [];
    }
  }
}
