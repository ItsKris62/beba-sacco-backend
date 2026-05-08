DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'GuarantorStatus' AND e.enumlabel = 'DECLINED'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'GuarantorStatus' AND e.enumlabel = 'REJECTED'
  ) THEN
    ALTER TYPE "public"."GuarantorStatus" RENAME VALUE 'DECLINED' TO 'REJECTED';
  END IF;
END $$;

ALTER TYPE "public"."GuarantorStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

ALTER TABLE "public"."Guarantor"
  ADD COLUMN IF NOT EXISTS "auditMetadata" JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS "Guarantor_tenantId_loanId_memberId_key"
  ON "public"."Guarantor"("tenantId", "loanId", "memberId");

CREATE INDEX IF NOT EXISTS "Guarantor_tenantId_loanId_status_idx"
  ON "public"."Guarantor"("tenantId", "loanId", "status");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReportType') THEN
    CREATE TYPE "public"."ReportType" AS ENUM ('LOAN_BOOK', 'MEMBER_BALANCES', 'AUDIT_TRAIL', 'EXECUTIVE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReportFormat') THEN
    CREATE TYPE "public"."ReportFormat" AS ENUM ('CSV', 'PDF');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReportStatus') THEN
    CREATE TYPE "public"."ReportStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "public"."ReportJob" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "requestedBy" TEXT,
  "type" "public"."ReportType" NOT NULL,
  "format" "public"."ReportFormat" NOT NULL,
  "status" "public"."ReportStatus" NOT NULL DEFAULT 'QUEUED',
  "filters" JSONB,
  "objectKey" VARCHAR(500),
  "errorMessage" TEXT,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ReportJob_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ReportJob_tenantId_fkey'
  ) THEN
    ALTER TABLE "public"."ReportJob"
      ADD CONSTRAINT "ReportJob_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ReportJob_requestedBy_fkey'
  ) THEN
    ALTER TABLE "public"."ReportJob"
      ADD CONSTRAINT "ReportJob_requestedBy_fkey"
      FOREIGN KEY ("requestedBy") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ReportJob_tenantId_status_idx"
  ON "public"."ReportJob"("tenantId", "status");

CREATE INDEX IF NOT EXISTS "ReportJob_tenantId_requestedBy_createdAt_idx"
  ON "public"."ReportJob"("tenantId", "requestedBy", "createdAt");
