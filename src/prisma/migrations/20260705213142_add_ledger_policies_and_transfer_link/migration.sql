-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."JournalEntryType" ADD VALUE 'DEPOSIT';
ALTER TYPE "public"."JournalEntryType" ADD VALUE 'WITHDRAWAL';
ALTER TYPE "public"."JournalEntryType" ADD VALUE 'TRANSFER';
ALTER TYPE "public"."JournalEntryType" ADD VALUE 'DIVIDEND_PAYOUT';

-- AlterTable
ALTER TABLE "public"."Account" ADD COLUMN     "allowsNegative" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "minimumBalance" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."Transaction" ADD COLUMN     "linkedTransactionId" TEXT;

-- CreateTable
CREATE TABLE "public"."AccountTypePolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountType" "public"."AccountType" NOT NULL,
    "minimumBalance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "allowsNegative" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountTypePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountTypePolicy_tenantId_idx" ON "public"."AccountTypePolicy"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountTypePolicy_tenantId_accountType_key" ON "public"."AccountTypePolicy"("tenantId", "accountType");

-- CreateIndex
CREATE INDEX "Transaction_linkedTransactionId_idx" ON "public"."Transaction"("linkedTransactionId");

-- AddForeignKey
ALTER TABLE "public"."AccountTypePolicy" ADD CONSTRAINT "AccountTypePolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Transaction" ADD CONSTRAINT "Transaction_linkedTransactionId_fkey" FOREIGN KEY ("linkedTransactionId") REFERENCES "public"."Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
