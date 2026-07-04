-- CreateEnum
CREATE TYPE "public"."AccountStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "public"."JournalEntryStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'POSTED');

-- CreateEnum
CREATE TYPE "public"."JournalEntryType" AS ENUM ('MANUAL', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'FEE_CHARGE', 'FEE_REVERSAL', 'MPESA_DEPOSIT', 'INTEREST_ACCRUAL');

-- CreateEnum
CREATE TYPE "public"."GLAccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- AlterEnum
ALTER TYPE "public"."UserRole" ADD VALUE 'ACCOUNTANT';

-- DropIndex
DROP INDEX "public"."Transaction_reference_key";

-- DropIndex
DROP INDEX "public"."User_status_idx";

-- AlterTable
ALTER TABLE "public"."LoanProduct" ALTER COLUMN "maxGuarantors" SET DEFAULT 3,
ALTER COLUMN "minGuarantors" SET DEFAULT 2;

-- AlterTable
ALTER TABLE "public"."MpesaTransaction" ADD COLUMN     "referenceId" TEXT,
ADD COLUMN     "referenceType" TEXT;

-- AlterTable
ALTER TABLE "public"."SupportTicket" ADD COLUMN     "incidentId" TEXT,
ADD COLUMN     "resolutionDueAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."TicketMessage" ADD COLUMN     "tenantId" TEXT NOT NULL,
DROP COLUMN "senderRole",
ADD COLUMN     "senderRole" "public"."UserRole" NOT NULL;

-- AlterTable (Safe Data Casting)
ALTER TABLE "public"."User" ADD COLUMN "accountStatus" "public"."AccountStatus";

UPDATE "public"."User"
SET "accountStatus" = CASE 
    WHEN "status" = 'APPROVED' THEN 'ACTIVE'::"public"."AccountStatus"
    WHEN "status" = 'SUSPENDED' THEN 'SUSPENDED'::"public"."AccountStatus"
    WHEN "status" = 'REJECTED' THEN 'REJECTED'::"public"."AccountStatus"
    ELSE 'PENDING'::"public"."AccountStatus"
END;

ALTER TABLE "public"."User" ALTER COLUMN "accountStatus" SET NOT NULL,
ALTER COLUMN "accountStatus" SET DEFAULT 'PENDING';

ALTER TABLE "public"."User" DROP COLUMN "isActive",
DROP COLUMN "status";

-- DropEnum
DROP TYPE "public"."UserStatus";

-- CreateTable
CREATE TABLE "public"."Incident" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INVESTIGATING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InAppNotification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InAppNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TicketAttachment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "messageId" TEXT,
    "fileName" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GLAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "public"."GLAccountType" NOT NULL,
    "parentId" TEXT,
    "isSystemAccount" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GLAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JournalEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entryNumber" TEXT NOT NULL,
    "type" "public"."JournalEntryType" NOT NULL,
    "status" "public"."JournalEntryStatus" NOT NULL DEFAULT 'DRAFT',
    "description" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "totalAmount" DECIMAL(18,4) NOT NULL,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "rejectedById" TEXT,
    "approvalNotes" TEXT,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GLPosting" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "debitAccountId" TEXT,
    "creditAccountId" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "description" TEXT,
    "postingDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GLPosting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Incident_tenantId_status_idx" ON "public"."Incident"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Incident_tenantId_severity_idx" ON "public"."Incident"("tenantId", "severity");

-- CreateIndex
CREATE INDEX "Incident_tenantId_createdAt_idx" ON "public"."Incident"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "InAppNotification_tenantId_userId_isRead_idx" ON "public"."InAppNotification"("tenantId", "userId", "isRead");

-- CreateIndex
CREATE INDEX "InAppNotification_tenantId_userId_createdAt_idx" ON "public"."InAppNotification"("tenantId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "TicketAttachment_tenantId_ticketId_idx" ON "public"."TicketAttachment"("tenantId", "ticketId");

-- CreateIndex
CREATE INDEX "TicketAttachment_tenantId_messageId_idx" ON "public"."TicketAttachment"("tenantId", "messageId");

-- CreateIndex
CREATE INDEX "GLAccount_tenantId_idx" ON "public"."GLAccount"("tenantId");

-- CreateIndex
CREATE INDEX "GLAccount_tenantId_type_idx" ON "public"."GLAccount"("tenantId", "type");

-- CreateIndex
CREATE INDEX "GLAccount_tenantId_isActive_idx" ON "public"."GLAccount"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "GLAccount_tenantId_parentId_idx" ON "public"."GLAccount"("tenantId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "GLAccount_tenantId_code_key" ON "public"."GLAccount"("tenantId", "code");

-- CreateIndex
CREATE INDEX "JournalEntry_tenantId_status_idx" ON "public"."JournalEntry"("tenantId", "status");

-- CreateIndex
CREATE INDEX "JournalEntry_tenantId_type_idx" ON "public"."JournalEntry"("tenantId", "type");

-- CreateIndex
CREATE INDEX "JournalEntry_tenantId_status_createdAt_idx" ON "public"."JournalEntry"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "JournalEntry_tenantId_createdAt_idx" ON "public"."JournalEntry"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "JournalEntry_tenantId_createdById_idx" ON "public"."JournalEntry"("tenantId", "createdById");

-- CreateIndex
CREATE INDEX "JournalEntry_tenantId_approvedById_idx" ON "public"."JournalEntry"("tenantId", "approvedById");

-- CreateIndex
CREATE INDEX "JournalEntry_tenantId_rejectedById_idx" ON "public"."JournalEntry"("tenantId", "rejectedById");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_tenantId_entryNumber_key" ON "public"."JournalEntry"("tenantId", "entryNumber");

-- CreateIndex
CREATE INDEX "GLPosting_journalEntryId_idx" ON "public"."GLPosting"("journalEntryId");

-- CreateIndex
CREATE INDEX "GLPosting_debitAccountId_idx" ON "public"."GLPosting"("debitAccountId");

-- CreateIndex
CREATE INDEX "GLPosting_creditAccountId_idx" ON "public"."GLPosting"("creditAccountId");

-- CreateIndex
CREATE INDEX "Loan_tenantId_loanProductId_idx" ON "public"."Loan"("tenantId", "loanProductId");

-- CreateIndex
CREATE INDEX "MemberApplication_tenantId_wardId_idx" ON "public"."MemberApplication"("tenantId", "wardId");

-- CreateIndex
CREATE UNIQUE INDEX "MpesaTransaction_mpesaReceiptNumber_key" ON "public"."MpesaTransaction"("mpesaReceiptNumber");

-- CreateIndex
CREATE INDEX "SupportTicket_tenantId_status_updatedAt_idx" ON "public"."SupportTicket"("tenantId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "SupportTicket_tenantId_assignedTo_status_idx" ON "public"."SupportTicket"("tenantId", "assignedTo", "status");

-- CreateIndex
CREATE INDEX "SupportTicket_tenantId_category_status_idx" ON "public"."SupportTicket"("tenantId", "category", "status");

-- CreateIndex
CREATE INDEX "SupportTicket_tenantId_incidentId_idx" ON "public"."SupportTicket"("tenantId", "incidentId");

-- CreateIndex
CREATE INDEX "SupportTicket_tenantId_resolutionDueAt_idx" ON "public"."SupportTicket"("tenantId", "resolutionDueAt");

-- CreateIndex
CREATE INDEX "TicketMessage_tenantId_ticketId_createdAt_idx" ON "public"."TicketMessage"("tenantId", "ticketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_tenantId_reference_key" ON "public"."Transaction"("tenantId", "reference");

-- CreateIndex
CREATE INDEX "User_accountStatus_idx" ON "public"."User"("accountStatus");

-- AddForeignKey
ALTER TABLE "public"."SupportTicket" ADD CONSTRAINT "SupportTicket_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupportTicket" ADD CONSTRAINT "SupportTicket_relatedLoanId_fkey" FOREIGN KEY ("relatedLoanId") REFERENCES "public"."Loan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupportTicket" ADD CONSTRAINT "SupportTicket_relatedTxId_fkey" FOREIGN KEY ("relatedTxId") REFERENCES "public"."MpesaTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupportTicket" ADD CONSTRAINT "SupportTicket_assignedTo_fkey" FOREIGN KEY ("assignedTo") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupportTicket" ADD CONSTRAINT "SupportTicket_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "public"."Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TicketMessage" ADD CONSTRAINT "TicketMessage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TicketMessage" ADD CONSTRAINT "TicketMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TicketAttachment" ADD CONSTRAINT "TicketAttachment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TicketAttachment" ADD CONSTRAINT "TicketAttachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "public"."SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TicketAttachment" ADD CONSTRAINT "TicketAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."TicketMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GLAccount" ADD CONSTRAINT "GLAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GLAccount" ADD CONSTRAINT "GLAccount_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "public"."GLAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JournalEntry" ADD CONSTRAINT "JournalEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JournalEntry" ADD CONSTRAINT "JournalEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JournalEntry" ADD CONSTRAINT "JournalEntry_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JournalEntry" ADD CONSTRAINT "JournalEntry_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GLPosting" ADD CONSTRAINT "GLPosting_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "public"."JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GLPosting" ADD CONSTRAINT "GLPosting_debitAccountId_fkey" FOREIGN KEY ("debitAccountId") REFERENCES "public"."GLAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GLPosting" ADD CONSTRAINT "GLPosting_creditAccountId_fkey" FOREIGN KEY ("creditAccountId") REFERENCES "public"."GLAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

