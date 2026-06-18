-- Production repayment waterfall support.
ALTER TABLE "public"."LoanRepayment"
  ADD COLUMN IF NOT EXISTS "dueDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "principalDue" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "interestDue" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "penaltyDue" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "principalPaid" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "interestPaid" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "penaltyPaid" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "LoanRepayment_tenantId_paymentDate_status_idx"
  ON "public"."LoanRepayment"("tenantId", "paymentDate", "status");
