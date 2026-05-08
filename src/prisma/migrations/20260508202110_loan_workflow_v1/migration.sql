-- AlterTable
ALTER TABLE "public"."Account" ADD COLUMN     "lockedBalance" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."LoanProduct" ADD COLUMN     "minActiveMonths" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "savingsMultiplier" DECIMAL(7,4);

-- AlterTable
ALTER TABLE "public"."ReportJob" ALTER COLUMN "updatedAt" DROP DEFAULT;
