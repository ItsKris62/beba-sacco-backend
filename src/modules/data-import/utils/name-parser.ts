/**
 * Name Parser – splits full name into firstName + lastName
 *
 * Rules:
 *   "DAN OCHOLLA"           → { firstName: "Dan", lastName: "Ocholla" }
 *   "ISAAC ODHIAMBO OLOO"   → { firstName: "Isaac", lastName: "Odhiambo Oloo" }
 *   "MAINA MACHUKA GEOFFREY"→ { firstName: "Maina", lastName: "Machuka Geoffrey" }
 *   "SARAH NANGILA"         → { firstName: "Sarah", lastName: "Nangila" }
 *   ""                      → { firstName: "UNKNOWN", lastName: "UNKNOWN" }
 */

export interface ParsedName {
  firstName: string;
  lastName: string;
  fullName: string;
}

/**
 * Parse a full name string into firstName and lastName.
 * Capitalizes each word (title case).
 */
export function parseFullName(fullName: string | null | undefined): ParsedName {
  const raw = fullName?.trim() ?? '';

  if (!raw) {
    return { firstName: 'Unknown', lastName: 'Unknown', fullName: 'Unknown Unknown' };
  }

  // Normalize: collapse multiple spaces, trim apostrophes in names like "OLANG'"
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const parts = normalized.split(' ').filter(Boolean);

  if (parts.length === 0) {
    return { firstName: 'Unknown', lastName: 'Unknown', fullName: 'Unknown Unknown' };
  }

  if (parts.length === 1) {
    const name = toTitleCase(parts[0]);
    return { firstName: name, lastName: name, fullName: name };
  }

  // First word = firstName, rest = lastName
  const firstName = toTitleCase(parts[0]);
  const lastName = parts
    .slice(1)
    .map(toTitleCase)
    .join(' ');

  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
  };
}

/**
 * Convert a string to Title Case, preserving apostrophes.
 * e.g., "ODHIAMBO" → "Odhiambo", "OLANG'" → "Olang'"
 */
function toTitleCase(word: string): string {
  if (!word) return '';
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Generate a deterministic email from name + phone for imported users.
 * Format: firstname.lastname.phone@import.local
 * This is a placeholder – admins should update with real emails.
 */
export function generateImportEmail(firstName: string, lastName: string, phone: string): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 20);

  const f = clean(firstName);
  const l = clean(lastName);
  const p = phone.slice(-6); // last 6 digits of phone

  return `${f}.${l}.${p}@import.local`;
}
