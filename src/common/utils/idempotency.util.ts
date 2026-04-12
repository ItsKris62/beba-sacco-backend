import { createHash } from 'crypto';

/**
 * Idempotency Key Generator
 * 
 * Generates deterministic idempotency keys for critical operations
 * (loan applications, transactions, etc.)
 * 
 * Prevents duplicate operations in case of network retries
 * 
 * TODO: Phase 2 - Implement Redis-based idempotency check
 * TODO: Phase 3 - Add TTL for idempotency keys (24 hours)
 * 
 * Usage:
 * const key = generateIdempotencyKey(userId, 'loan-application', loanData);
 * const exists = await redis.exists(key);
 * if (exists) throw new ConflictException('Duplicate request');
 */

export function generateIdempotencyKey(
  userId: string,
  operation: string,
  data: any,
): string {
  const payload = JSON.stringify({ userId, operation, data });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Idempotency Check Result
 */
export interface IdempotencyResult {
  isDuplicate: boolean;
  existingResponse?: any;
}

/**
 * TODO: Phase 2 - Implement IdempotencyService with Redis
 * 
 * class IdempotencyService {
 *   async check(key: string): Promise<IdempotencyResult>
 *   async store(key: string, response: any, ttl: number): Promise<void>
 * }
 */

