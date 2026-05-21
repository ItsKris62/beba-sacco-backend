-- Phase 2: ODPC compliance metadata for KYC documents.
-- Forward-only and non-destructive: existing rows keep nullable/default values.

ALTER TABLE "public"."Document"
  ADD COLUMN IF NOT EXISTS "consent_timestamp" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "retention_until" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "data_classification" VARCHAR(20) NOT NULL DEFAULT 'PERSONAL';

CREATE INDEX IF NOT EXISTS "Document_retention_until_idx"
  ON "public"."Document" ("retention_until");

CREATE INDEX IF NOT EXISTS "Document_data_classification_tenantId_idx"
  ON "public"."Document" ("data_classification", "tenantId");

CREATE INDEX IF NOT EXISTS "Document_retention_cleanup_idx"
  ON "public"."Document" ("retention_until")
  WHERE "retention_until" IS NOT NULL;
