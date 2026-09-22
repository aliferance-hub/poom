-- CreateEnum
CREATE TYPE "DataStatus" AS ENUM ('DEMO', 'VERIFIED', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "RelatedPartType" AS ENUM ('RELATED', 'REPLACEMENT', 'REQUIRES', 'OFTEN_PURCHASED_WITH');

-- AlterTable
ALTER TABLE "Fitment" ADD COLUMN     "bodyType" TEXT,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "transmission" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Part" DROP COLUMN "isDemoData",
ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "dataStatus" "DataStatus" NOT NULL DEFAULT 'DEMO',
ADD COLUMN     "specificationsJson" JSONB,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "parentId" TEXT,
    "slug" TEXT NOT NULL,
    "titleFa" TEXT NOT NULL,
    "descriptionFa" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelatedPart" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "relatedPartId" TEXT NOT NULL,
    "type" "RelatedPartType" NOT NULL DEFAULT 'RELATED',
    "noteFa" TEXT,

    CONSTRAINT "RelatedPart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_slug_key" ON "Brand"("slug");

-- CreateIndex
CREATE INDEX "RelatedPart_relatedPartId_idx" ON "RelatedPart"("relatedPartId");

-- CreateIndex
CREATE UNIQUE INDEX "RelatedPart_partId_relatedPartId_type_key" ON "RelatedPart"("partId", "relatedPartId", "type");

-- CreateIndex
CREATE INDEX "Fitment_fitmentStatus_idx" ON "Fitment"("fitmentStatus");

-- CreateIndex
CREATE INDEX "Fitment_vehicleId_idx" ON "Fitment"("vehicleId");

-- CreateIndex
CREATE INDEX "Part_categoryId_idx" ON "Part"("categoryId");

-- CreateIndex
CREATE INDEX "Part_brandId_idx" ON "Part"("brandId");

-- CreateIndex
CREATE INDEX "PartIdentifier_value_idx" ON "PartIdentifier"("value");

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Part" ADD CONSTRAINT "Part_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Part" ADD CONSTRAINT "Part_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelatedPart" ADD CONSTRAINT "RelatedPart_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelatedPart" ADD CONSTRAINT "RelatedPart_relatedPartId_fkey" FOREIGN KEY ("relatedPartId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── P2-B fitment conflict guard ──
-- Same (part, vehicle, variant, engine, transmission, bodyType, yearFrom, yearTo)
-- dimensions may exist at most once → the same dimensions can never carry both
-- COMPATIBLE (CONFIRMED) and INCOMPATIBLE (REJECTED). NULLs compare as equal.
DELETE FROM "Fitment" a USING "Fitment" b
  WHERE a.id > b.id
    AND a."partId" = b."partId" AND a."vehicleId" = b."vehicleId"
    AND a."variantId" IS NOT DISTINCT FROM b."variantId"
    AND a."engine" IS NOT DISTINCT FROM b."engine"
    AND a."transmission" IS NOT DISTINCT FROM b."transmission"
    AND a."bodyType" IS NOT DISTINCT FROM b."bodyType"
    AND a."yearFrom" IS NOT DISTINCT FROM b."yearFrom"
    AND a."yearTo" IS NOT DISTINCT FROM b."yearTo";
ALTER TABLE "Fitment" ADD CONSTRAINT "Fitment_dimensions_guard" UNIQUE NULLS NOT DISTINCT ("partId", "vehicleId", "variantId", "engine", "transmission", "bodyType", "yearFrom", "yearTo");
