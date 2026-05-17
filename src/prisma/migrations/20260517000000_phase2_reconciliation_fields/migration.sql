ALTER TABLE "public"."Loan"
ADD COLUMN "disbursementFailureReason" TEXT;

ALTER TABLE "public"."MpesaTransaction"
ADD COLUMN "failureReason" TEXT;
