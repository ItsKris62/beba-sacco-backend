import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly slackWebhookUrl = process.env.SLACK_OPS_WEBHOOK_URL;

  async sendSlackAlert(message: string): Promise<void> {
    if (process.env.ENABLE_SUPER_ADMIN_ALERTS !== 'true' || !this.slackWebhookUrl) {
      this.logger.debug(`Alert skipped (disabled or no webhook setup): ${message}`);
      return;
    }

    try {
      const response = await fetch(this.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: message,
          mrkdwn: true,
        }),
      });

      if (!response.ok) {
        this.logger.error(`Failed to send Slack alert. Status: ${response.status}`);
      } else {
        this.logger.log('Slack alert dispatched successfully.');
      }
    } catch (error) {
      this.logger.error('Error dispatching Slack alert', error);
    }
  }
}