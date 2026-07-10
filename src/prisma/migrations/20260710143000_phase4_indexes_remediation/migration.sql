-- Phase 4 backend audit: dashboard/cash-flow indexes and released guarantor state.

ALTER TYPE "public"."GuarantorStatus" ADD VALUE IF NOT EXISTS 'RELEASED';

CREATE INDEX IF NOT EXISTS "Transaction_tenantId_accountId_type_createdAt_idx"
ON "public"."Transaction"("tenantId", "accountId", "type", "createdAt");

CREATE INDEX IF NOT EXISTS "Guarantor_tenantId_status_holdReleasedAt_idx"
ON "public"."Guarantor"("tenantId", "status", "holdReleasedAt");
