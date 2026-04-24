/**
 * Fuzzy Stage Name Matcher
 *
 * Uses Levenshtein distance to find the closest matching stage name.
 * Returns confidence score 0–100.
 *
 * Examples:
 *   "KIBOS GALYNES" vs "KIBOS GARLYNES" → ~88% confidence
 *   "TEAM PRACIOUS" vs "TEAM PRECIOUS"  → ~92% confidence
 */

export interface FuzzyMatchResult {
  matched: string | null;
  confidence: number; // 0–100
  isExact: boolean;
}

/**
 * Find the best matching stage name from a list of candidates.
 * Returns null if no match exceeds the minimum confidence threshold.
 */
export function fuzzyMatchStageName(
  input: string,
  candidates: string[],
  minConfidence = 70,
): FuzzyMatchResult {
  if (!input || candidates.length === 0) {
    return { matched: null, confidence: 0, isExact: false };
  }

  const normalizedInput = normalize(input);

  // Check for exact match first
  const exactMatch = candidates.find(c => normalize(c) === normalizedInput);
  if (exactMatch) {
    return { matched: exactMatch, confidence: 100, isExact: true };
  }

  // Find best fuzzy match
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = similarity(normalizedInput, normalize(candidate));
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  const confidence = Math.round(bestScore * 100);

  if (confidence < minConfidence) {
    return { matched: null, confidence, isExact: false };
  }

  return { matched: bestMatch, confidence, isExact: false };
}

/**
 * Normalize a stage name for comparison:
 * - Uppercase
 * - Remove extra spaces
 * - Remove special characters except hyphens
 */
function normalize(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compute string similarity using Levenshtein distance.
 * Returns a value between 0 (no similarity) and 1 (identical).
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const distance = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return 1 - distance / maxLen;
}

/**
 * Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Create a 2D DP table
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}

/**
 * Known stage name aliases/corrections from the CSV data.
 * Maps common misspellings to canonical names.
 */
export const STAGE_NAME_ALIASES: Record<string, string> = {
  'KIBOS GALYNES': 'KIBOS GALYNES',    // canonical
  'KIBOS GARLYNES': 'KIBOS GALYNES',   // typo in CSV
  'GYLINES': 'KIBOS GALYNES',          // abbreviation
  'TEAM PRACIOUS': 'TEAM PRECIOUS',    // typo
  'TEAM PRECIOUS': 'TEAM PRECIOUS',    // canonical
  'KASULE WHITE HOUSE': 'KASULE WHITEHOUSE', // spacing variant
  'KASULE WHITEHOUSE': 'KASULE WHITEHOUSE',  // canonical
};

/**
 * Apply known aliases before fuzzy matching.
 */
export function applyKnownAliases(stageName: string): string {
  const upper = stageName.toUpperCase().trim();
  return STAGE_NAME_ALIASES[upper] ?? stageName;
}
