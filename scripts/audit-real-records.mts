// P2-F.1 §1 — deterministic audit of the real 206 dataset.
// Prints one JSON object per real record with full provenance/fitment/mapping state.
// Classification uses ONLY existing project terminology; nothing is upgraded.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const SOURCE = "public-206-maintenance-documentation";

const parts = await prisma.part.findMany({
  where: { sourceRef: SOURCE },
  orderBy: { slug: "asc" },
  select: {
    id: true, slug: true, title: true, titleEn: true, sku: true,
    dataStatus: true, sourceRef: true, sourceUrl: true, sourceUpdatedAt: true,
    dataVersion: true, dataNotes: true, assembly: { select: { slug: true } },
    fitments: { select: { fitmentStatus: true, fitmentNote: true, variant: { select: { trim: true } }, vehicle: { select: { model: true } } } },
    meshMappings: { select: { meshName: true, kind: true } },
  },
});

for (const p of parts) {
  const fit = p.fitments.map((f) => ({
    vehicle: f.vehicle.model,
    variant: f.variant?.trim ?? "(family-level)",
    status: f.fitmentStatus,
    provenance: f.fitmentNote ?? null,
  }));
  const classification =
    p.dataStatus === "VERIFIED" ? "VERIFIED"
    : p.dataStatus === "DEPRECATED" ? "DEPRECATED"
    : p.dataStatus === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED"
    : p.dataStatus === "UNVERIFIED" ? "UNVERIFIED"
    : p.dataStatus; // DEMO etc. — surfaced as-is, never remapped
  console.log(JSON.stringify({
    partId: p.id, slug: p.slug, title: p.title, titleEn: p.titleEn, sku: p.sku,
    verification: classification, dataStatus: p.dataStatus,
    provenance: {
      sourceRef: p.sourceRef, sourceUrl: p.sourceUrl,
      sourceUpdatedAt: p.sourceUpdatedAt?.toISOString() ?? null,
      dataVersion: p.dataVersion, dataNotes: p.dataNotes,
    },
    fitment: fit,
    assembly: p.assembly?.slug ?? null,
    meshMapping: p.meshMappings.map((m) => ({ mesh: m.meshName, kind: m.kind })),
  }));
}
await prisma.$disconnect();
