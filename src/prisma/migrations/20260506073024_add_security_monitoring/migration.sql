/*
  Warnings:

  - You are about to drop the column `userStatus` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."User" DROP COLUMN "userStatus",
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "public"."FailedLoginAttempt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "FailedLoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BlockedIP" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "blockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "BlockedIP_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FailedLoginAttempt_tenantId_ipAddress_idx" ON "public"."FailedLoginAttempt"("tenantId", "ipAddress");

-- CreateIndex
CREATE INDEX "FailedLoginAttempt_lastAttemptAt_idx" ON "public"."FailedLoginAttempt"("lastAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "FailedLoginAttempt_tenantId_ipAddress_username_key" ON "public"."FailedLoginAttempt"("tenantId", "ipAddress", "username");

-- CreateIndex
CREATE INDEX "BlockedIP_tenantId_isActive_idx" ON "public"."BlockedIP"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "BlockedIP_ipAddress_idx" ON "public"."BlockedIP"("ipAddress");

-- CreateIndex
CREATE UNIQUE INDEX "BlockedIP_tenantId_ipAddress_key" ON "public"."BlockedIP"("tenantId", "ipAddress");
