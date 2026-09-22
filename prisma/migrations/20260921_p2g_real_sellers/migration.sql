-- P2-G: seller origin flag — real sellers arrive through /seller/apply onboarding
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "isRealSeller" BOOLEAN NOT NULL DEFAULT false;
