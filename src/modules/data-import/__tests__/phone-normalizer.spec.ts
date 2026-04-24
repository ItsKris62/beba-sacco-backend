import { normalizePhone, isValidE164Phone } from '../utils/phone-normalizer';

describe('normalizePhone', () => {
  // ── Valid inputs ──────────────────────────────────────────────────────────

  it('normalizes 07xx format (10 digits)', () => {
    const result = normalizePhone('0704413592');
    expect(result.normalized).toBe('254704413592');
    expect(result.isValid).toBe(true);
  });

  it('normalizes 9-digit format (missing leading 0)', () => {
    const result = normalizePhone('704413592');
    expect(result.normalized).toBe('254704413592');
    expect(result.isValid).toBe(true);
  });

  it('normalizes already-E164 format', () => {
    const result = normalizePhone('254704413592');
    expect(result.normalized).toBe('254704413592');
    expect(result.isValid).toBe(true);
  });

  it('normalizes +254 format (strips +)', () => {
    const result = normalizePhone('+254704413592');
    expect(result.normalized).toBe('254704413592');
    expect(result.isValid).toBe(true);
  });

  it('normalizes Airtel 01x format', () => {
    const result = normalizePhone('0110123456');
    expect(result.normalized).toBe('254110123456');
    expect(result.isValid).toBe(true);
  });

  // ── CSV edge cases from actual data ──────────────────────────────────────

  it('handles 9-digit Safaricom number from CSV (796762007)', () => {
    const result = normalizePhone('796762007');
    expect(result.normalized).toBe('254796762007');
    expect(result.isValid).toBe(true);
  });

  it('handles 9-digit number starting with 7 (769765513)', () => {
    const result = normalizePhone('769765513');
    expect(result.normalized).toBe('254769765513');
    expect(result.isValid).toBe(true);
  });

  // ── Invalid inputs ────────────────────────────────────────────────────────

  it('returns null for empty string', () => {
    const result = normalizePhone('');
    expect(result.normalized).toBeNull();
    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('PHONE_EMPTY');
  });

  it('returns null for null input', () => {
    const result = normalizePhone(null);
    expect(result.normalized).toBeNull();
    expect(result.isValid).toBe(false);
  });

  it('returns null for 9-digit number starting with 11x (landline-like)', () => {
    // e.g., 115483804 from CSV – invalid mobile
    const result = normalizePhone('115483804');
    expect(result.normalized).toBeNull();
    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('PHONE_INVALID_FORMAT');
  });

  it('returns null for 9-digit number starting with 10x', () => {
    const result = normalizePhone('101279112');
    expect(result.normalized).toBeNull();
    expect(result.isValid).toBe(false);
  });

  it('returns null for too-short number', () => {
    const result = normalizePhone('12345');
    expect(result.normalized).toBeNull();
    expect(result.isValid).toBe(false);
  });

  it('preserves original value in result', () => {
    const result = normalizePhone('0704413592');
    expect(result.original).toBe('0704413592');
  });
});

describe('isValidE164Phone', () => {
  it('validates correct E.164 Safaricom number', () => {
    expect(isValidE164Phone('254704413592')).toBe(true);
  });

  it('validates correct E.164 Airtel number', () => {
    expect(isValidE164Phone('254110123456')).toBe(true);
  });

  it('rejects number without country code', () => {
    expect(isValidE164Phone('0704413592')).toBe(false);
  });

  it('rejects number with + prefix', () => {
    expect(isValidE164Phone('+254704413592')).toBe(false);
  });

  it('rejects too-short number', () => {
    expect(isValidE164Phone('25470441359')).toBe(false);
  });
});
