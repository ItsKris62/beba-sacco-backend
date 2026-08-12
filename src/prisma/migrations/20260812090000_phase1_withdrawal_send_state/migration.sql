-- Phase 1 withdrawal safety: distinguish local payout rows from provider-submitted rows.
-- Existing rows remain NULL/unknown; no historical provider-send certainty is invented.
ALTER TABLE "public"."MpesaTransaction"
  ADD COLUMN "providerSubmissionState" TEXT,
  ADD COLUMN "providerSendAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "providerAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "providerLastCheckedAt" TIMESTAMP(3);

CREATE INDEX "MpesaTransaction_tenantId_providerSubmissionState_idx"
  ON "public"."MpesaTransaction"("tenantId", "providerSubmissionState");
