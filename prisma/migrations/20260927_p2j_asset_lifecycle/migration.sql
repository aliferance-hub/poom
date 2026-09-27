-- P2-J (J6/J13/§22/§28/§31): asset lifecycle, provenance evidence, mapping drift
-- fingerprints and the asset audit trail.
--
-- WHY THIS MIGRATION EXISTS
--   * Before P2-J a version's "status" mixed two different questions: "is this
--     artifact technically usable?" (READY) and "is this the thing customers
--     should see?" (ACTIVE). A synthetic engineering stand-in could therefore
--     sit in the ACTIVE slot with no way for a surface to tell it apart from a
--     real promoted asset. The new single `state` column answers both questions
--     explicitly and PLACEHOLDER is a real, visible state.
--   * Promotion must not be a boolean a UI can flip: the intermediate states
--     (RAW → VALIDATED → OPTIMIZED → STAGED → VERIFIED → PRODUCTION) are now
--     data, and the pipeline (validated by tests) enforces them.
--   * Rollback needs the previous artifact to survive: RETIRED versions keep
--     their immutable object key and can be promoted back.
--
-- DATA MIGRATION RULE (deliberately conservative)
--   Every version that existed before this migration is either the builtin
--   primitive placeholder or the tracked synthetic engineering GLB — there has
--   never been a real third-party asset in this database. Those rows are
--   reclassified as PLACEHOLDER, never as PRODUCTION, so no customer surface can
--   present a stand-in as a real Peugeot 206. States are otherwise translated
--   1:1 from the legacy column (DRAFT/PROCESSING → RAW, READY → VALIDATED,
--   ACTIVE → PRODUCTION, ARCHIVED → RETIRED, REJECTED → REJECTED).
--
-- SAFETY (P2-H runbook §7: two-phase destructive changes)
--   * ADDITIVE ONLY. The legacy `status` column is *kept* — nullable, no longer
--     written by the new code — so the deployment that is live while this
--     migration runs keeps working (§7: never DROP in the same release that
--     stops using the object). Phase 2, in a later release once the P2-J code is
--     confirmed live, drops `AssetVersionStatus` + the column + its index.
--   * Idempotency is not claimed: Prisma applies each migration exactly once
--     (tracked in _prisma_migrations). Re-running by hand is not supported.
--   * No secrets, no data invention: unknown provenance stays NULL.

-- ── 1. enums ──────────────────────────────────────────────────────────────────
CREATE TYPE "AssetKind" AS ENUM ('SYNTHETIC', 'REAL');

CREATE TYPE "AssetVersionState" AS ENUM (
  'PLACEHOLDER',
  'RAW',
  'VALIDATED',
  'OPTIMIZED',
  'STAGED',
  'VERIFIED',
  'PRODUCTION',
  'RETIRED',
  'REJECTED'
);

-- ── 2. Asset.kind ─────────────────────────────────────────────────────────────
-- Existing assets are the in-repo synthetic stand-ins; the default states that.
ALTER TABLE "Asset" ADD COLUMN "kind" "AssetKind" NOT NULL DEFAULT 'SYNTHETIC';

-- ── 3. AssetVersion.state ─────────────────────────────────────────────────────
ALTER TABLE "AssetVersion" ADD COLUMN "state" "AssetVersionState";

UPDATE "AssetVersion"
   SET "state" = CASE "status"::text
     WHEN 'DRAFT'      THEN 'RAW'::"AssetVersionState"
     WHEN 'PROCESSING' THEN 'RAW'::"AssetVersionState"
     WHEN 'READY'      THEN 'VALIDATED'::"AssetVersionState"
     WHEN 'ACTIVE'     THEN 'PRODUCTION'::"AssetVersionState"
     WHEN 'ARCHIVED'   THEN 'RETIRED'::"AssetVersionState"
     ELSE 'REJECTED'::"AssetVersionState"
   END;

-- The reclassification that matters: in-repo primitive geometry and the tracked
-- synthetic engineering GLB are stand-ins, not production assets.
UPDATE "AssetVersion"
   SET "state" = 'PLACEHOLDER'::"AssetVersionState"
 WHERE "filePath" LIKE 'builtin:%'
    OR lower("filePath") LIKE '%engineering%';

ALTER TABLE "AssetVersion" ALTER COLUMN "state" SET NOT NULL;
ALTER TABLE "AssetVersion" ALTER COLUMN "state" SET DEFAULT 'RAW';

-- ── 4. AssetVersion: raw artifact, rights tri-state, pipeline evidence ────────
ALTER TABLE "AssetVersion" ADD COLUMN "rawFilePath" TEXT;
ALTER TABLE "AssetVersion" ADD COLUMN "rawFileSize" INTEGER;
ALTER TABLE "AssetVersion" ADD COLUMN "rawChecksumSha256" TEXT;
ALTER TABLE "AssetVersion" ADD COLUMN "sourceProvider" TEXT;
ALTER TABLE "AssetVersion" ADD COLUMN "redistributionAllowed" BOOLEAN;
ALTER TABLE "AssetVersion" ADD COLUMN "modificationAllowed" BOOLEAN;
ALTER TABLE "AssetVersion" ADD COLUMN "validationJson" JSONB;
ALTER TABLE "AssetVersion" ADD COLUMN "rawValidationJson" JSONB;
ALTER TABLE "AssetVersion" ADD COLUMN "optimizationJson" JSONB;
ALTER TABLE "AssetVersion" ADD COLUMN "provenanceJson" JSONB;
ALTER TABLE "AssetVersion" ADD COLUMN "metadataJson" JSONB;
ALTER TABLE "AssetVersion" ADD COLUMN "validatedAt" TIMESTAMP(3);
ALTER TABLE "AssetVersion" ADD COLUMN "optimizedAt" TIMESTAMP(3);
ALTER TABLE "AssetVersion" ADD COLUMN "stagedAt" TIMESTAMP(3);
ALTER TABLE "AssetVersion" ADD COLUMN "verifiedAt" TIMESTAMP(3);
ALTER TABLE "AssetVersion" ADD COLUMN "promotedAt" TIMESTAMP(3);
ALTER TABLE "AssetVersion" ADD COLUMN "verifiedBy" TEXT;
ALTER TABLE "AssetVersion" ADD COLUMN "promotionNote" TEXT;
ALTER TABLE "AssetVersion" ADD COLUMN "rejectionReason" TEXT;

-- Legacy column stays (nullable) as the compatibility bridge for the code that
-- is still deployed while this migration is applied. Phase 2 will remove:
--   DROP INDEX "AssetVersion_assetId_status_idx";
--   ALTER TABLE "AssetVersion" DROP COLUMN "status";
--   DROP TYPE "AssetVersionStatus";
ALTER TABLE "AssetVersion" ALTER COLUMN "status" DROP NOT NULL;

CREATE INDEX "AssetVersion_assetId_state_idx" ON "AssetVersion"("assetId", "state");

-- ── 5. MeshMapping: drift fingerprints ────────────────────────────────────────
-- A mapping records the structural identity of the node it points at, so a new
-- asset version that renames or removes that node is detected instead of
-- silently rendering the wrong thing (or nothing).
ALTER TABLE "MeshMapping" ADD COLUMN "meshFingerprint" TEXT;
ALTER TABLE "MeshMapping" ADD COLUMN "mappingHealth" TEXT;
ALTER TABLE "MeshMapping" ADD COLUMN "healthCheckedAt" TIMESTAMP(3);

-- ── 6. AssetEventLog: append-only audit trail ─────────────────────────────────
CREATE TABLE "AssetEventLog" (
  "id"         TEXT NOT NULL,
  "assetId"    TEXT NOT NULL,
  "versionId"  TEXT,
  "event"      TEXT NOT NULL,
  "fromState"  TEXT,
  "toState"    TEXT,
  "actor"      TEXT NOT NULL,
  "note"       TEXT,
  "detailJson" JSONB,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssetEventLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AssetEventLog_assetId_createdAt_idx" ON "AssetEventLog"("assetId", "createdAt");
CREATE INDEX "AssetEventLog_event_idx" ON "AssetEventLog"("event");
CREATE INDEX "AssetEventLog_versionId_idx" ON "AssetEventLog"("versionId");

ALTER TABLE "AssetEventLog"
  ADD CONSTRAINT "AssetEventLog_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull keeps the audit record even if a version row is ever removed; the
-- event text and detailJson still describe what happened.
ALTER TABLE "AssetEventLog"
  ADD CONSTRAINT "AssetEventLog_versionId_fkey"
  FOREIGN KEY ("versionId") REFERENCES "AssetVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 7. RLS baseline extension (P2-H rule: every new table joins the baseline) ──
ALTER TABLE "public"."AssetEventLog" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON "public"."AssetEventLog" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON "public"."AssetEventLog" FROM authenticated;
  END IF;
END $$;
