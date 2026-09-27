// P2-H (H8) / P2-J: storage↔database consistency boundary.
// Storage and PostgreSQL have no distributed transactions — this module makes
// the drift *visible* instead of pretending it cannot happen. P2-J extends the
// check to the two artifacts a version may hold (raw source + active/optimized)
// and to the permanent invariant that a REJECTED version was never uploaded.
import { prisma } from "@/lib/prisma";
import { getAssetStorage } from "@/lib/storage";

export type ReconciliationReport = {
  provider: string;
  bucket: string;
  /** DB rows (non-builtin) whose ACTIVE artifact object is missing from storage. */
  assetVersionsWithoutStorage: string[];
  /** Raw (immutable) artifacts referenced by a row but missing from storage. */
  rawArtifactsWithoutStorage: string[];
  /** Storage objects that no AssetVersion row references (active or raw). */
  storageObjectsWithoutAssetVersion: string[];
  /** PRODUCTION versions whose object is missing (worst case: viewer breaks). */
  productionVersionsWithoutStorage: string[];
  /** Rejected artifacts must never have been uploaded (fail-closed rule). */
  rejectedVersionsWithStorage: string[];
  checkedAt: string;
};

/** Prefix used by the registry for every uploaded artifact of one asset. */
export function versionPrefix(assetBusinessId: string, version: number): string {
  return `uploads/assets/${assetBusinessId}/v${version}/`;
}

export async function reconcileStorage(): Promise<ReconciliationReport> {
  const storage = getAssetStorage();
  const versions = await prisma.assetVersion.findMany({
    select: { id: true, filePath: true, rawFilePath: true, state: true },
  });
  const physical = versions.filter((v) => !v.filePath.startsWith("builtin:") && !v.filePath.startsWith("rejected:"));

  let objectKeys: string[] = [];
  try {
    objectKeys = await storage.listKeys("uploads/");
  } catch {
    // Storage unreachable → report as total mismatch rather than crash (H17).
    return {
      provider: storage.provider,
      bucket: storage.bucket,
      assetVersionsWithoutStorage: physical.map((v) => v.id),
      rawArtifactsWithoutStorage: versions.filter((v) => v.rawFilePath).map((v) => v.id),
      storageObjectsWithoutAssetVersion: [],
      productionVersionsWithoutStorage: physical.filter((v) => v.state === "PRODUCTION").map((v) => v.id),
      rejectedVersionsWithStorage: [],
      checkedAt: new Date().toISOString(),
    };
  }
  const objectSet = new Set(objectKeys);

  const assetVersionsWithoutStorage = physical.filter((v) => !objectSet.has(v.filePath)).map((v) => v.id);
  const rawArtifactsWithoutStorage = versions
    .filter((v) => v.rawFilePath && v.rawFilePath !== v.filePath && !objectSet.has(v.rawFilePath))
    .map((v) => v.id);

  const referenced = new Set<string>();
  for (const v of versions) {
    if (!v.filePath.startsWith("builtin:") && !v.filePath.startsWith("rejected:")) referenced.add(v.filePath);
    if (v.rawFilePath) referenced.add(v.rawFilePath);
  }
  const storageObjectsWithoutAssetVersion = [...objectSet].filter((k) => !referenced.has(k));

  const productionVersionsWithoutStorage = physical
    .filter((v) => v.state === "PRODUCTION" && !objectSet.has(v.filePath))
    .map((v) => v.id);

  // A rejected file must have been refused *before* storage: if an object exists
  // for a REJECTED row, the fail-closed rule was violated somewhere.
  const rejectedVersionsWithStorage = versions
    .filter((v) => v.state === "REJECTED" && !v.filePath.startsWith("rejected:") && !v.filePath.startsWith("builtin:"))
    .map((v) => v.id);

  return {
    provider: storage.provider,
    bucket: storage.bucket,
    assetVersionsWithoutStorage,
    rawArtifactsWithoutStorage,
    storageObjectsWithoutAssetVersion,
    productionVersionsWithoutStorage,
    rejectedVersionsWithStorage,
    checkedAt: new Date().toISOString(),
  };
}
