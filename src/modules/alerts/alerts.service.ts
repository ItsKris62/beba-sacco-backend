import { Injectable, Logger, Optional } from '@nestjs/common';
import { PlunkService } from '../../common/services/plunk.service';

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly slackWebhookUrl = process.env.SLACK_OPS_WEBHOOK_URL;

  constructor(@Optional() private readonly plunk?: PlunkService) {}

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

  async sendOpsEmail(subject: string, summary: string, attachmentText?: string): Promise<void> {
    const to = process.env.OPS_ALERT_EMAIL || process.env.ALERTS_EMAIL || process.env.ADMIN_EMAIL;
    if (!to || !this.plunk) {
      this.logger.debug(`Ops email skipped (disabled or no recipient): ${subject}`);
      return;
    }

    const body = [
      `<p>${summary.replace(/\n/g, '<br/>')}</p>`,
      attachmentText ? `<pre>${this.escapeHtml(attachmentText)}</pre>` : '',
    ].join('\n');

    await this.plunk.send({ to, subject, body });
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
