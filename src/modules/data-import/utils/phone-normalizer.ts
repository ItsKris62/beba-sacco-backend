/**
 * Phone Number Normalizer – Kenyan numbers to E.164 (2547xxxxxxxx)
 *
 * Handles:
 *   07xxxxxxxxx   → 2547xxxxxxxxx  (10-digit with leading 0)
 *   7xxxxxxxxx    → 2547xxxxxxxxx  (9-digit Safaricom, missing leading 0)
 *   2547xxxxxxxx  → 2547xxxxxxxx   (already E.164)
 *   +2547xxxxxxxx → 2547xxxxxxxx   (strip +)
 *   01xxxxxxxxx   → 254 1xxxxxxxxx (10-digit Airtel with leading 0)
 *   115483804     → null           (9-digit starting with 1 = ambiguous/invalid)
 *   blank/null    → null
 */

const E164_PREFIX = '254';

export interface NormalizeResult {
  normalized: string | null;
  original: string | null;
  isValid: boolean;
  errorCode?: string;
}

/**
 * Normalize a raw phone string to E.164 Kenyan format.
 * Returns null if the number cannot be normalized.
 */
export function normalizePhone(raw: string | null | undefined): NormalizeResult {
  const original = raw?.trim() ?? null;

  if (!original || original === '' || original === '0') {
    return { normalized: null, original, isValid: false, errorCode: 'PHONE_EMPTY' };
  }

  // Strip all non-digit characters except leading +
  let digits = original.replace(/[^\d+]/g, '');

  // Strip leading +
  if (digits.startsWith('+')) {
    digits = digits.slice(1);
  }

  // Already E.164 with country code 254 (12 digits total)
  if (digits.startsWith('254') && digits.length === 12) {
    const local = digits.slice(3); // 9-digit local part
    if (isValidKenyanLocal9(local)) {
      return { normalized: digits, original, isValid: true };
    }
    return { normalized: null, original, isValid: false, errorCode: 'PHONE_INVALID_FORMAT' };
  }

  // 10-digit with leading 0: 07xxxxxxxxx or 01xxxxxxxxx
  if (digits.startsWith('0') && digits.length === 10) {
    const local = digits.slice(1); // strip leading 0 → 9-digit local
    if (isValidKenyanLocal9(local)) {
      return { normalized: `${E164_PREFIX}${local}`, original, isValid: true };
    }
    return { normalized: null, original, isValid: false, errorCode: 'PHONE_INVALID_FORMAT' };
  }

  // 9-digit WITHOUT leading 0 – only accept Safaricom (7xx) to avoid ambiguity.
  // Numbers starting with 1xx (e.g., 115483804) are data-entry errors in the CSV
  // and cannot be reliably distinguished from short codes / landlines.
  if (digits.length === 9) {
    if (digits.startsWith('7')) {
      return { normalized: `${E164_PREFIX}${digits}`, original, isValid: true };
    }
    // 1xx without leading 0 → invalid
    return { normalized: null, original, isValid: false, errorCode: 'PHONE_INVALID_FORMAT' };
  }

  return {
    normalized: null,
    original,
    isValid: false,
    errorCode: 'PHONE_INVALID_FORMAT',
  };
}

/**
 * Validate a 9-digit local Kenyan number (without country code).
 *
 * Valid prefixes:
 *   7xx – Safaricom (unambiguous in both 9-digit and 10-digit forms)
 *   1xx – Airtel/Telkom (ONLY accepted when the leading 0 was present,
 *          i.e., the caller passed a 10-digit number starting with 01x)
 */
function isValidKenyanLocal9(local: string): boolean {
  if (local.length !== 9) return false;
  // Accept 7xx (Safaricom) and 1xx (Airtel/Telkom when leading 0 was present)
  return /^[71]/.test(local);
}

/**
 * Validate that a normalized phone is in correct E.164 Kenyan format.
 * Accepts 254 7xx xxxxxxx and 254 1xx xxxxxxx (12 digits total).
 */
export function isValidE164Phone(phone: string): boolean {
  return /^254[71]\d{8}$/.test(phone);
}
