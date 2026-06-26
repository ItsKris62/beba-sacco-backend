-- CreateEnum
CREATE TYPE "public"."InstallmentStatus" AS ENUM ('PENDING', 'PARTIAL', 'PAID', 'OVERDUE', 'WAIVED');

-- Account guarantor-liability holds
ALTER TABLE "public"."Account"
ADD COLUMN "frozenSavings" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- Installment canonical due date and status hardening
UPDATE "public"."LoanRepayment"
SET "dueDate" = "paymentDate"
WHERE "dueDate" IS NULL;

ALTER TABLE "public"."LoanRepayment"
ADD COLUMN "lastPenaltyAccrualDate" TIMESTAMP(3);

ALTER TABLE "public"."LoanRepayment"
ALTER COLUMN "dueDate" SET NOT NULL;

ALTER TABLE "public"."LoanRepayment"
ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "public"."LoanRepayment"
ALTER COLUMN "status" TYPE "public"."InstallmentStatus"
USING (
  CASE
    WHEN "status" = 'CONFIRMED' THEN 'PAID'
    WHEN "status" IN ('PENDING', 'PARTIAL', 'PAID', 'OVERDUE', 'WAIVED') THEN "status"
    ELSE 'PENDING'
  END
)::"public"."InstallmentStatus";

ALTER TABLE "public"."LoanRepayment"
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- Job scan indexes
CREATE INDEX "Account_tenantId_memberId_accountType_isActive_idx"
ON "public"."Account"("tenantId", "memberId", "accountType", "isActive");

CREATE INDEX "Loan_tenantId_staging_arrearsDays_idx"
ON "public"."Loan"("tenantId", "staging", "arrearsDays");

CREATE INDEX "LoanRepayment_tenantId_status_dueDate_idx"
ON "public"."LoanRepayment"("tenantId", "status", "dueDate");
