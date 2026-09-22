-- P2-B: Part.active (manual apply; do NOT regenerate against live DB —
-- prisma diff wants to drop the manual Fitment_dimensions_guard constraint,
-- which must stay. See 20260914_p2b_catalog_fitment/migration.sql tail.)
ALTER TABLE "Part" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
