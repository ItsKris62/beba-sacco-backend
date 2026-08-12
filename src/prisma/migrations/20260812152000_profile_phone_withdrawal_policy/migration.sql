-- Temporary withdrawal phone policy:
-- any member with a profile phone can withdraw to that profile phone.
-- Missing-phone members are still blocked by MemberPortalService.
UPDATE "User"
SET "phoneVerified" = true
WHERE ("phone" IS NOT NULL OR "phoneNumber" IS NOT NULL);

ALTER TABLE "User"
ALTER COLUMN "phoneVerified" SET DEFAULT true;
