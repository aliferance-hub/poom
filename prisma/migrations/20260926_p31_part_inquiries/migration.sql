-- P3.1: part inquiries — visitors request parts they cannot find (استعلام قطعه)
DO $$ BEGIN
  CREATE TYPE "PartInquiryStatus" AS ENUM ('NEW', 'IN_REVIEW', 'RESOLVED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "PartInquiry" (
    "id" TEXT NOT NULL,
    "status" "PartInquiryStatus" NOT NULL DEFAULT 'NEW',
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "note" TEXT,
    "partSlug" TEXT,
    "partTitle" TEXT,
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedNote" TEXT,

    CONSTRAINT "PartInquiry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PartInquiry_status_createdAt_idx" ON "PartInquiry"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "PartInquiry_phone_idx" ON "PartInquiry"("phone");
