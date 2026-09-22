-- P2-E: production hardening — additive schema only (sessions, payment attempts,
-- shipments, returns/refunds, governance enums, order snapshots). No destructive DDL.

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING', 'DISABLED');
CREATE TYPE "SellerStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED');
CREATE TYPE "ShipmentStatus" AS ENUM ('PENDING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'RETURNED');
CREATE TYPE "ReturnStatus" AS ENUM ('REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'RECEIVED', 'REFUND_PENDING', 'REFUNDED', 'CANCELLED');
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN "partSkuSnapshot" TEXT,
ADD COLUMN "partTitleSnapshot" TEXT,
ADD COLUMN "sellerNameSnapshot" TEXT,
ADD COLUMN "sellerSkuSnapshot" TEXT;

ALTER TABLE "Seller" ADD COLUMN "sellerStatus" "SellerStatus" NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE "User" ADD COLUMN "lastLoginAt" TIMESTAMP(3),
ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "User" ALTER COLUMN "updatedAt" DROP DEFAULT; -- @updatedAt is app-managed from here

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "amountIrr" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "authority" TEXT,
    "referenceId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "sellerOrderId" TEXT NOT NULL,
    "carrier" TEXT NOT NULL DEFAULT 'DEMO',
    "trackingCode" TEXT,
    "shippingMethod" TEXT NOT NULL DEFAULT 'STANDARD',
    "shippingCostIrr" INTEGER NOT NULL DEFAULT 0,
    "estimatedDeliveryFrom" TIMESTAMP(3),
    "estimatedDeliveryTo" TIMESTAMP(3),
    "status" "ShipmentStatus" NOT NULL DEFAULT 'PENDING',
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReturnPolicy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "returnWindowDays" INTEGER NOT NULL DEFAULT 7,
    "requiresDelivered" BOOLEAN NOT NULL DEFAULT true,
    "allowOpened" BOOLEAN NOT NULL DEFAULT false,
    "needsLegalVerification" BOOLEAN NOT NULL DEFAULT true,
    "noteFa" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "ReturnPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReturnRequest" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "status" "ReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReturnRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "returnRequestId" TEXT NOT NULL,
    "paymentAttemptId" TEXT,
    "amountIrr" INTEGER NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- Backfills: snapshots from live relations (historical evidence baseline),
-- governance enum from legacy string status.
UPDATE "OrderItem" oi SET
  "partTitleSnapshot" = p.title,
  "partSkuSnapshot" = p.sku,
  "sellerSkuSnapshot" = o."sellerSku",
  "sellerNameSnapshot" = s."businessName"
FROM "Offer" o, "Part" p, "Seller" s
WHERE oi."offerId" = o.id AND o."partId" = p.id AND o."sellerId" = s.id;

UPDATE "Seller" SET "sellerStatus" = 'ACTIVE' WHERE "sellerStatus" IS NULL;

-- Attempt-ledger backfill: every pre-existing Payment row gets one attempt row
-- mirroring its state (legacy rows predate the ledger).
INSERT INTO "PaymentAttempt" (id, "paymentId", "attemptNumber", provider, "amountIrr", status, authority, "idempotencyKey")
SELECT 'pab-' || p.id, p.id, 1, p.provider, p.amount, p.status, p.authority, 'seed-' || p.id
FROM "Payment" p
WHERE NOT EXISTS (SELECT 1 FROM "PaymentAttempt" a WHERE a."paymentId" = p.id)
ON CONFLICT (id) DO NOTHING;

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE UNIQUE INDEX "PaymentAttempt_authority_key" ON "PaymentAttempt"("authority");
CREATE UNIQUE INDEX "PaymentAttempt_referenceId_key" ON "PaymentAttempt"("referenceId");
CREATE UNIQUE INDEX "PaymentAttempt_idempotencyKey_key" ON "PaymentAttempt"("idempotencyKey");
CREATE UNIQUE INDEX "PaymentAttempt_paymentId_attemptNumber_key" ON "PaymentAttempt"("paymentId", "attemptNumber");
CREATE UNIQUE INDEX "Shipment_sellerOrderId_key" ON "Shipment"("sellerOrderId");
CREATE UNIQUE INDEX "Refund_returnRequestId_key" ON "Refund"("returnRequestId");
-- One non-terminal return request per OrderItem (partial unique index):
CREATE UNIQUE INDEX "ReturnRequest_one_active_per_item" ON "ReturnRequest"("orderItemId")
  WHERE status NOT IN ('REJECTED', 'CANCELLED', 'REFUNDED');

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "SellerOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
