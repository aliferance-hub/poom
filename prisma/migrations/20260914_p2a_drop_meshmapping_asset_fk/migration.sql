-- DropForeignKey
ALTER TABLE "MeshMapping" DROP CONSTRAINT "MeshMapping_assetId_fkey";

-- AlterTable
ALTER TABLE "MeshMapping" DROP COLUMN "assetId";

