import * as Sentry from '@sentry/nestjs';
import * as dotenv from 'dotenv';

// Load environment variables if they aren't loaded by your environment yet
dotenv.config();

Sentry.init({
  // If you have SENTRY_DSN in your .env, Sentry will automatically find it.
  // You can also explicitly set it like this: dsn: process.env.SENTRY_DSN,
  
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
  sendDefaultPii: true,
  // Optional: Set tracesSampleRate to 1.0 to capture 100% of transactions for performance monitoring
  tracesSampleRate: 0.1,
  
  // Scrub sensitive request fields before the event reaches the Sentry dashboard.
  beforeSend(event) {
    const data = event.request?.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const SENSITIVE_FIELDS = [
        'password',
        'currentPassword',
        'newPassword',
        'confirmPassword',
        'refreshToken',
        'token',        // password-reset JWT
        'accessTokenJti',
      ];
      const scrubbed = { ...(data as Record<string, unknown>) };
      let changed = false;
      for (const field of SENSITIVE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(scrubbed, field)) {
          scrubbed[field] = '[Filtered]';
          changed = true;
        }
      }
      if (changed) {
        return {
          ...event,
          request: { ...event.request, data: scrubbed },
        };
      }
    }
    return event;
  },
});