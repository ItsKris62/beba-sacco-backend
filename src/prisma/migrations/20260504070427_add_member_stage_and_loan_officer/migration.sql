/*
  Warnings:

  - A unique constraint covering the columns `[tenantId,email]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "public"."UserRole" ADD VALUE 'LOAN_OFFICER';

-- DropIndex
DROP INDEX "public"."User_email_key";

-- AlterTable
ALTER TABLE "public"."Account" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "public"."MemberStage" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "assignedBy" TEXT,

    CONSTRAINT "MemberStage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemberStage_memberId_idx" ON "public"."MemberStage"("memberId");

-- CreateIndex
CREATE INDEX "MemberStage_stageId_idx" ON "public"."MemberStage"("stageId");

-- CreateIndex
CREATE INDEX "MemberStage_isActive_idx" ON "public"."MemberStage"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "MemberStage_memberId_stageId_key" ON "public"."MemberStage"("memberId", "stageId");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_email_key" ON "public"."User"("tenantId", "email");

-- AddForeignKey
ALTER TABLE "public"."MemberStage" ADD CONSTRAINT "MemberStage_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "public"."Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemberStage" ADD CONSTRAINT "MemberStage_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "public"."Stage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
