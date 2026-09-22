-- P2-C: search/garage analytics events (coarse funnel, no PII).
-- Applied manually — the auto-diff would also revert intentional drift
-- (Fitment_dimensions_guard NULLS NOT DISTINCT constraint, updatedAt defaults).
CREATE TABLE "SearchEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "query" TEXT,
    "resultCount" INTEGER,
    "vehicleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SearchEvent_sessionId_idx" ON "SearchEvent"("sessionId");
CREATE INDEX "SearchEvent_type_createdAt_idx" ON "SearchEvent"("type", "createdAt");
