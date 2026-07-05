-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "backupCodes" TEXT[],
ADD COLUMN     "totpEnrolledAt" TIMESTAMP(3),
ADD COLUMN     "totpSecret" TEXT,
ADD COLUMN     "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;
