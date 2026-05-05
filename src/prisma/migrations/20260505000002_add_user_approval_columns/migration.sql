-- Migration: add_user_approval_columns
--
-- Adds the four User approval/lifecycle columns that are in schema.prisma
-- but were missed when the previous migration was partially applied.
-- All columns are nullable so existing rows are unaffected.

ALTER TABLE "public"."User"
  ADD COLUMN IF NOT EXISTS "createdById"    TEXT,
  ADD COLUMN IF NOT EXISTS "approvedById"   TEXT,
  ADD COLUMN IF NOT EXISTS "approvedAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "approvalReason" TEXT;
