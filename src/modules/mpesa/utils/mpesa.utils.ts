/**
 * M-Pesa shared utilities.
 *
 * Consumed by MpesaService, MpesaCallbackProcessor, and MpesaDisbursementProcessor.
 * Centralised here so phone-masking and reference-parsing are single sources of
 * truth — changes to the SASRA/ODPC masking policy or the accountReference prefix
 * convention need to be made in one place only.
 */

// ─── Phone masking ────────────────────────────────────────────────────────────

/**
 * Mask a Kenyan phone number for use in log output and API responses.
 *
 * Kenya Data Protection Act / ODPC requirement: full MSISDNs must not appear
 * in application logs, error messages, or API responses (other than the
 * dedicated, access-controlled transaction detail endpoint).
 *
 * Format: 254***{last4}  (e.g. 254712345678 → 254***5678)
 *
 * @param phone E.164 Kenyan phone (254XXXXXXXXX or 2541XXXXXXXX)
 */
export function maskPhone(phone: string): string {
  if (!phone || phone.length < 4) return '254***????';
  return `254***${phone.slice(-4)}`;
}

// ─── Reference routing ────────────────────────────────────────────────────────

export type ParsedRefType = 'LOAN_REPAYMENT' | 'DEPOSIT';

export interface ParsedReference {
  type: ParsedRefType;
  /**
   * For LOAN_REPAYMENT: the loan number (e.g. LN-2025-000001).
   * For DEPOSIT via account number: the account number (e.g. ACC-FOSA-000042).
   * For DEPOSIT via DEPOSIT-{memberId}: the memberId UUID.
   */
  target: string;
  /**
   * True when the DEPOSIT target is a memberId (DEPOSIT-{id} prefix).
   * False when it is a bare account number.
   */
  isMemberIdDeposit: boolean;
}

/**
 * Deterministic router for M-Pesa `accountReference` strings.
 *
 * Convention (stored on MpesaTransaction.accountReference at initiation time):
 *   LOAN-{loanNumber}    → LOAN_REPAYMENT: credit FOSA, update Loan totals
 *   DEPOSIT-{memberId}   → DEPOSIT: credit member's default FOSA account
 *   {accountNumber}      → DEPOSIT: credit the named account directly
 *
 * The prefix is set by MpesaService.buildAccountRef() at STK Push initiation
 * or by the C2B BillRefNumber entered by the customer.
 *
 * @param accountReference  The stored accountReference string.
 * @returns ParsedReference  Discriminated object for clean switch/if routing.
 */
export function parseReference(accountReference: string): ParsedReference {
  if (accountReference.startsWith('LOAN-')) {
    return {
      type: 'LOAN_REPAYMENT',
      target: accountReference.slice('LOAN-'.length).trim(),
      isMemberIdDeposit: false,
    };
  }

  if (accountReference.startsWith('DEPOSIT-')) {
    return {
      type: 'DEPOSIT',
      target: accountReference.slice('DEPOSIT-'.length).trim(),
      isMemberIdDeposit: true,
    };
  }

  // Bare account number (e.g. ACC-FOSA-000042)
  return {
    type: 'DEPOSIT',
    target: accountReference.trim(),
    isMemberIdDeposit: false,
  };
}

// ─── Reference key builders ───────────────────────────────────────────────────

/**
 * Build the Layer-3 idempotency reference stored on MpesaTransaction.reference.
 *
 * This field is @unique in the schema, providing the final safety net against
 * race conditions that slip through Layer-1 (BullMQ jobId) and Layer-2
 * (status !== PENDING check).
 */
export const buildMpesaRef = {
  stk: (checkoutRequestId: string) => `STK-${checkoutRequestId}`,
  b2c: (conversationId: string) => `B2C-${conversationId}`,
  c2b: (transId: string) => `C2B-${transId}`,
};

// ─── Daraja timestamp ─────────────────────────────────────────────────────────

/**
 * Parse a Daraja YYYYMMDDHHmmss timestamp (EAT, UTC+3) into a JS Date.
 * Returns `new Date()` on malformed input so callers don't need to null-check.
 */
export function parseDarajaTimestamp(ts: string): Date {
  if (!ts || ts.length < 14) return new Date();
  const [Y, Mo, D, H, Mi, S] = [
    ts.slice(0, 4),
    ts.slice(4, 6),
    ts.slice(6, 8),
    ts.slice(8, 10),
    ts.slice(10, 12),
    ts.slice(12, 14),
  ];
  return new Date(`${Y}-${Mo}-${D}T${H}:${Mi}:${S}+03:00`);
}

/**
 * Returns true if the Daraja transaction timestamp is more than `maxSkewMs`
 * (default 5 minutes) from the current server clock.
 *
 * SASRA compliance: callbacks with a skew > 5 min are logged as warnings.
 * We do NOT reject them because blocking a stale-but-valid Daraja retry would
 * leave real money unbooked. Instead, alert on the warning and investigate.
 */
export function isTimestampSkewed(
  darajaTs: string,
  maxSkewMs = 5 * 60 * 1000,
): { skewed: boolean; skewSeconds: number } {
  const txDate = parseDarajaTimestamp(darajaTs);
  const skewMs = Math.abs(Date.now() - txDate.getTime());
  return { skewed: skewMs > maxSkewMs, skewSeconds: Math.round(skewMs / 1000) };
}
