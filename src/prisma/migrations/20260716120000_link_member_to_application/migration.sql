-- Link Member to the MemberApplication it was onboarded from. Nullable — members
-- created before this migration, or via any path outside the applications flow,
-- have no source application. Backfilled for existing rows by
-- src/database/scripts/backfill-member-applications.ts.
-- AlterTable
ALTER TABLE "public"."Member" ADD COLUMN     "memberApplicationId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Member_memberApplicationId_key" ON "public"."Member"("memberApplicationId");

-- AddForeignKey
ALTER TABLE "public"."Member" ADD CONSTRAINT "Member_memberApplicationId_fkey" FOREIGN KEY ("memberApplicationId") REFERENCES "public"."MemberApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;
