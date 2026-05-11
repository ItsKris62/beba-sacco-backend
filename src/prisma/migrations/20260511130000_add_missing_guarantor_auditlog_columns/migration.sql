-- Add missing columns to Guarantor table (schema drift: added to schema without migrations)
ALTER TABLE "public"."Guarantor"
  ADD COLUMN IF NOT EXISTS "decidedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "decisionSource" TEXT,
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "holdPlacedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "holdReleasedAt" TIMESTAMP(3);

-- Add missing column to AuditLog table
ALTER TABLE "public"."AuditLog"
  ADD COLUMN IF NOT EXISTS "payload" JSONB;
