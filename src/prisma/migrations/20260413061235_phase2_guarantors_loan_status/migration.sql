-- CreateEnum
CREATE TYPE "public"."GuarantorStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."LoanStatus" ADD VALUE 'PENDING_GUARANTORS';
ALTER TYPE "public"."LoanStatus" ADD VALUE 'UNDER_REVIEW';
ALTER TYPE "public"."LoanStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "public"."Loan" ADD COLUMN     "purpose" TEXT;

-- CreateTable
CREATE TABLE "public"."Guarantor" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "status" "public"."GuarantorStatus" NOT NULL DEFAULT 'PENDING',
    "guaranteedAmount" DECIMAL(18,4) NOT NULL,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Guarantor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Guarantor_tenantId_memberId_idx" ON "public"."Guarantor"("tenantId", "memberId");

-- CreateIndex
CREATE INDEX "Guarantor_loanId_idx" ON "public"."Guarantor"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "Guarantor_loanId_memberId_key" ON "public"."Guarantor"("loanId", "memberId");

-- AddForeignKey
ALTER TABLE "public"."Guarantor" ADD CONSTRAINT "Guarantor_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Guarantor" ADD CONSTRAINT "Guarantor_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "public"."Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Guarantor" ADD CONSTRAINT "Guarantor_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "public"."Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
