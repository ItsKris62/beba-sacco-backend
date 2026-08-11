-- Durable M-Pesa payout dispatch and callback inbox records.
-- These tables make BullMQ a replayable processor instead of the only source of truth.

ALTER TABLE "public"."MpesaTransaction"
  ADD COLUMN "reconciliationDueAt" TIMESTAMP(3),
  ADD COLUMN "lastRecoveryAt" TIMESTAMP(3);

CREATE TABLE "public"."MpesaPayoutIntent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "dispatchKey" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "referenceType" TEXT NOT NULL,
  "referenceId" TEXT NOT NULL,
  "sourceTransactionId" TEXT NOT NULL,
  "memberId" TEXT,
  "accountId" TEXT,
  "phoneNumber" TEXT NOT NULL,
  "amount" DECIMAL(18,4) NOT NULL,
  "triggeredBy" TEXT NOT NULL,
  "provider" TEXT,
  "status" "public"."OutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "nextRetryAt" TIMESTAMP(3),
  "dispatchedAt" TIMESTAMP(3),
  "deadLetteredAt" TIMESTAMP(3),
  "mpesaTransactionId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MpesaPayoutIntent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."MpesaCallbackInbox" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "callbackType" TEXT NOT NULL,
  "providerUniqueId" TEXT NOT NULL,
  "uniqueKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "rawBodySha256" TEXT,
  "correlationId" TEXT,
  "mpesaTransactionId" TEXT,
  "status" "public"."OutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "queueJobId" TEXT,
  "lastError" TEXT,
  "nextRetryAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MpesaCallbackInbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MpesaPayoutIntent_dispatchKey_key"
  ON "public"."MpesaPayoutIntent"("dispatchKey");
CREATE UNIQUE INDEX "MpesaPayoutIntent_jobId_key"
  ON "public"."MpesaPayoutIntent"("jobId");
CREATE UNIQUE INDEX "MpesaPayoutIntent_sourceTransactionId_key"
  ON "public"."MpesaPayoutIntent"("sourceTransactionId");
CREATE UNIQUE INDEX "MpesaPayoutIntent_mpesaTransactionId_key"
  ON "public"."MpesaPayoutIntent"("mpesaTransactionId");
CREATE INDEX "MpesaPayoutIntent_tenantId_idx"
  ON "public"."MpesaPayoutIntent"("tenantId");
CREATE INDEX "MpesaPayoutIntent_tenantId_status_nextRetryAt_idx"
  ON "public"."MpesaPayoutIntent"("tenantId", "status", "nextRetryAt");
CREATE INDEX "MpesaPayoutIntent_tenantId_referenceType_referenceId_idx"
  ON "public"."MpesaPayoutIntent"("tenantId", "referenceType", "referenceId");
CREATE INDEX "MpesaPayoutIntent_sourceTransactionId_idx"
  ON "public"."MpesaPayoutIntent"("sourceTransactionId");

CREATE UNIQUE INDEX "MpesaCallbackInbox_uniqueKey_key"
  ON "public"."MpesaCallbackInbox"("uniqueKey");
CREATE INDEX "MpesaCallbackInbox_tenantId_idx"
  ON "public"."MpesaCallbackInbox"("tenantId");
CREATE INDEX "MpesaCallbackInbox_tenantId_status_nextRetryAt_idx"
  ON "public"."MpesaCallbackInbox"("tenantId", "status", "nextRetryAt");
CREATE INDEX "MpesaCallbackInbox_callbackType_providerUniqueId_idx"
  ON "public"."MpesaCallbackInbox"("callbackType", "providerUniqueId");
CREATE INDEX "MpesaCallbackInbox_mpesaTransactionId_idx"
  ON "public"."MpesaCallbackInbox"("mpesaTransactionId");

CREATE INDEX "MpesaTransaction_tenantId_status_reconciliationDueAt_idx"
  ON "public"."MpesaTransaction"("tenantId", "status", "reconciliationDueAt");
