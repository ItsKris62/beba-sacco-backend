-- Tier 3: Add accruedInterest + repaymentScheduleGenerated to Loan,
--         and add FK relation from LoanRepayment to Loan.

-- AddColumn
ALTER TABLE "Loan" ADD COLUMN "accruedInterest" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- AddColumn
ALTER TABLE "Loan" ADD COLUMN "repaymentScheduleGenerated" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey (loanId already exists in LoanRepayment; add the constraint)
ALTER TABLE "LoanRepayment" ADD CONSTRAINT "LoanRepayment_loanId_fkey"
  FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
