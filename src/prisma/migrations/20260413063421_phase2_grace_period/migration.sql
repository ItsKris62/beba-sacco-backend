-- AlterTable
ALTER TABLE "public"."Loan" ADD COLUMN     "gracePeriodMonths" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."LoanProduct" ADD COLUMN     "gracePeriodMonths" INTEGER NOT NULL DEFAULT 0;
