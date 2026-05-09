-- Product-specific loan rules engine.
-- Idempotent because an earlier generated migration may already have applied
-- part of this additive schema on some environments.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'LoanProduct'
      AND column_name = 'requiredAccountType'
  ) THEN
    ALTER TABLE "public"."LoanProduct"
      ADD COLUMN "requiredAccountType" "public"."AccountType";
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'LoanProduct'
      AND column_name = 'savingsMultiplier'
  ) THEN
    ALTER TABLE "public"."LoanProduct"
      ADD COLUMN "savingsMultiplier" DECIMAL(7,4) DEFAULT 3.0000;
  ELSE
    ALTER TABLE "public"."LoanProduct"
      ALTER COLUMN "savingsMultiplier" SET DEFAULT 3.0000;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'LoanProduct'
      AND column_name = 'minGuarantors'
  ) THEN
    ALTER TABLE "public"."LoanProduct"
      ADD COLUMN "minGuarantors" INTEGER NOT NULL DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'LoanProduct'
      AND column_name = 'maxGuarantors'
  ) THEN
    ALTER TABLE "public"."LoanProduct"
      ADD COLUMN "maxGuarantors" INTEGER NOT NULL DEFAULT 5;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'LoanProduct'
      AND column_name = 'requiresPayslip'
  ) THEN
    ALTER TABLE "public"."LoanProduct"
      ADD COLUMN "requiresPayslip" BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

UPDATE "public"."LoanProduct"
SET "savingsMultiplier" = 3.0000
WHERE "savingsMultiplier" IS NULL;

ALTER TABLE "public"."LoanProduct"
  ALTER COLUMN "savingsMultiplier" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "LoanProduct_tenantId_idx"
  ON "public"."LoanProduct"("tenantId");
