import { notFound } from "next/navigation";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/identity";

const __adminGate = async () => { const a = await requireAdmin(); if (!a) redirect("/login?next=/admin"); return a; };
import { prisma } from "@/lib/prisma";
import { mappingHealthRows, storedAuditOf } from "@/lib/asset-registry";
import type { RenderVerification } from "@/lib/asset-lifecycle";
import { MappingStudio } from "@/components/studio/mapping-studio";
import type { StudioVersionRow } from "@/components/studio/mapping-studio";

export default async function AssetStudioPage({ params }: { params: Promise<{ assetId: string }> }) {
  await __adminGate();
  const { assetId } = await params;
  const asset = await prisma.asset.findUnique({
    where: { assetId },
    include: { versions: { orderBy: { version: "desc" }, include: { meshMappings: true } } },
  });
  if (!asset) notFound();

  const [zones, assemblies, parts, events] = await Promise.all([
    prisma.vehicleZone.findMany({ where: { vehicleId: asset.vehicleId ?? undefined }, orderBy: { sortOrder: "asc" }, include: { vehicle: { select: { displayName: true } } } }),
    prisma.assembly.findMany({ where: { zone: { vehicleId: asset.vehicleId ?? undefined } }, orderBy: { title: "asc" } }),
    prisma.part.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true, slug: true }, take: 200 }),
    prisma.assetEventLog.findMany({ where: { assetId: asset.id }, orderBy: { createdAt: "desc" }, take: 30 }),
  ]);

  const versions: StudioVersionRow[] = [];
  for (const v of asset.versions) {
    const audit = storedAuditOf(v.validationJson);
    const rawAudit = storedAuditOf(v.rawValidationJson);
    const metadata = (v.metadataJson as Record<string, unknown> | null) ?? {};
    const health = await mappingHealthRows(v.id);
    versions.push({
      id: v.id,
      version: v.version,
      state: v.state,
      createdAt: v.createdAt.toISOString(),
      fileSize: v.fileSize,
      mimeType: v.mimeType,
      checksum: v.checksumSha256,
      filePath: v.filePath.startsWith("builtin:") || v.filePath.startsWith("rejected:") ? null : v.filePath,
      rawFilePath: v.rawFilePath,
      rawFileSize: v.rawFileSize,
      rawChecksum: v.rawChecksumSha256,
      licenseType: v.licenseType,
      licenseUrl: v.licenseUrl,
      sourceUrl: v.sourceUrl,
      sourceProvider: v.sourceProvider,
      creator: v.creator,
      attributionText: v.attributionText,
      commercialUse: v.commercialUse,
      redistributionAllowed: v.redistributionAllowed,
      modificationAllowed: v.modificationAllowed,
      acquiredAt: v.acquiredAt ? v.acquiredAt.toISOString() : null,
      intendedUsage: v.intendedUsage,
      modifications: v.modifications,
      provenanceComplete: Boolean(
        v.licenseType && v.licenseType !== "UNSPECIFIED" &&
        v.sourceUrl && v.creator && v.acquiredAt && v.intendedUsage &&
        v.redistributionAllowed === true && v.modificationAllowed === true,
      ),
      mappingCount: v.meshMappings.length,
      validatedAt: v.validatedAt?.toISOString() ?? null,
      optimizedAt: v.optimizedAt?.toISOString() ?? null,
      stagedAt: v.stagedAt?.toISOString() ?? null,
      verifiedAt: v.verifiedAt?.toISOString() ?? null,
      promotedAt: v.promotedAt?.toISOString() ?? null,
      verifiedBy: v.verifiedBy,
      promotionNote: v.promotionNote,
      rejectionReason: v.rejectionReason,
      validation: audit
        ? {
            verdict: audit.verdict, structure: audit.structure, security: audit.security,
            selfContained: audit.selfContained, provenance: audit.provenance, sha256: audit.sha256,
            byteLength: audit.byteLength, metrics: audit.metrics, inventoryHash: audit.inventoryHash,
            meshNodeCount: audit.inventory?.meshNodeCount ?? 0,
            unnamedMeshNodes: audit.inventory?.unnamedMeshNodes ?? 0,
            problems: audit.problems,
          }
        : null,
      rawValidation: rawAudit
        ? { verdict: rawAudit.verdict, sha256: rawAudit.sha256, byteLength: rawAudit.byteLength, metrics: rawAudit.metrics }
        : null,
      optimization: (v.optimizationJson as StudioVersionRow["optimization"]) ?? null,
      inventory: audit?.inventory
        ? audit.inventory.entries.map((e) => ({
            nodeName: e.nodeName, path: e.path, meshName: e.meshName, nameSource: e.nameSource,
            triangles: e.triangles, vertices: e.vertices, primitives: e.primitives,
            visible: e.visible, fingerprint: e.fingerprint,
          }))
        : null,
      mappingHealth: health.map((h) => ({ meshName: h.meshName, kind: h.kind, status: h.status, detail: h.detail })),
      renderVerification: (metadata.renderVerification as RenderVerification | undefined) ?? null,
      mappings: v.meshMappings.map((m) => ({
        meshName: m.meshName, kind: m.kind, label: m.label,
        meshFingerprint: m.meshFingerprint, mappingHealth: m.mappingHealth,
        zoneId: m.zoneId, assemblyId: m.assemblyId, partId: m.partId,
        hotspot: Array.isArray(m.hotspotJson) ? (m.hotspotJson as number[]) : null,
      })),
    });
  }

  return (
    <MappingStudio
      asset={{
        assetId: asset.assetId,
        source: asset.source,
        kind: asset.kind,
        vehicleId: asset.vehicleId,
        versions,
      }}
      zones={zones.map((z) => ({ id: z.id, label: `${z.vehicle.displayName} — ${z.title}` }))}
      assemblies={assemblies.map((a) => ({ id: a.id, label: a.title }))}
      parts={parts.map((p) => ({ id: p.id, label: `${p.title} (${p.slug})` }))}
      events={events.map((e) => ({
        id: e.id, event: e.event, fromState: e.fromState, toState: e.toState,
        actor: e.actor, note: e.note, createdAt: e.createdAt.toISOString(),
      }))}
    />
  );
}
