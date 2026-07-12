-- Add an explicit expiry for administrator-issued temporary passwords.
-- Staff onboarding uses a maximum validity window of 24 hours.
ALTER TABLE "public"."User"
ADD COLUMN "tempPasswordExpiresAt" TIMESTAMP(3);
