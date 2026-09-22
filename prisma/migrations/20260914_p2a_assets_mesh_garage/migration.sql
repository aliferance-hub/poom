-- CreateEnum
CREATE TYPE "AssetVersionStatus" AS ENUM ('DRAFT', 'PROCESSING', 'READY', 'ACTIVE', 'ARCHIVED', 'REJECTED');

-- DropForeignKey
ALTER TABLE "PartMeshMapping" DROP CONSTRAINT "PartMeshMapping_assetId_fkey";

-- DropForeignKey
ALTER TABLE "PartMeshMapping" DROP CONSTRAINT "PartMeshMapping_partId_fkey";

-- DropForeignKey
ALTER TABLE "ZoneMeshMapping" DROP CONSTRAINT "ZoneMeshMapping_assetId_fkey";

-- AlterTable
ALTER TABLE "AssetVersion" DROP COLUMN "isActive",
ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "attributionText" TEXT,
ADD COLUMN     "checksumSha256" TEXT,
ADD COLUMN     "commercialUse" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "creator" TEXT,
ADD COLUMN     "fileSize" INTEGER,
ADD COLUMN     "fileUrl" TEXT,
ADD COLUMN     "licenseType" TEXT,
ADD COLUMN     "licenseUrl" TEXT,
ADD COLUMN     "mimeType" TEXT,
ADD COLUMN     "previewUrl" TEXT,
ADD COLUMN     "sourceUrl" TEXT,
ADD COLUMN     "status" "AssetVersionStatus" NOT NULL DEFAULT 'DRAFT';

-- DropTable
DROP TABLE "PartMeshMapping";

-- DropTable
DROP TABLE "ZoneMeshMapping";

-- CreateTable
CREATE TABLE "MeshMapping" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "meshName" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'zone',
    "zoneId" TEXT,
    "assemblyId" TEXT,
    "partId" TEXT,
    "label" TEXT,
    "hotspotJson" JSONB,
    "cameraPositionJson" JSONB,
    "cameraTargetJson" JSONB,
    "explodedOffsetJson" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "assetId" TEXT,

    CONSTRAINT "MeshMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GarageVehicle" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "variantId" TEXT NOT NULL,
    "yearFa" INTEGER,
    "plate" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vehicleId" TEXT,

    CONSTRAINT "GarageVehicle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MeshMapping_versionId_kind_idx" ON "MeshMapping"("versionId", "kind");

-- CreateIndex
CREATE INDEX "MeshMapping_zoneId_idx" ON "MeshMapping"("zoneId");

-- CreateIndex
CREATE INDEX "MeshMapping_assemblyId_idx" ON "MeshMapping"("assemblyId");

-- CreateIndex
CREATE INDEX "MeshMapping_partId_idx" ON "MeshMapping"("partId");

-- CreateIndex
CREATE UNIQUE INDEX "MeshMapping_versionId_meshName_key" ON "MeshMapping"("versionId", "meshName");

-- CreateIndex
CREATE INDEX "GarageVehicle_sessionId_idx" ON "GarageVehicle"("sessionId");

-- CreateIndex
CREATE INDEX "AssetVersion_assetId_status_idx" ON "AssetVersion"("assetId", "status");

-- AddForeignKey
ALTER TABLE "MeshMapping" ADD CONSTRAINT "MeshMapping_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "AssetVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeshMapping" ADD CONSTRAINT "MeshMapping_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "VehicleZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeshMapping" ADD CONSTRAINT "MeshMapping_assemblyId_fkey" FOREIGN KEY ("assemblyId") REFERENCES "Assembly"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeshMapping" ADD CONSTRAINT "MeshMapping_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeshMapping" ADD CONSTRAINT "MeshMapping_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GarageVehicle" ADD CONSTRAINT "GarageVehicle_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "VehicleVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GarageVehicle" ADD CONSTRAINT "GarageVehicle_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

