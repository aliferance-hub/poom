-- P2-I (I4): catalog lifecycle audit trail.
-- Non-destructive: additive table + two indexes; no data changes.

CREATE TABLE IF NOT EXISTS "CatalogEventLog" (
    "id"         TEXT NOT NULL,
    "partId"     TEXT NOT NULL,
    "actor"      TEXT NOT NULL,
    "event"      TEXT NOT NULL, -- catalog_verified | catalog_verification_reopened | catalog_deprecated | catalog_promoted
    "entity"     TEXT NOT NULL DEFAULT 'Part',
    "entityId"   TEXT,
    "meta"       JSONB,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogEventLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CatalogEventLog_partId_createdAt_idx" ON "CatalogEventLog"("partId", "createdAt");
CREATE INDEX IF NOT EXISTS "CatalogEventLog_event_idx" ON "CatalogEventLog"("event");

ALTER TABLE "CatalogEventLog"
  ADD CONSTRAINT "CatalogEventLog_partId_fkey"
  FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON TABLE "CatalogEventLog" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON TABLE "CatalogEventLog" FROM authenticated;
  END IF;
END $$;
