-- AlterTable
ALTER TABLE "public"."LoanProduct" ADD COLUMN     "maxGuarantors" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "minGuarantors" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "requiredAccountType" "public"."AccountType",
ADD COLUMN     "requiresPayslip" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "savingsMultiplier" SET DEFAULT 3.0000;
