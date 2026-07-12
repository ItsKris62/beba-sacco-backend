import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Plunk from '@plunk/node';

export interface SendEmailOptions {
  to: string;
  subject: string;
  body: string;
}

/**
 * Plunk Email Service
 *
 * Thin wrapper around @plunk/node that:
 *  - Initialises the client once from config
 *  - Degrades gracefully when the secret key is absent
 *  - Sends from the configured verified Plunk domain
 *  - Never throws; all errors are logged so email outages do not break requests
 */
@Injectable()
export class PlunkService {
  private readonly logger = new Logger(PlunkService.name);
  private readonly client: Plunk | null;
  private readonly from: string;
  private readonly fromName: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = config.get<string>('app.plunk.secretKey', '') || config.get<string>('app.plunk.apiKey', '');
    const apiUrl = config.get<string>('app.plunk.apiUrl', 'https://next-api.useplunk.com/v1/');
    this.from = config.get<string>('app.plunk.fromEmail', 'noreply@kolwa.mwaloni.com');
    this.fromName = config.get<string>('app.plunk.fromName', 'Beba SACCO');

    if (apiKey) {
      this.client = new Plunk(apiKey, { baseUrl: apiUrl });
      this.logger.log('Plunk email client initialised');
    } else {
      this.client = null;
      this.logger.warn(
        'PLUNK_SECRET_KEY is not set - all outbound emails will be skipped. ' +
          'Set PLUNK_SECRET_KEY in your environment to enable email delivery.',
      );
    }
  }

  /**
   * Send a transactional email.
   * Returns true on success, false on any failure.
   * Never throws.
   */
  async send(opts: SendEmailOptions): Promise<boolean> {
    if (!this.client) {
      this.logger.debug(`[EMAIL SKIP - no API key] to=${opts.to} subject="${opts.subject}"`);
      return false;
    }

    try {
      await this.client.emails.send({
        to: opts.to,
        subject: opts.subject,
        body: opts.body,
        type: 'html',
        from: this.from,
        name: this.fromName,
      });
      this.logger.debug(`Email sent to=${opts.to} subject="${opts.subject}"`);
      return true;
    } catch (err: unknown) {
      this.logger.error(
        `Failed to send email to=${opts.to} subject="${opts.subject}"`,
        err instanceof Error ? err.stack : err,
      );
      return false;
    }
  }
}
