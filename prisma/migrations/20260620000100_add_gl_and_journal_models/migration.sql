-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "public"."JournalEntryStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'POSTED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "public"."JournalEntryType" AS ENUM ('MANUAL', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'FEE_CHARGE', 'FEE_REVERSAL', 'MPESA_DEPOSIT', 'INTEREST_ACCRUAL');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "public"."GLAccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."GLAccount" (
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
CREATE TABLE IF NOT EXISTS "public"."JournalEntry" (
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
CREATE TABLE IF NOT EXISTS "public"."GLPosting" (
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
CREATE INDEX IF NOT EXISTS "GLAccount_tenantId_idx" ON "public"."GLAccount"("tenantId");
CREATE INDEX IF NOT EXISTS "GLAccount_tenantId_type_idx" ON "public"."GLAccount"("tenantId", "type");
CREATE INDEX IF NOT EXISTS "GLAccount_tenantId_isActive_idx" ON "public"."GLAccount"("tenantId", "isActive");
CREATE UNIQUE INDEX IF NOT EXISTS "GLAccount_tenantId_code_key" ON "public"."GLAccount"("tenantId", "code");

CREATE INDEX IF NOT EXISTS "JournalEntry_tenantId_status_idx" ON "public"."JournalEntry"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "JournalEntry_tenantId_type_idx" ON "public"."JournalEntry"("tenantId", "type");
CREATE INDEX IF NOT EXISTS "JournalEntry_tenantId_status_createdAt_idx" ON "public"."JournalEntry"("tenantId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "JournalEntry_tenantId_createdAt_idx" ON "public"."JournalEntry"("tenantId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "JournalEntry_tenantId_entryNumber_key" ON "public"."JournalEntry"("tenantId", "entryNumber");

CREATE INDEX IF NOT EXISTS "GLPosting_journalEntryId_idx" ON "public"."GLPosting"("journalEntryId");
CREATE INDEX IF NOT EXISTS "GLPosting_debitAccountId_idx" ON "public"."GLPosting"("debitAccountId");
CREATE INDEX IF NOT EXISTS "GLPosting_creditAccountId_idx" ON "public"."GLPosting"("creditAccountId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "public"."GLAccount" ADD CONSTRAINT "GLAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."GLAccount" ADD CONSTRAINT "GLAccount_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "public"."GLAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."JournalEntry" ADD CONSTRAINT "JournalEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."JournalEntry" ADD CONSTRAINT "JournalEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."JournalEntry" ADD CONSTRAINT "JournalEntry_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."JournalEntry" ADD CONSTRAINT "JournalEntry_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."GLPosting" ADD CONSTRAINT "GLPosting_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "public"."JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."GLPosting" ADD CONSTRAINT "GLPosting_debitAccountId_fkey" FOREIGN KEY ("debitAccountId") REFERENCES "public"."GLAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "public"."GLPosting" ADD CONSTRAINT "GLPosting_creditAccountId_fkey" FOREIGN KEY ("creditAccountId") REFERENCES "public"."GLAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;