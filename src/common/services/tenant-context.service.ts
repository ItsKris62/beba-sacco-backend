/**
 * Tenant Context Service
 *
 * Uses Node.js AsyncLocalStorage to propagate the current tenantId
 * through the async call stack without explicit parameter passing.
 *
 * This enables Prisma middleware to automatically inject tenantId
 * into every query, ensuring cross-tenant data leakage is impossible
 * even if a developer forgets to add tenantId to a where clause.
 */
import { AsyncLocalStorage } from 'async_hooks';

export interface TenantContextStore {
  tenantId: string;
  tenantSlug?: string;
  userId?: string;
  role?: string;
  rlsEnabled?: boolean;
  bypassRls?: boolean;
}

export const tenantAsyncStorage = new AsyncLocalStorage<TenantContextStore | undefined>();

export function getCurrentTenantId(): string | undefined {
  return tenantAsyncStorage.getStore()?.tenantId;
}

export function getCurrentTenantContext(): TenantContextStore | undefined {
  return tenantAsyncStorage.getStore();
}
