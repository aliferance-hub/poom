import { notFound } from "next/navigation";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/identity";

const __adminGate = async () => { const a = await requireAdmin(); if (!a) redirect("/login?next=/admin"); return a; };
import { prisma } from "@/lib/prisma";
import { MappingStudio } from "@/components/studio/mapping-studio";

export default async function AssetStudioPage({ params }: { params: Promise<{ assetId: string }> }) {
  await __adminGate();
  const { assetId } = await params;
  const asset = await prisma.asset.findUnique({
    where: { assetId },
    include: { versions: { orderBy: { version: "desc" }, include: { meshMappings: true } } },
  });
  if (!asset) notFound();
  const mappingCountByVersion = new Map<string, number>();
  for (const v of asset.versions) {
    mappingCountByVersion.set(v.id, v.meshMappings.length);
  }

  const [zones, assemblies, parts] = await Promise.all([
    prisma.vehicleZone.findMany({ where: { vehicleId: asset.vehicleId ?? undefined }, orderBy: { sortOrder: "asc" }, include: { vehicle: { select: { displayName: true } } } }),
    prisma.assembly.findMany({ where: { zone: { vehicleId: asset.vehicleId ?? undefined } }, orderBy: { title: "asc" } }),
    prisma.part.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true, slug: true }, take: 200 }),
  ]);

  return (
    <MappingStudio
      asset={{
        assetId: asset.assetId,
        source: asset.source,
        versions: asset.versions.map((v) => ({
          id: v.id, version: v.version, status: v.status,
          fileSize: v.fileSize, mimeType: v.mimeType, checksum: v.checksumSha256,
          licenseType: v.licenseType, commercialUse: v.commercialUse,
          mappingCount: mappingCountByVersion.get(v.id) ?? 0,
          acquiredAt: v.acquiredAt ? v.acquiredAt.toISOString() : null,
          // F1: completeness = license (real, not UNSPECIFIED) + creator + acquiredAt + intendedUsage
          provenanceComplete: Boolean(
            v.licenseType && v.licenseType !== "UNSPECIFIED" &&
            v.creator && v.acquiredAt && v.intendedUsage,
          ),
        })),
      }}
      zones={zones.map((z) => ({ id: z.id, label: `${z.vehicle.displayName} — ${z.title}` }))}
      assemblies={assemblies.map((a) => ({ id: a.id, label: a.title }))}
      parts={parts.map((p) => ({ id: p.id, label: `${p.title} (${p.slug})` }))}
    />
  );
}
