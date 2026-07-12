CREATE TABLE "public"."LoanArrearsSnapshot" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "loanId" TEXT NOT NULL,
  "snapshotDate" DATE NOT NULL,
  "arrearsDays" INTEGER NOT NULL,
  "staging" "public"."LoanStaging" NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LoanArrearsSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LoanArrearsSnapshot_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LoanArrearsSnapshot_loanId_fkey"
    FOREIGN KEY ("loanId") REFERENCES "public"."Loan"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "LoanArrearsSnapshot_tenantId_loanId_snapshotDate_key"
  ON "public"."LoanArrearsSnapshot"("tenantId", "loanId", "snapshotDate");

CREATE INDEX "LoanArrearsSnapshot_tenantId_snapshotDate_idx"
  ON "public"."LoanArrearsSnapshot"("tenantId", "snapshotDate");

CREATE INDEX "LoanArrearsSnapshot_tenantId_snapshotDate_staging_idx"
  ON "public"."LoanArrearsSnapshot"("tenantId", "snapshotDate", "staging");

CREATE INDEX "LoanArrearsSnapshot_loanId_snapshotDate_idx"
  ON "public"."LoanArrearsSnapshot"("loanId", "snapshotDate");
