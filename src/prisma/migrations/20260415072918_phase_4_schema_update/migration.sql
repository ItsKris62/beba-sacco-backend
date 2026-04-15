-- CreateEnum
CREATE TYPE "public"."LoanStaging" AS ENUM ('PERFORMING', 'WATCHLIST', 'NPL');

-- CreateEnum
CREATE TYPE "public"."ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."WebhookStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "public"."WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- AlterEnum
ALTER TYPE "public"."TransactionStatus" ADD VALUE 'RECON_PENDING';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."TransactionType" ADD VALUE 'INTEREST_ACCRUAL';
ALTER TYPE "public"."TransactionType" ADD VALUE 'PENALTY';

-- AlterTable
ALTER TABLE "public"."AuditLog" ADD COLUMN     "entryHash" TEXT,
ADD COLUMN     "prevHash" TEXT;

-- AlterTable
ALTER TABLE "public"."Loan" ADD COLUMN     "arrearsAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "arrearsDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastAccrualDate" TIMESTAMP(3),
ADD COLUMN     "staging" "public"."LoanStaging" NOT NULL DEFAULT 'PERFORMING';

-- AlterTable
ALTER TABLE "public"."Member" ADD COLUMN     "consentDataSharing" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "consentUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "public"."LoanApprovalChain" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" "public"."ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanApprovalChain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LoginSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "geoHint" TEXT,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LoginSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WebhookSubscription" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[],
    "status" "public"."WebhookStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WebhookDelivery" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "public"."WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "httpStatus" INTEGER,
    "responseBody" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoanApprovalChain_tenantId_loanId_idx" ON "public"."LoanApprovalChain"("tenantId", "loanId");

-- CreateIndex
CREATE INDEX "LoginSession_tenantId_userId_idx" ON "public"."LoginSession"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "LoginSession_ipHash_idx" ON "public"."LoginSession"("ipHash");

-- CreateIndex
CREATE INDEX "WebhookSubscription_tenantId_idx" ON "public"."WebhookSubscription"("tenantId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_subscriptionId_idx" ON "public"."WebhookDelivery"("subscriptionId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_idx" ON "public"."WebhookDelivery"("status");

-- CreateIndex
CREATE INDEX "Loan_tenantId_staging_idx" ON "public"."Loan"("tenantId", "staging");

-- AddForeignKey
ALTER TABLE "public"."LoanApprovalChain" ADD CONSTRAINT "LoanApprovalChain_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "public"."Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "public"."WebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
