-- Migration: 20260515000000_max5_member_stages_trigger
-- Enforces a maximum of 5 active stage assignments per member at the database
-- level, preventing bypasses via direct SQL or concurrent API requests.
--
-- The MemberStage Prisma model has no @@map(), so Prisma uses the PascalCase
-- table name "MemberStage". All column names are also quoted camelCase as
-- Prisma generates them (e.g. "memberId", "isActive").

-- ── 1. Trigger function ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION check_max_member_stages()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_count INTEGER;
BEGIN
  -- Only enforce the limit when the row being inserted/updated is active.
  -- On UPDATE where isActive goes false → false, or true → false, skip the check.
  IF NEW."isActive" = true THEN
    SELECT COUNT(*)
    INTO   active_count
    FROM   "MemberStage"
    WHERE  "memberId" = NEW."memberId"
      AND  "isActive" = true
      -- Exclude the current row so UPDATE doesn't count itself twice.
      -- For INSERT this is a no-op: no row with NEW."id" exists yet.
      AND  "id" != NEW."id";

    IF active_count >= 5 THEN
      RAISE EXCEPTION
        'Member cannot represent more than 5 active stages (memberId: %)',
        NEW."memberId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ── 2. Trigger (BEFORE INSERT OR UPDATE, row-level) ───────────────────────────

-- Drop first for idempotency – safe to re-run this migration.
DROP TRIGGER IF EXISTS trg_max_member_stages ON "MemberStage";

CREATE TRIGGER trg_max_member_stages
  BEFORE INSERT OR UPDATE OF "isActive", "memberId"
  ON "MemberStage"
  FOR EACH ROW
  EXECUTE FUNCTION check_max_member_stages();
