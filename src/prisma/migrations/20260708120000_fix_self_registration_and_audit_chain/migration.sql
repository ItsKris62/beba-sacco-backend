-- Keep audit-chain initialization safe for raw SQL inserts.
-- AuthService now creates self-registered users as ACTIVE explicitly so first login works.

ALTER TABLE "public"."AuditChainHead"
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;