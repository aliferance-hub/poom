-- P2-F: real-data pipeline (F1 + F3/F5)
-- Idempotent: safe to re-run.
-- NOTE: ImportBatch/ImportRow creation moved BEFORE the ALTERs — a fresh DB
-- (Supabase) has no ImportBatch yet, and ALTER-before-CREATE fails with 42P01.

-- ── F5: import pipeline (tables first) ──
DO $$ BEGIN
  CREATE TYPE "ImportStatus" AS ENUM ('DRAFT', 'VALIDATED', 'APPROVED', 'REJECTED', 'COMMITTED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "RowStatus" AS ENUM ('RAW', 'NORMALIZED', 'VALID', 'INVALID', 'APPROVED', 'REJECTED', 'APPLIED');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "ImportAction" AS ENUM ('CREATE', 'UPDATE', 'DEPRECATE', 'UNCHANGED', 'CONFLICT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "ImportBatch" (
  "id" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "sourceRef" TEXT NOT NULL,
  "sourceUrl" TEXT,
  "sourceUpdatedAt" TIMESTAMP(3),
  "status" "ImportStatus" NOT NULL DEFAULT 'DRAFT',
  "format" TEXT NOT NULL DEFAULT 'csv',
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "committedAt" TIMESTAMP(3),

  CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "ImportRow" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "rowNumber" INTEGER NOT NULL,
  "rawJson" JSONB NOT NULL,
  "normalizedJson" JSONB,
  "status" "RowStatus" NOT NULL DEFAULT 'RAW',
  "problems" TEXT[],
  "externalKey" TEXT,
  "matchedPartId" TEXT,
  "action" "ImportAction",

  CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ImportBatch_label_key" ON "ImportBatch"("label");
CREATE INDEX IF NOT EXISTS "ImportBatch_status_idx" ON "ImportBatch"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "ImportRow_batchId_rowNumber_key" ON "ImportRow"("batchId", "rowNumber");
CREATE INDEX IF NOT EXISTS "ImportRow_batchId_status_idx" ON "ImportRow"("batchId", "status");
CREATE INDEX IF NOT EXISTS "ImportRow_externalKey_idx" ON "ImportRow"("externalKey");
DO $$ BEGIN
  ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── F1: AssetVersion provenance completeness ──
ALTER TABLE "AssetVersion" ADD COLUMN IF NOT EXISTS "acquiredAt" TIMESTAMP(3);
ALTER TABLE "AssetVersion" ADD COLUMN IF NOT EXISTS "modifications" TEXT;
ALTER TABLE "AssetVersion" ADD COLUMN IF NOT EXISTS "intendedUsage" TEXT;

-- ── F3/F5: Part provenance ──
ALTER TABLE "Part" ADD COLUMN IF NOT EXISTS "titleEn" TEXT;
ALTER TABLE "Part" ADD COLUMN IF NOT EXISTS "sourceRef" TEXT;
ALTER TABLE "Part" ADD COLUMN IF NOT EXISTS "sourceUrl" TEXT;
ALTER TABLE "ImportBatch" ADD COLUMN IF NOT EXISTS "sourceUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Part" ADD COLUMN IF NOT EXISTS "sourceUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Part" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
ALTER TABLE "Part" ADD COLUMN IF NOT EXISTS "verifiedBy" TEXT;
ALTER TABLE "Part" ADD COLUMN IF NOT EXISTS "dataNotes" TEXT;
ALTER TABLE "Part" ADD COLUMN IF NOT EXISTS "dataVersion" INTEGER NOT NULL DEFAULT 1;

-- ── F5: DataStatus extension (run outside a transaction: ALTER TYPE) ──
ALTER TYPE "DataStatus" ADD VALUE IF NOT EXISTS 'REVIEW_REQUIRED';
ALTER TYPE "DataStatus" ADD VALUE IF NOT EXISTS 'DEPRECATED';
