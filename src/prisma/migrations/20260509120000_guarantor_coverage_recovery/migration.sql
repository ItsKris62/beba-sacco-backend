ALTER TABLE "LoanProduct"
  ADD COLUMN IF NOT EXISTS "guarantorCoverageRatio" DECIMAL(7, 4) NOT NULL DEFAULT 1.0;

ALTER TABLE "Guarantor"
  ADD COLUMN IF NOT EXISTS "recoveredAmount" DECIMAL(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "recoveryDate" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Guarantor_tenantId_status_idx"
  ON "Guarantor"("tenantId", "status");
