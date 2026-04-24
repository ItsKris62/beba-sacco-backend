/*
  Warnings:

  - A unique constraint covering the columns `[conversationId]` on the table `MpesaTransaction` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[originatorConversationId]` on the table `MpesaTransaction` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[reference]` on the table `MpesaTransaction` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[idNumber]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[phoneNumber]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `reference` to the `MpesaTransaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `triggerSource` to the `MpesaTransaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `type` to the `MpesaTransaction` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "public"."MpesaTxType" AS ENUM ('STK_PUSH', 'C2B', 'B2C');

-- CreateEnum
CREATE TYPE "public"."MpesaTriggerSource" AS ENUM ('MEMBER', 'SYSTEM', 'OFFICER');

-- CreateEnum
CREATE TYPE "public"."ImportJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "public"."ApplicationStatus" AS ENUM ('SUBMITTED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."StagePosition" AS ENUM ('CHAIRMAN', 'SECRETARY', 'TREASURER', 'MEMBER');

-- CreateEnum
CREATE TYPE "public"."SavingsType" AS ENUM ('INDIVIDUAL', 'GROUP_WELFARE');

-- AlterTable
ALTER TABLE "public"."MpesaTransaction" ADD COLUMN     "accountReference" TEXT,
ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "loanId" TEXT,
ADD COLUMN     "loanRepaymentId" TEXT,
ADD COLUMN     "memberId" TEXT,
ADD COLUMN     "originatorConversationId" TEXT,
ADD COLUMN     "reference" TEXT NOT NULL,
ADD COLUMN     "transactionDate" TIMESTAMP(3),
ADD COLUMN     "triggerSource" "public"."MpesaTriggerSource" NOT NULL,
ADD COLUMN     "type" "public"."MpesaTxType" NOT NULL,
ALTER COLUMN "checkoutRequestId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "idNumber" TEXT,
ADD COLUMN     "importBatchId" TEXT,
ADD COLUMN     "legacyMemberNo" TEXT,
ADD COLUMN     "nextOfKinPhone" TEXT,
ADD COLUMN     "passwordResetExpiry" TIMESTAMP(3),
ADD COLUMN     "passwordResetToken" TEXT,
ADD COLUMN     "phoneNumber" TEXT,
ADD COLUMN     "userStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "wardId" TEXT;

-- CreateTable
CREATE TABLE "public"."County" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "County_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Constituency" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "countyId" TEXT NOT NULL,

    CONSTRAINT "Constituency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Ward" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "constituencyId" TEXT NOT NULL,

    CONSTRAINT "Ward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MemberApplication" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "idNumber" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "stageName" TEXT NOT NULL,
    "position" TEXT NOT NULL DEFAULT 'MEMBER',
    "wardId" TEXT NOT NULL,
    "status" "public"."ApplicationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "documentUrl" TEXT,
    "reviewedBy" TEXT,
    "reviewNotes" TEXT,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Stage" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "wardId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StageAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "position" "public"."StagePosition" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "StageAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LoanRepayment" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "dayNumber" INTEGER NOT NULL,
    "amountPaid" DECIMAL(10,2) NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'CASH',
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "recordedBy" TEXT,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanRepayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SavingsRecord" (
    "id" TEXT NOT NULL,
    "memberId" TEXT,
    "groupId" TEXT,
    "weekNumber" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "periodDate" TIMESTAMP(3) NOT NULL,
    "recordType" "public"."SavingsType" NOT NULL,
    "tenantId" TEXT NOT NULL,
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavingsRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GroupWelfare" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "weeklyTarget" DECIMAL(10,2) NOT NULL DEFAULT 300,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupWelfare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GroupWelfareCollection" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "weekNumber" INTEGER NOT NULL,
    "amountCollected" DECIMAL(10,2) NOT NULL,
    "periodDate" TIMESTAMP(3) NOT NULL,
    "deficit" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupWelfareCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RefreshSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "isRevoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DataConsent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "consentType" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0',
    "acceptedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "userAgent" TEXT,

    CONSTRAINT "DataConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DataImportLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "initiatedBy" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "status" "public"."ImportJobStatus" NOT NULL DEFAULT 'QUEUED',
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "errorDetails" JSONB,
    "reportData" JSONB,
    "queueJobId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataImportLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "County_code_key" ON "public"."County"("code");

-- CreateIndex
CREATE INDEX "County_code_idx" ON "public"."County"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Constituency_code_key" ON "public"."Constituency"("code");

-- CreateIndex
CREATE INDEX "Constituency_countyId_idx" ON "public"."Constituency"("countyId");

-- CreateIndex
CREATE UNIQUE INDEX "Ward_code_key" ON "public"."Ward"("code");

-- CreateIndex
CREATE INDEX "Ward_constituencyId_idx" ON "public"."Ward"("constituencyId");

-- CreateIndex
CREATE INDEX "MemberApplication_tenantId_idx" ON "public"."MemberApplication"("tenantId");

-- CreateIndex
CREATE INDEX "MemberApplication_tenantId_status_idx" ON "public"."MemberApplication"("tenantId", "status");

-- CreateIndex
CREATE INDEX "MemberApplication_idNumber_idx" ON "public"."MemberApplication"("idNumber");

-- CreateIndex
CREATE INDEX "MemberApplication_phoneNumber_idx" ON "public"."MemberApplication"("phoneNumber");

-- CreateIndex
CREATE INDEX "Stage_tenantId_idx" ON "public"."Stage"("tenantId");

-- CreateIndex
CREATE INDEX "Stage_wardId_idx" ON "public"."Stage"("wardId");

-- CreateIndex
CREATE UNIQUE INDEX "Stage_name_wardId_tenantId_key" ON "public"."Stage"("name", "wardId", "tenantId");

-- CreateIndex
CREATE INDEX "StageAssignment_stageId_idx" ON "public"."StageAssignment"("stageId");

-- CreateIndex
CREATE INDEX "StageAssignment_userId_idx" ON "public"."StageAssignment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StageAssignment_userId_stageId_key" ON "public"."StageAssignment"("userId", "stageId");

-- CreateIndex
CREATE INDEX "LoanRepayment_tenantId_loanId_idx" ON "public"."LoanRepayment"("tenantId", "loanId");

-- CreateIndex
CREATE INDEX "LoanRepayment_tenantId_idx" ON "public"."LoanRepayment"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LoanRepayment_loanId_dayNumber_tenantId_key" ON "public"."LoanRepayment"("loanId", "dayNumber", "tenantId");

-- CreateIndex
CREATE INDEX "SavingsRecord_tenantId_idx" ON "public"."SavingsRecord"("tenantId");

-- CreateIndex
CREATE INDEX "SavingsRecord_tenantId_memberId_idx" ON "public"."SavingsRecord"("tenantId", "memberId");

-- CreateIndex
CREATE INDEX "SavingsRecord_tenantId_groupId_idx" ON "public"."SavingsRecord"("tenantId", "groupId");

-- CreateIndex
CREATE INDEX "GroupWelfare_tenantId_idx" ON "public"."GroupWelfare"("tenantId");

-- CreateIndex
CREATE INDEX "GroupWelfare_stageId_idx" ON "public"."GroupWelfare"("stageId");

-- CreateIndex
CREATE INDEX "GroupWelfareCollection_tenantId_idx" ON "public"."GroupWelfareCollection"("tenantId");

-- CreateIndex
CREATE INDEX "GroupWelfareCollection_groupId_idx" ON "public"."GroupWelfareCollection"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupWelfareCollection_groupId_weekNumber_tenantId_key" ON "public"."GroupWelfareCollection"("groupId", "weekNumber", "tenantId");

-- CreateIndex
CREATE INDEX "RefreshSession_userId_expiresAt_idx" ON "public"."RefreshSession"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "RefreshSession_userId_idx" ON "public"."RefreshSession"("userId");

-- CreateIndex
CREATE INDEX "DataConsent_userId_idx" ON "public"."DataConsent"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DataConsent_userId_consentType_version_key" ON "public"."DataConsent"("userId", "consentType", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DataImportLog_batchId_key" ON "public"."DataImportLog"("batchId");

-- CreateIndex
CREATE INDEX "DataImportLog_tenantId_idx" ON "public"."DataImportLog"("tenantId");

-- CreateIndex
CREATE INDEX "DataImportLog_tenantId_status_idx" ON "public"."DataImportLog"("tenantId", "status");

-- CreateIndex
CREATE INDEX "DataImportLog_batchId_idx" ON "public"."DataImportLog"("batchId");

-- CreateIndex
CREATE INDEX "DataImportLog_initiatedBy_idx" ON "public"."DataImportLog"("initiatedBy");

-- CreateIndex
CREATE UNIQUE INDEX "MpesaTransaction_conversationId_key" ON "public"."MpesaTransaction"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "MpesaTransaction_originatorConversationId_key" ON "public"."MpesaTransaction"("originatorConversationId");

-- CreateIndex
CREATE UNIQUE INDEX "MpesaTransaction_reference_key" ON "public"."MpesaTransaction"("reference");

-- CreateIndex
CREATE INDEX "MpesaTransaction_tenantId_memberId_idx" ON "public"."MpesaTransaction"("tenantId", "memberId");

-- CreateIndex
CREATE INDEX "MpesaTransaction_tenantId_loanId_idx" ON "public"."MpesaTransaction"("tenantId", "loanId");

-- CreateIndex
CREATE INDEX "MpesaTransaction_tenantId_status_idx" ON "public"."MpesaTransaction"("tenantId", "status");

-- CreateIndex
CREATE INDEX "MpesaTransaction_tenantId_type_idx" ON "public"."MpesaTransaction"("tenantId", "type");

-- CreateIndex
CREATE INDEX "MpesaTransaction_conversationId_idx" ON "public"."MpesaTransaction"("conversationId");

-- CreateIndex
CREATE INDEX "MpesaTransaction_reference_idx" ON "public"."MpesaTransaction"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "User_idNumber_key" ON "public"."User"("idNumber");

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneNumber_key" ON "public"."User"("phoneNumber");

-- CreateIndex
CREATE INDEX "User_idNumber_idx" ON "public"."User"("idNumber");

-- CreateIndex
CREATE INDEX "User_importBatchId_idx" ON "public"."User"("importBatchId");

-- AddForeignKey
ALTER TABLE "public"."Constituency" ADD CONSTRAINT "Constituency_countyId_fkey" FOREIGN KEY ("countyId") REFERENCES "public"."County"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Ward" ADD CONSTRAINT "Ward_constituencyId_fkey" FOREIGN KEY ("constituencyId") REFERENCES "public"."Constituency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemberApplication" ADD CONSTRAINT "MemberApplication_wardId_fkey" FOREIGN KEY ("wardId") REFERENCES "public"."Ward"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Stage" ADD CONSTRAINT "Stage_wardId_fkey" FOREIGN KEY ("wardId") REFERENCES "public"."Ward"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StageAssignment" ADD CONSTRAINT "StageAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StageAssignment" ADD CONSTRAINT "StageAssignment_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "public"."Stage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GroupWelfareCollection" ADD CONSTRAINT "GroupWelfareCollection_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "public"."GroupWelfare"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DataImportLog" ADD CONSTRAINT "DataImportLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
