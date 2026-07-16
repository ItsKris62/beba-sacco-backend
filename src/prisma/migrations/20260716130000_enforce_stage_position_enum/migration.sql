-- Convert MemberApplication.position from a free-form String to the StagePosition
-- enum already used by StageAssignment.position, for the same reason: the DTO
-- (CreateApplicationDto) already restricted values to CHAIRMAN/SECRETARY/TREASURER/
-- MEMBER, so the column type now matches what was already enforced in application code.
--
-- NOTE: prisma migrate diff generates a DROP COLUMN + re-ADD for this conversion,
-- which would silently reset every existing row to the new column's default value
-- regardless of what it actually held. Hand-written here as an in-place USING cast
-- instead, so existing data survives the conversion (all 9 current rows are
-- 'MEMBER', but this must not depend on that being true).
ALTER TABLE "public"."MemberApplication" ALTER COLUMN "position" DROP DEFAULT;
ALTER TABLE "public"."MemberApplication"
  ALTER COLUMN "position" TYPE "public"."StagePosition" USING ("position"::"public"."StagePosition");
ALTER TABLE "public"."MemberApplication" ALTER COLUMN "position" SET DEFAULT 'MEMBER';
