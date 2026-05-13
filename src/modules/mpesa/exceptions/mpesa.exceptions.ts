/**
 * Base class for all Daraja / M-Pesa exceptions.
 *
 * `retryable` signals whether the caller or a BullMQ processor should
 * attempt the operation again (transient vs permanent failure).
 */
export class MpesaException extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = this.constructor.name;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/** OAuth2 token request failed. Wrong credentials → permanent; network blip → transient. */
export class MpesaOAuthException extends MpesaException {
  constructor(message: string, retryable = false) {
    super('MPESA_OAUTH_FAILED', message, retryable);
  }
}

/** TCP / DNS / TLS failure reaching Daraja. Always retryable. */
export class MpesaNetworkException extends MpesaException {
  constructor(message: string) {
    super('MPESA_NETWORK_ERROR', message, true);
  }
}

/** Required env var absent or malformed. Never retryable without a redeploy. */
export class MpesaConfigException extends MpesaException {
  constructor(missingVar: string) {
    super('MPESA_CONFIG_MISSING', `${missingVar} is not configured`, false);
  }
}

/** Daraja returned HTTP 2xx but a non-zero ResponseCode (business-logic rejection). */
export class MpesaApiException extends MpesaException {
  constructor(
    public readonly responseCode: string,
    description: string,
    retryable = false,
  ) {
    super('MPESA_API_ERROR', `Daraja error ${responseCode}: ${description}`, retryable);
  }
}

/** Daraja returned 5xx or is unreachable after all retry attempts. Retryable via queue. */
export class MpesaServiceUnavailableException extends MpesaException {
  constructor(detail = 'Safaricom Daraja is currently unavailable') {
    super('MPESA_SERVICE_UNAVAILABLE', detail, true);
  }
}
