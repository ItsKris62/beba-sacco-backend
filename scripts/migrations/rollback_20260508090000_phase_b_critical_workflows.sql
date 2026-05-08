DROP TABLE IF EXISTS "public"."ReportJob";
DROP TYPE IF EXISTS "public"."ReportStatus";
DROP TYPE IF EXISTS "public"."ReportFormat";
DROP TYPE IF EXISTS "public"."ReportType";

DROP INDEX IF EXISTS "public"."Guarantor_tenantId_loanId_status_idx";
DROP INDEX IF EXISTS "public"."Guarantor_tenantId_loanId_memberId_key";

ALTER TABLE "public"."Guarantor"
  DROP COLUMN IF EXISTS "auditMetadata";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'GuarantorStatus' AND e.enumlabel = 'REJECTED'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'GuarantorStatus' AND e.enumlabel = 'DECLINED'
  ) THEN
    ALTER TYPE "public"."GuarantorStatus" RENAME VALUE 'REJECTED' TO 'DECLINED';
  END IF;
END $$;

-- PostgreSQL cannot remove enum values such as EXPIRED in-place.
-- A full downgrade requiring that removal must recreate "GuarantorStatus"
-- after first moving any EXPIRED rows to DECLINED/PENDING.
