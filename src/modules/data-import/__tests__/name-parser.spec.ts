import { parseFullName, generateImportEmail } from '../utils/name-parser';

describe('parseFullName', () => {
  it('splits two-part name', () => {
    const result = parseFullName('DAN OCHOLLA');
    expect(result.firstName).toBe('Dan');
    expect(result.lastName).toBe('Ocholla');
    expect(result.fullName).toBe('Dan Ocholla');
  });

  it('splits three-part name (first + compound last)', () => {
    const result = parseFullName('ISAAC ODHIAMBO OLOO');
    expect(result.firstName).toBe('Isaac');
    expect(result.lastName).toBe('Odhiambo Oloo');
  });

  it('splits four-part name', () => {
    const result = parseFullName('MAINA MACHUKA GEOFFREY');
    expect(result.firstName).toBe('Maina');
    expect(result.lastName).toBe('Machuka Geoffrey');
  });

  it('handles name with apostrophe', () => {
    const result = parseFullName("BENARD OLANG'");
    expect(result.firstName).toBe('Benard');
    expect(result.lastName).toBe("Olang'");
  });

  it('handles single name', () => {
    const result = parseFullName('JOHN');
    expect(result.firstName).toBe('John');
    expect(result.lastName).toBe('John');
  });

  it('returns Unknown for empty string', () => {
    const result = parseFullName('');
    expect(result.firstName).toBe('Unknown');
    expect(result.lastName).toBe('Unknown');
  });

  it('returns Unknown for null', () => {
    const result = parseFullName(null);
    expect(result.firstName).toBe('Unknown');
    expect(result.lastName).toBe('Unknown');
  });

  it('handles extra whitespace', () => {
    const result = parseFullName('  JOHN   OMONDI  ');
    expect(result.firstName).toBe('John');
    expect(result.lastName).toBe('Omondi');
  });

  it('converts to title case', () => {
    const result = parseFullName('GEORGE WASHINGTON');
    expect(result.firstName).toBe('George');
    expect(result.lastName).toBe('Washington');
  });

  // Real CSV names
  it('handles WYCKLIF OWINO SUDI', () => {
    const result = parseFullName('WYCKLIF OWINO SUDI');
    expect(result.firstName).toBe('Wycklif');
    expect(result.lastName).toBe('Owino Sudi');
  });

  it('handles PAUL ODHIABO OUDO', () => {
    const result = parseFullName('PAUL ODHIABO OUDO');
    expect(result.firstName).toBe('Paul');
    expect(result.lastName).toBe('Odhiabo Oudo');
  });
});

describe('generateImportEmail', () => {
  it('generates deterministic email', () => {
    const email = generateImportEmail('Dan', 'Ocholla', '254704413592');
    expect(email).toBe('dan.ocholla.413592@import.local');
  });

  it('handles special characters in name', () => {
    const email = generateImportEmail("Benard", "Olang'", '254792721426');
    expect(email).toMatch(/@import\.local$/);
    expect(email).not.toContain("'");
  });

  it('uses last 6 digits of phone', () => {
    const email = generateImportEmail('John', 'Doe', '254712345678');
    expect(email).toContain('345678');
  });
});
