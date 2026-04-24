/**
 * Shared request type augmentations for Sprint 3
 */
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../modules/auth/strategies/jwt.strategy';

export interface TenantContext {
  id: string;
  name: string;
  slug: string;
  schemaName: string;
  status: string;
  settings: unknown;
  contactEmail: string;
  contactPhone: string;
  address: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthenticatedRequest extends Request {
  tenant: TenantContext;
  tenantId: string;
  user: AuthenticatedUser;
}
