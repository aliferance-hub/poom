-- P2-G.1: separate SELLER ORIGIN from SELLER VERIFICATION.
-- Two independent axes; neither implies the other, and neither is derived from
-- sellerStatus (marketplace governance, P2-E):
--   sellerOrigin               → how the seller entered the system
--   sellerVerificationStatus   → the admin-recorded verification decision
-- Backfill preserves historical state exactly: the legacy `verified` boolean had
-- NO writer anywhere in the codebase (dead code, always false), so every seller
-- stays UNVERIFIED unless the legacy flag was true (none are).
-- This migration is idempotent (IF NOT EXISTS / guarded updates) because part of
-- the project's migration history was applied manually.

DO $$ BEGIN
  CREATE TYPE "SellerOrigin" AS ENUM ('DEMO', 'REAL_ONBOARDING', 'SYSTEM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "SellerVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING_REVIEW', 'VERIFIED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ORIGIN — defaults to DEMO, then derived from the legacy isRealSeller flag.
-- SYSTEM is reserved for the audit-sentinel row ("audit-system"), which is a
-- bookkeeping row, not demo data and not an onboarded seller.
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "sellerOrigin" "SellerOrigin" NOT NULL DEFAULT 'DEMO';
UPDATE "Seller" SET "sellerOrigin" = 'SYSTEM' WHERE id = 'audit-system';
UPDATE "Seller"
SET "sellerOrigin" = CASE WHEN "isRealSeller" THEN 'REAL_ONBOARDING'::"SellerOrigin" ELSE 'DEMO' END
WHERE "sellerOrigin" = 'DEMO' AND id <> 'audit-system';

-- VERIFICATION — honest default: nobody was verified by any process that ever
-- ran, so the derived state is UNVERIFIED. Legacy true rows (none exist) keep
-- VERIFIED as their historical state; the G11 integrity check flags any such
-- row for manual re-verification because no verification event exists.
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "sellerVerificationStatus" "SellerVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED';
UPDATE "Seller" SET "sellerVerificationStatus" = 'VERIFIED' WHERE "verified" = true;

-- Verification decision evidence (set only by the admin verification flow).
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "verificationNote" TEXT;
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "verificationActor" TEXT;
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
-- Legacy true rows have no recorded decision; no timestamp is fabricated here.

CREATE INDEX IF NOT EXISTS "Seller_sellerVerificationStatus_idx" ON "Seller"("sellerVerificationStatus");
CREATE INDEX IF NOT EXISTS "Seller_sellerOrigin_idx" ON "Seller"("sellerOrigin");
