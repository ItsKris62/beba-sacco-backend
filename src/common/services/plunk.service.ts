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
 *  - Degrades gracefully when the API key is absent (dev / CI environments)
 *  - Never throws — all errors are logged so a failed email never breaks a user-facing request
 *
 * Usage:
 *   await this.plunk.send({ to, subject, body });
 *
 * In production PLUNK_API_KEY must be set or every send will be skipped silently.
 */
@Injectable()
export class PlunkService {
  private readonly logger = new Logger(PlunkService.name);
  private readonly client: Plunk | null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = config.get<string>('app.plunk.apiKey', '');
    this.from = config.get<string>('app.plunk.fromEmail', 'noreply@beba-sacco.com');

    if (apiKey) {
      this.client = new Plunk(apiKey);
      this.logger.log('Plunk email client initialised');
    } else {
      this.client = null;
      this.logger.warn(
        'PLUNK_API_KEY is not set — all outbound emails will be skipped. ' +
        'Set PLUNK_API_KEY in your environment to enable email delivery.',
      );
    }
  }

  /**
   * Send a transactional email.
   * Returns true on success, false on any failure (including missing API key).
   * Never throws.
   */
  async send(opts: SendEmailOptions): Promise<boolean> {
    if (!this.client) {
      this.logger.debug(`[EMAIL SKIP – no API key] to=${opts.to} subject="${opts.subject}"`);
      return false;
    }

    try {
      await this.client.emails.send({
        to: opts.to,
        subject: opts.subject,
        body: opts.body,
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
