-- Blacklist flag used until a dedicated MemberBlacklist table is introduced.
ALTER TABLE "public"."Member"
  ADD COLUMN IF NOT EXISTS "isBlacklisted" BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  CREATE TYPE "public"."TicketStatus" AS ENUM (
    'OPEN',
    'IN_PROGRESS',
    'WAITING_ON_MEMBER',
    'RESOLVED',
    'CLOSED'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."TicketPriority" AS ENUM (
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."TicketCategory" AS ENUM (
    'LOAN_QUERY',
    'MPESA_ISSUE',
    'ACCOUNT_ACCESS',
    'KYC_UPDATE',
    'GUARANTOR_DISPUTE',
    'GENERAL'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "public"."SupportTicket" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "status" "public"."TicketStatus" NOT NULL DEFAULT 'OPEN',
  "priority" "public"."TicketPriority" NOT NULL DEFAULT 'MEDIUM',
  "category" "public"."TicketCategory" NOT NULL DEFAULT 'GENERAL',
  "relatedLoanId" TEXT,
  "relatedTxId" TEXT,
  "assignedTo" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."TicketMessage" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "senderRole" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "attachments" TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SupportTicket_tenantId_memberId_idx"
  ON "public"."SupportTicket"("tenantId", "memberId");

CREATE INDEX IF NOT EXISTS "SupportTicket_tenantId_status_idx"
  ON "public"."SupportTicket"("tenantId", "status");

CREATE INDEX IF NOT EXISTS "TicketMessage_ticketId_idx"
  ON "public"."TicketMessage"("ticketId");

ALTER TABLE "public"."SupportTicket"
  ADD CONSTRAINT "SupportTicket_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "public"."Member"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."TicketMessage"
  ADD CONSTRAINT "TicketMessage_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "public"."SupportTicket"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
