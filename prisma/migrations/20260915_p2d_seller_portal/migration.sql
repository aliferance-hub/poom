-- P2-D: Seller Portal — additive schema only (owner login, shipping range,
-- freshness timestamps, audit log, seller-facing indexes). No destructive DDL.

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN "priceUpdatedAt" TIMESTAMP(3),
ADD COLUMN "shippingDaysMax" INTEGER,
ADD COLUMN "shippingDaysMin" INTEGER,
ADD COLUMN "stockUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Seller" ADD COLUMN "userId" TEXT;

-- CreateTable
CREATE TABLE "SellerEventLog" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerEventLog_pkey" PRIMARY KEY ("id")
);

-- Backfills (idempotent)
UPDATE "Offer" SET "shippingDaysMin" = "shippingDays", "shippingDaysMax" = "shippingDays" WHERE "shippingDaysMin" IS NULL;
UPDATE "Offer" SET "stockUpdatedAt" = "updatedAt", "priceUpdatedAt" = "updatedAt" WHERE "stockUpdatedAt" IS NULL OR "priceUpdatedAt" IS NULL;

-- CreateIndex
CREATE INDEX "SellerEventLog_sellerId_createdAt_idx" ON "SellerEventLog"("sellerId", "createdAt");
CREATE INDEX "SellerEventLog_event_idx" ON "SellerEventLog"("event");
CREATE INDEX "Offer_sellerId_active_idx" ON "Offer"("sellerId", "active");
CREATE INDEX "Offer_sellerId_updatedAt_idx" ON "Offer"("sellerId", "updatedAt");
CREATE UNIQUE INDEX "Seller_userId_key" ON "Seller"("userId");
CREATE INDEX "SellerOrder_sellerId_status_idx" ON "SellerOrder"("sellerId", "status");
CREATE INDEX "User_role_idx" ON "User"("role");

-- AddForeignKey
ALTER TABLE "Seller" ADD CONSTRAINT "Seller_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SellerEventLog" ADD CONSTRAINT "SellerEventLog_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;
