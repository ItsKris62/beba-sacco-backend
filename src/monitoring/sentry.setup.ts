import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

export function initializeSentry() {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    integrations: [
      nodeProfilingIntegration(),
    ],
    // Performance Monitoring
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0.1,
    // Set profiling sample rate relative to traces sample rate
    profilesSampleRate: 0.1,
    
    // PII Scrubbing per ODPC Data Minimization Principle (Compliance Checklist B1.6)
    beforeSend(event) {
      const request = event.request;
      if (request && request.data) {
        let data = typeof request.data === 'string' ? JSON.parse(request.data) : request.data;
        
        // Mask sensitive fields
        const sensitiveKeys = ['password', 'refreshToken', 'currentPassword', 'newPassword'];
        sensitiveKeys.forEach(key => {
          if (data[key]) data[key] = '[REDACTED]';
        });

        // Mask phone numbers (e.g., 254712345678 -> 2547***5678)
        if (data.phoneNumber) data.phoneNumber = data.phoneNumber.replace(/(\d{4})\d{4}(\d{4})/, '$1****$2');
        
        // Mask national IDs
        if (data.nationalId) data.nationalId = data.nationalId.replace(/(\d{2})\d{4}(\d{1,2})/, '$1****$2');

        request.data = typeof request.data === 'string' ? JSON.stringify(data) : data;
      }
      return event;
    },
  });
}
