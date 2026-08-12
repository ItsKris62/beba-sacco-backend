-- Phase 2 withdrawal reconciliation metadata.
-- Non-destructive: existing M-Pesa rows keep their historical status and become
-- eligible only through explicit age/SLA logic.

ALTER TABLE "public"."MpesaTransaction"
  ADD COLUMN "reconciliationAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reconciliationNextRetryAt" TIMESTAMP(3),
  ADD COLUMN "reconciliationLockedAt" TIMESTAMP(3),
  ADD COLUMN "reconciliationLockedBy" TEXT,
  ADD COLUMN "manualReviewRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "manualReviewReason" TEXT,
  ADD COLUMN "reconciliationLastReason" TEXT;

CREATE INDEX "MpesaTransaction_tenantId_status_reconciliationNextRetryAt_idx"
  ON "public"."MpesaTransaction"("tenantId", "status", "reconciliationNextRetryAt");

CREATE INDEX "MpesaTransaction_tenantId_manualReviewRequired_idx"
  ON "public"."MpesaTransaction"("tenantId", "manualReviewRequired");

CREATE TABLE "public"."MpesaWithdrawalReconciliationAttempt" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "mpesaTransactionId" TEXT NOT NULL,
  "payoutIntentId" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'MWALONI',
  "attemptNumber" INTEGER NOT NULL,
  "triggerType" TEXT NOT NULL,
  "actorId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "providerRequestReference" TEXT,
  "providerResult" JSONB,
  "correlationResult" JSONB,
  "oldStatus" "public"."TransactionStatus",
  "newStatus" "public"."TransactionStatus",
  "reasonCode" TEXT,
  "errorCategory" TEXT,
  "nextRetryAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MpesaWithdrawalReconciliationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MpesaWithdrawalReconciliationAttempt_mpesaTransactionId_attemptNumber_key"
  ON "public"."MpesaWithdrawalReconciliationAttempt"("mpesaTransactionId", "attemptNumber");

CREATE INDEX "MpesaWithdrawalReconciliationAttempt_tenantId_idx"
  ON "public"."MpesaWithdrawalReconciliationAttempt"("tenantId");

CREATE INDEX "MpesaWithdrawalReconciliationAttempt_tenantId_triggerType_startedAt_idx"
  ON "public"."MpesaWithdrawalReconciliationAttempt"("tenantId", "triggerType", "startedAt");

CREATE INDEX "MpesaWithdrawalReconciliationAttempt_tenantId_reasonCode_idx"
  ON "public"."MpesaWithdrawalReconciliationAttempt"("tenantId", "reasonCode");

CREATE INDEX "MpesaWithdrawalReconciliationAttempt_tenantId_nextRetryAt_idx"
  ON "public"."MpesaWithdrawalReconciliationAttempt"("tenantId", "nextRetryAt");

ALTER TABLE "public"."MpesaWithdrawalReconciliationAttempt"
  ADD CONSTRAINT "MpesaWithdrawalReconciliationAttempt_mpesaTransactionId_fkey"
  FOREIGN KEY ("mpesaTransactionId") REFERENCES "public"."MpesaTransaction"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
