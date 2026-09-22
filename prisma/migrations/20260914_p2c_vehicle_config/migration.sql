-- Phase 2-C: Vehicle Configuration 2.0 (Engine/Transmission entities, BodyType enum,
-- variant FKs, garage columns + one-active-per-session guarantee).
-- Applied manually (mirrors `prisma migrate diff` output minus two unintended
-- reversions: the hand-added Fitment_dimensions_guard constraint and the
-- updatedAt defaults are intentionally KEPT — see docs/phase2 P2-B/C notes).

-- CreateEnum
CREATE TYPE "BodyType" AS ENUM ('HATCHBACK', 'SEDAN', 'WAGON', 'SUV', 'PICKUP', 'OTHER');

-- AlterTable Vehicle: free-text bodyType ("Hatchback") → enum
ALTER TABLE "Vehicle" ADD COLUMN "bodyType_new" "BodyType";
UPDATE "Vehicle" SET "bodyType_new" = 'HATCHBACK' WHERE LOWER("bodyType") = 'hatchback';
UPDATE "Vehicle" SET "bodyType_new" = 'SEDAN' WHERE LOWER("bodyType") = 'sedan';
UPDATE "Vehicle" SET "bodyType_new" = 'WAGON' WHERE LOWER("bodyType") = 'wagon';
UPDATE "Vehicle" SET "bodyType_new" = 'SUV' WHERE LOWER("bodyType") = 'suv';
UPDATE "Vehicle" SET "bodyType_new" = 'PICKUP' WHERE LOWER("bodyType") = 'pickup';
UPDATE "Vehicle" SET "bodyType_new" = 'OTHER' WHERE "bodyType" IS NOT NULL AND "bodyType_new" IS NULL;
ALTER TABLE "Vehicle" DROP COLUMN "bodyType";
ALTER TABLE "Vehicle" RENAME COLUMN "bodyType_new" TO "bodyType";

-- AlterTable GarageVehicle: new columns
ALTER TABLE "GarageVehicle" ADD COLUMN "nickname" TEXT;
ALTER TABLE "GarageVehicle" ADD COLUMN "year" INTEGER;
ALTER TABLE "GarageVehicle" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable VehicleVariant: engine/transmission FK columns
ALTER TABLE "VehicleVariant" ADD COLUMN "engineId" TEXT;
ALTER TABLE "VehicleVariant" ADD COLUMN "transmissionId" TEXT;

-- CreateTable Engine
CREATE TABLE "Engine" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "descriptionFa" TEXT,
    "dataStatus" "DataStatus" NOT NULL DEFAULT 'DEMO',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Engine_pkey" PRIMARY KEY ("id")
);

-- CreateTable Transmission
CREATE TABLE "Transmission" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "dataStatus" "DataStatus" NOT NULL DEFAULT 'DEMO',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Transmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Engine_vehicleId_name_key" ON "Engine"("vehicleId", "name");
CREATE UNIQUE INDEX "Transmission_vehicleId_name_key" ON "Transmission"("vehicleId", "name");
CREATE INDEX "GarageVehicle_userId_idx" ON "GarageVehicle"("userId");
CREATE INDEX "VehicleVariant_engineId_idx" ON "VehicleVariant"("engineId");
CREATE INDEX "VehicleVariant_transmissionId_idx" ON "VehicleVariant"("transmissionId");

-- AddForeignKey
ALTER TABLE "Engine" ADD CONSTRAINT "Engine_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Transmission" ADD CONSTRAINT "Transmission_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VehicleVariant" ADD CONSTRAINT "VehicleVariant_engineId_fkey" FOREIGN KEY ("engineId") REFERENCES "Engine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VehicleVariant" ADD CONSTRAINT "VehicleVariant_transmissionId_fkey" FOREIGN KEY ("transmissionId") REFERENCES "Transmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One-active-vehicle-per-session guarantee (partial unique index — Prisma DSL
-- cannot express WHERE clauses; documented in schema comment).
CREATE UNIQUE INDEX "GarageVehicle_one_active_per_session" ON "GarageVehicle"("sessionId") WHERE "isActive";
