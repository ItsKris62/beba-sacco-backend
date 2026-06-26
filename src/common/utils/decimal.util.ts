import { Prisma } from '@prisma/client';

/**
 * Converts a string or number to a Prisma Decimal instance.
 * Handles null/undefined gracefully.
 */
export function toDecimal(value: string | number | Prisma.Decimal | null | undefined): Prisma.Decimal | null {
  if (value === null || value === undefined) return null;
  return new Prisma.Decimal(value);
}

/**
 * Serializes a Decimal to a string for JSON payloads.
 */
export function fromDecimal(decimal: Prisma.Decimal | null | undefined): string | null {
  if (decimal === null || decimal === undefined) return null;
  return decimal.toFixed();
}

