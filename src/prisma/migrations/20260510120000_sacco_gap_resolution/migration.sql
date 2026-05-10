-- Canonicalize loan review status and add KYC review metadata.
-- Rollback note: recreate UNDER_REVIEW in LoanStatus and reverse the UPDATE if
-- you must restore the legacy enum value.

ALTER TABLE "public"."Loan" ALTER COLUMN "status" DROP DEFAULT;

ALTER TYPE "public"."LoanStatus" RENAME TO "LoanStatus_old";

CREATE TYPE "public"."LoanStatus" AS ENUM (
  'DRAFT',
  'PENDING_GUARANTORS',
  'PENDING_REVIEW',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'REJECTED_GUARANTOR_DECLINE',
  'DISBURSED',
  'ACTIVE',
  'FULLY_PAID',
  'DEFAULTED',
  'WRITTEN_OFF'
);

ALTER TABLE "public"."Loan"
  ALTER COLUMN "status" TYPE "public"."LoanStatus"
  USING (
    CASE
      WHEN "status"::text = 'UNDER_REVIEW' THEN 'PENDING_REVIEW'
      ELSE "status"::text
    END
  )::"public"."LoanStatus";

ALTER TABLE "public"."Loan" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

DROP TYPE "public"."LoanStatus_old";

ALTER TABLE "public"."Member"
  ADD COLUMN IF NOT EXISTS "kycDocumentUrls" JSONB,
  ADD COLUMN IF NOT EXISTS "kycChecklist" JSONB,
  ADD COLUMN IF NOT EXISTS "kycReviewNotes" TEXT;
