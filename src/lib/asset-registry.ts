import { prisma } from "@/lib/prisma";
import { createHash } from "node:crypto";
import { getAssetStorage } from "@/lib/storage";
import { StorageError } from "@/lib/storage/types";

// ─────────────────────────── lifecycle ───────────────────────────

export type LicenseMeta = {
  licenseType: string;
  licenseUrl?: string;
  sourceUrl?: string;
  creator?: string;
  attributionText?: string;
  commercialUse: boolean;
  // P2-F (F1) provenance completeness — required for real (uploaded) assets:
  acquiredAt?: Date | null; // when the file was obtained/produced
  modifications?: string | null; // what was altered after acquisition
  intendedUsage?: string | null; // declared scope, e.g. "product viewer"
};

/**
 * Register a new version for an asset. Starts in DRAFT — never directly publishable.
 * Pass a live buffer (uploaded GLB) or filePath for builtin geometry.
 */
export async function createAssetVersion(input: {
  assetId: string; // business key, e.g. peugeot-206-main-v1
  fileBuffer?: Buffer;
  fileName?: string;
  mimeType?: string;
  license?: LicenseMeta;
}) {
  const asset = await prisma.asset.findUnique({ where: { assetId: input.assetId } });
  if (!asset) throw new Error("ASSET_NOT_FOUND");

  const last = await prisma.assetVersion.findFirst({
    where: { assetId: asset.id },
    orderBy: { version: "desc" },
  });
  const nextVersion = (last?.version ?? 0) + 1;

  const data: Parameters<typeof prisma.assetVersion.create>[0]["data"] = {
    assetId: asset.id,
    version: nextVersion,
    status: "DRAFT",
    licenseType: input.license?.licenseType ?? null,
    licenseUrl: input.license?.licenseUrl ?? null,
    sourceUrl: input.license?.sourceUrl ?? null,
    creator: input.license?.creator ?? null,
    attributionText: input.license?.attributionText ?? null,
    commercialUse: input.license?.commercialUse ?? false,
    acquiredAt: input.license?.acquiredAt ?? null,
    modifications: input.license?.modifications ?? null,
    intendedUsage: input.license?.intendedUsage ?? null,
  };

  let objectKey: string | null = null;
  if (input.fileBuffer) {
    objectKey = `uploads/assets/${asset.assetId}/v${nextVersion}/${sanitizeName(input.fileName ?? "model.glb")}`;
    data.filePath = objectKey;
    data.fileSize = input.fileBuffer.length;
    data.mimeType = input.mimeType ?? guessMime(input.fileName ?? "");
    data.checksumSha256 = sha256(input.fileBuffer);

    // P2-H (H5): storage owns the binary. Upload BEFORE the DB write; a failed
    // DB create then leaves an orphan object — harmless and detectable via the
    // H8 reconciliation checks (storage_objects_without_asset_version).
    const storage = getAssetStorage();
    try {
      await storage.upload(objectKey, input.fileBuffer, {
        contentType: data.mimeType ?? "application/octet-stream",
      });
    } catch (e) {
      // Deterministic failure mapping (H17): no raw provider errors escape.
      if (e instanceof StorageError && e.code === "OBJECT_EXISTS") {
        throw new Error("OBJECT_EXISTS: immutable key already holds an object");
      }
      throw e instanceof StorageError ? new Error(e.code) : e;
    }
    // fileUrl stored as provenance snapshot; resolveContract() derives the live URL.
    data.fileUrl = storage.getPublicUrl(objectKey);
  }

  try {
    return await prisma.assetVersion.create({ data });
  } catch (e) {
    // P2-H (H8) compensating behavior: DB write failed after a successful
    // upload → remove the orphan object, then rethrow the original error.
    if (objectKey) await getAssetStorage().delete(objectKey).catch(() => {});
    throw e;
  }
}

/** DRAFT/READY → PROCESSING (simulate validation pipeline; GLB magic check when a buffer exists). */
export async function markProcessing(versionId: string) {
  const v = await prisma.assetVersion.findUnique({ where: { id: versionId } });
  if (!v) throw new Error("VERSION_NOT_FOUND");
  if (v.status !== "DRAFT" && v.status !== "READY") throw new Error(`BAD_STATE:${v.status}`);
  return prisma.assetVersion.update({ where: { id: versionId }, data: { status: "PROCESSING" } });
}

/** Validate a PROCESSING version (GLB magic bytes for uploaded files) → READY. */
export async function validateVersion(versionId: string, fileBuffer?: Buffer) {
  const v = await prisma.assetVersion.findUnique({ where: { id: versionId } });
  if (!v) throw new Error("VERSION_NOT_FOUND");
  if (v.status !== "PROCESSING" && v.status !== "DRAFT") throw new Error(`BAD_STATE:${v.status}`);

  const problems: string[] = [];
  const isUpload = !v.filePath.startsWith("builtin:");
  if (isUpload) {
    if (!v.fileSize || v.fileSize <= 0) problems.push("FILE_EMPTY");
    if (fileBuffer && !isGlb(fileBuffer)) problems.push("NOT_A_GLB");
    if (v.mimeType && !["model/gltf-binary", "application/octet-stream"].includes(v.mimeType)) problems.push("BAD_MIME");
    // Commercial use requires license metadata
    if (v.commercialUse && !v.licenseType) problems.push("COMMERCIAL_USE_NEEDS_LICENSE");
    // P2-F (F1): a real asset must carry complete provenance before it ships.
    // The in-repo placeholder (builtin:) is exempt — it makes no external claims.
    const UNSPECIFIED = new Set(["", "UNSPECIFIED", "UNKNOWN", "TBD"]);
    if (UNSPECIFIED.has(v.licenseType ?? "")) problems.push("LICENSE_TYPE_REQUIRED");
    if (!v.creator) problems.push("CREATOR_REQUIRED");
    if (!v.acquiredAt) problems.push("ACQUISITION_DATE_REQUIRED");
    if (!v.intendedUsage) problems.push("INTENDED_USAGE_REQUIRED");
  }
  if (problems.length > 0) {
    await prisma.assetVersion.update({ where: { id: versionId }, data: { status: "REJECTED" } });
    return { ok: false as const, problems };
  }
  await prisma.assetVersion.update({ where: { id: versionId }, data: { status: "READY" } });
  return { ok: true as const };
}

/** A version may only go ACTIVE if it carries at least one mesh mapping. */
async function assertHasMappings(versionId: string) {
  const count = await prisma.meshMapping.count({ where: { versionId } });
  if (count === 0) throw new Error("EMPTY_MAPPING_SET: a version without mesh mappings would blank the viewer");
}

/** READY → ACTIVE, archiving the previous active version. Single-active invariant. */
export async function activateVersion(versionId: string) {
  const v = await prisma.assetVersion.findUnique({ where: { id: versionId } });
  if (!v) throw new Error("VERSION_NOT_FOUND");
  if (v.status !== "READY") throw new Error(`BAD_STATE:${v.status}`);
  await assertHasMappings(versionId);

  return prisma.$transaction(async (tx) => {
    await tx.assetVersion.updateMany({
      where: { assetId: v.assetId, status: "ACTIVE" },
      data: { status: "ARCHIVED", activatedAt: null },
    });
    return tx.assetVersion.update({
      where: { id: versionId },
      data: { status: "ACTIVE", activatedAt: new Date() },
    });
  });
}

/** Rollback = activate an older ARCHIVED/READY version (data-driven, no code change). */
export async function rollbackToVersion(versionId: string) {
  const v = await prisma.assetVersion.findUnique({ where: { id: versionId } });
  if (!v) throw new Error("VERSION_NOT_FOUND");
  if (v.status !== "ARCHIVED" && v.status !== "READY") throw new Error(`BAD_STATE:${v.status}`);
  await assertHasMappings(versionId);
  return prisma.$transaction(async (tx) => {
    await tx.assetVersion.updateMany({
      where: { assetId: v.assetId, status: "ACTIVE" },
      data: { status: "ARCHIVED", activatedAt: null },
    });
    return tx.assetVersion.update({
      where: { id: versionId },
      data: { status: "ACTIVE", activatedAt: new Date() },
    });
  });
}

export async function getActiveVersion(assetId: string) {
  return prisma.assetVersion.findFirst({
    where: { asset: { assetId }, status: "ACTIVE" },
  });
}

// ─────────────────────────── helpers ───────────────────────────

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** glTF-binary magic: "glTF" 0x46 0x54 0x4C 0x67 */
function isGlb(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x67 && buf[1] === 0x6c && buf[2] === 0x54 && buf[3] === 0x46;
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
}

function guessMime(name: string): string {
  return name.toLowerCase().endsWith(".glb") ? "model/gltf-binary" : "application/octet-stream";
}

// ─────────────────────────── Contract resolver v2 ───────────────────────────

export type AssetContractV2 = {
  assetId: string;
  vehicleId: string | null;
  versionId: string;
  versionNumber: number;
  format: string;
  source: string;
  /** P2-F (F1): URL for the active version's file. `null` = placeholder geometry;
   *  P2-H (H5): derived through the storage adapter (Supabase public URL in
   *  production, web-root path in dev). The stored fileUrl remains provenance. */
  fileUrl: string | null;
  checksumSha256: string | null;
  license: {
    licenseType: string | null;
    commercialUse: boolean;
    attributionText: string | null;
  };
  camera: { position: [number, number, number]; target: [number, number, number] };
  zones: {
    meshName: string;
    zoneKey: string;
    label: string | null;
    camera: { position: [number, number, number]; target: [number, number, number] };
    assemblyAsset: string | null;
    hotspot: [number, number, number] | null;
  }[];
  parts: {
    meshName: string;
    partId: string;
    partSlug: string | null;
    label: string | null;
    hotspot: [number, number, number] | null;
  }[];
};

function vec3(v: unknown): [number, number, number] | null {
  return Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === "number")
    ? [v[0] as number, v[1] as number, v[2] as number]
    : null;
}

/**
 * P2-H (H5/H8): browser URL derived through the storage adapter. If the object
 * is not in storage (e.g. the legacy tracked v2 GLB has not been backfilled
 * yet — surfaced by reconcileStorage() as asset_versions_without_storage),
 * fall back to the web-root path so the active viewer keeps rendering while
 * the backfill is pending. Storage errors never break rendering.
 */
async function deriveFileUrl(key: string): Promise<string> {
  try {
    const storage = getAssetStorage();
    if (await storage.exists(key)) return storage.getPublicUrl(key);
  } catch {
    // storage unconfigured/unreachable → static fallback below
  }
  return `/${key}`;
}

/**
 * Resolve the full contract for a vehicle's ACTIVE version, straight from MeshMapping rows.
 * The viewer renders exclusively from this — no mesh knowledge hard-coded.
 */
export async function resolveContract(vehicleId: string): Promise<AssetContractV2 | null> {
  const asset = await prisma.asset.findFirst({ where: { vehicleId } });
  if (!asset) return null;
  const version = await getActiveVersion(asset.assetId);
  if (!version) return null;

  const mappings = await prisma.meshMapping.findMany({
    where: { versionId: version.id },
    include: {
      zone: { select: { key: true, assemblies: { select: { slug: true }, orderBy: { title: "asc" }, take: 1 } } },
      assembly: { select: { slug: true } },
      part: { select: { slug: true } },
    },
    orderBy: [{ kind: "asc" }, { sortOrder: "asc" }],
  });

  const zones = mappings
    .filter((m) => m.kind === "zone" && m.zone)
    .map((m) => ({
      meshName: m.meshName,
      zoneKey: m.zone!.key,
      label: m.label,
      camera: {
        position: vec3(m.cameraPositionJson) ?? [6.5, 3.2, 7.5],
        target: vec3(m.cameraTargetJson) ?? [0, 0.7, 0],
      },
      assemblyAsset: m.assembly?.slug ?? m.assemblyId ?? m.zone?.assemblies[0]?.slug ?? null,
      hotspot: vec3(m.hotspotJson),
    }));

  const parts = mappings
    .filter((m) => m.kind === "part" && m.part)
    .map((m) => ({
      meshName: m.meshName,
      partId: m.partId!,
      partSlug: m.part?.slug ?? null,
      label: m.label,
      hotspot: vec3(m.hotspotJson),
    }));

  // Default camera = first zone with an explicit camera preset, else viewer default.
  const camWithCam = zones.find(
    (z) => JSON.stringify(z.camera.position) !== JSON.stringify([6.5, 3.2, 7.5]),
  );

  return {
    assetId: asset.assetId,
    vehicleId: asset.vehicleId,
    versionId: version.id,
    versionNumber: version.version,
    format: asset.format,
    source: asset.source,
    fileUrl: version.filePath && !version.filePath.startsWith("builtin:")
      ? await deriveFileUrl(version.filePath)
      : null,
    checksumSha256: version.checksumSha256 ?? null,
    license: {
      licenseType: version.licenseType,
      commercialUse: version.commercialUse,
      attributionText: version.attributionText,
    },
    camera: { position: camWithCam?.camera.position ?? [6.5, 3.2, 7.5], target: [0, 0.8, 0] },
    zones,
    parts,
  };
}
