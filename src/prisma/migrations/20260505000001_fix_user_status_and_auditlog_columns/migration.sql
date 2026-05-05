-- Migration: fix_user_status_and_auditlog_columns
--
-- Fixes two schema-drift issues that break login:
--
-- 1. User.status – the previous migration added a `userStatus TEXT` column as a
--    placeholder, but the schema was updated to use `status UserStatus` (enum).
--    The Prisma client always returns all schema columns, so every user.update()
--    fails with "column User.status does not exist".
--    Fix: create the UserStatus enum and add the `status` column.
--    Existing rows default to APPROVED so no active accounts are locked out.
--
-- 2. AuditLog column renames – the schema renamed userId→actorId,
--    resource→entityType, resourceId→entityId, and added oldValue/newValue.
--    No migration was run to apply these changes, so AuditService.create()
--    fails with "column actorId does not exist".
--    Fix: rename the columns, re-create FK + indexes, add new columns.
--
-- 3. UserRole.CHAIRMAN – added to the enum to match the current schema.

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 1: UserStatus enum + User.status column
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE "public"."UserStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- Add the typed status column. All existing rows get APPROVED so currently
-- active users remain unaffected. The Prisma @default(PENDING) ensures new
-- registrations via prisma.user.create() always start as PENDING.
ALTER TABLE "public"."User"
  ADD COLUMN "status" "public"."UserStatus" NOT NULL DEFAULT 'APPROVED';

-- Carry over any rows that had the old text column set to non-ACTIVE values.
-- (In practice all rows will be 'ACTIVE' → APPROVED, but this is defensive.)
UPDATE "public"."User"
  SET "status" = 'SUSPENDED'
  WHERE "userStatus" = 'SUSPENDED';

CREATE INDEX "User_status_idx" ON "public"."User"("status");

-- Add User approval/lifecycle columns that are in the schema but missing from the DB.
-- These are all nullable so no default value is needed for existing rows.
ALTER TABLE "public"."User"
  ADD COLUMN "createdById"     TEXT,
  ADD COLUMN "approvedById"    TEXT,
  ADD COLUMN "approvedAt"      TIMESTAMP(3),
  ADD COLUMN "approvalReason"  TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 2: AuditLog column renames and new columns
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop the old FK constraint (references "userId")
ALTER TABLE "public"."AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_userId_fkey";

-- Drop the old index on "userId"
DROP INDEX IF EXISTS "public"."AuditLog_userId_idx";

-- Rename columns to match the current schema
ALTER TABLE "public"."AuditLog" RENAME COLUMN "userId" TO "actorId";
ALTER TABLE "public"."AuditLog" RENAME COLUMN "resource" TO "entityType";
ALTER TABLE "public"."AuditLog" RENAME COLUMN "resourceId" TO "entityId";

-- Add the new value columns (nullable — not all events have before/after state)
ALTER TABLE "public"."AuditLog"
  ADD COLUMN "oldValue" JSONB,
  ADD COLUMN "newValue" JSONB;

-- Re-create FK with the new column name
ALTER TABLE "public"."AuditLog"
  ADD CONSTRAINT "AuditLog_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "public"."User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Re-create indexes with new names
CREATE INDEX "AuditLog_actorId_idx" ON "public"."AuditLog"("actorId");
CREATE INDEX "AuditLog_entityType_idx" ON "public"."AuditLog"("entityType");

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 3: Add CHAIRMAN to UserRole enum
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TYPE "public"."UserRole" ADD VALUE IF NOT EXISTS 'CHAIRMAN';
