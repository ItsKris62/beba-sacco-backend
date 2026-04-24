import { fuzzyMatchStageName, applyKnownAliases } from '../utils/fuzzy-matcher';

describe('fuzzyMatchStageName', () => {
  const candidates = [
    'KIBOS GALYNES',
    'KIBOS SHINNERS',
    'EASTERN GATE',
    'ONE RAILWAYS',
    'TEAM PRECIOUS',
    'RIVERSIDE RED-BRIDGE',
    'KAMAKAA',
    'UKUNDA',
    'PENG\' PLUS',
    'MBEME BRIDGE',
  ];

  it('returns exact match with 100% confidence', () => {
    const result = fuzzyMatchStageName('KIBOS GALYNES', candidates);
    expect(result.matched).toBe('KIBOS GALYNES');
    expect(result.confidence).toBe(100);
    expect(result.isExact).toBe(true);
  });

  it('fuzzy-matches KIBOS GARLYNES to KIBOS GALYNES', () => {
    const result = fuzzyMatchStageName('KIBOS GARLYNES', candidates);
    expect(result.matched).toBe('KIBOS GALYNES');
    expect(result.confidence).toBeGreaterThan(70);
  });

  it('fuzzy-matches TEAM PRACIOUS to TEAM PRECIOUS', () => {
    const result = fuzzyMatchStageName('TEAM PRACIOUS', candidates);
    expect(result.matched).toBe('TEAM PRECIOUS');
    expect(result.confidence).toBeGreaterThan(80);
  });

  it('returns null for completely unrelated name', () => {
    const result = fuzzyMatchStageName('XYZABC123', candidates, 70);
    expect(result.matched).toBeNull();
  });

  it('returns null for empty input', () => {
    const result = fuzzyMatchStageName('', candidates);
    expect(result.matched).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('returns null for empty candidates', () => {
    const result = fuzzyMatchStageName('KIBOS GALYNES', []);
    expect(result.matched).toBeNull();
  });

  it('is case-insensitive', () => {
    const result = fuzzyMatchStageName('kibos galynes', candidates);
    expect(result.matched).toBe('KIBOS GALYNES');
    expect(result.isExact).toBe(true);
  });

  it('respects minimum confidence threshold', () => {
    // With high threshold, fuzzy match should fail
    const result = fuzzyMatchStageName('KIBOS GARLYNES', candidates, 99);
    expect(result.matched).toBeNull();
  });
});

describe('applyKnownAliases', () => {
  it('maps KIBOS GARLYNES to KIBOS GALYNES', () => {
    expect(applyKnownAliases('KIBOS GARLYNES')).toBe('KIBOS GALYNES');
  });

  it('maps TEAM PRACIOUS to TEAM PRECIOUS', () => {
    expect(applyKnownAliases('TEAM PRACIOUS')).toBe('TEAM PRECIOUS');
  });

  it('maps KASULE WHITE HOUSE to KASULE WHITEHOUSE', () => {
    expect(applyKnownAliases('KASULE WHITE HOUSE')).toBe('KASULE WHITEHOUSE');
  });

  it('returns original for unknown stage name', () => {
    expect(applyKnownAliases('SOME NEW STAGE')).toBe('SOME NEW STAGE');
  });

  it('is case-insensitive', () => {
    expect(applyKnownAliases('kibos garlynes')).toBe('KIBOS GALYNES');
  });
});
