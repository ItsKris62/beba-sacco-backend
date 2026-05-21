-- Phase 1A: secure upload token and checksum quarantine support.
-- Forward-only and safe to deploy while FEATURE_SECURE_UPLOAD_V2=false.

ALTER TYPE "public"."DocumentStatus" ADD VALUE IF NOT EXISTS 'QUARANTINE';

ALTER TABLE "public"."Document"
  ADD COLUMN IF NOT EXISTS "uploadToken" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "uploadTokenExpires" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "uploadConfirmed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "confirmedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "quarantineReason" TEXT,
  ADD COLUMN IF NOT EXISTS "flaggedAt" TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS "Document_uploadToken_key"
  ON "public"."Document" ("uploadToken");

CREATE INDEX IF NOT EXISTS "Document_uploadToken_validation_idx"
  ON "public"."Document" ("uploadToken", "uploadTokenExpires", "status");
