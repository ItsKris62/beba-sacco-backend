-- CreateIndex
-- Speeds up the ledger-integrity GL-bypass check (LedgerIntegrityProcessor /
-- FinancialService.runLedgerIntegrityCheck): a NOT EXISTS anti-join from
-- Transaction to JournalEntry on (tenantId, referenceType, referenceId).
CREATE INDEX "JournalEntry_tenantId_referenceType_referenceId_idx" ON "public"."JournalEntry"("tenantId", "referenceType", "referenceId");
