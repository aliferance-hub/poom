// P2-H (H8): storage↔database consistency boundary.
// Storage and PostgreSQL have no distributed transactions — this module makes
// the drift *visible* instead of pretending it cannot happen.
import { prisma } from "@/lib/prisma";
import { getAssetStorage } from "@/lib/storage";

export type ReconciliationReport = {
  provider: string;
  bucket: string;
  /** DB rows (non-builtin) whose object is missing from storage. */
  assetVersionsWithoutStorage: string[];
  /** Storage objects that no AssetVersion row references. */
  storageObjectsWithoutAssetVersion: string[];
  /** ACTIVE versions whose object is missing (worst case: viewer breaks). */
  activeAssetsWithoutStorage: string[];
  checkedAt: string;
};

/** Prefix used by the registry for every uploaded version of one asset. */
export function versionPrefix(assetBusinessId: string, version: number): string {
  return `uploads/assets/${assetBusinessId}/v${version}/`;
}

export async function reconcileStorage(): Promise<ReconciliationReport> {
  const storage = getAssetStorage();
  const versions = await prisma.assetVersion.findMany({
    where: { filePath: { not: { startsWith: "builtin:" } } },
    select: { id: true, filePath: true, status: true },
  });

  let objectKeys: string[] = [];
  try {
    objectKeys = await storage.listKeys("uploads/");
  } catch {
    // Storage unreachable → report as total mismatch rather than crash (H17).
    objectKeys = [];
    const report: ReconciliationReport = {
      provider: storage.provider,
      bucket: storage.bucket,
      assetVersionsWithoutStorage: versions.map((v) => v.id),
      storageObjectsWithoutAssetVersion: [],
      activeAssetsWithoutStorage: [],
      checkedAt: new Date().toISOString(),
    };
    return report;
  }
  const objectSet = new Set(objectKeys);

  const dbKeys = new Set(versions.map((v) => v.filePath).filter((k): k is string => Boolean(k)));
  const assetVersionsWithoutStorage = versions
    .filter((v) => v.filePath && !objectSet.has(v.filePath))
    .map((v) => v.id);

  const dbKeySet = dbKeys;
  const storageObjectsWithoutAssetVersion = [...objectSet].filter((k) => !dbKeySet.has(k));

  const active = await prisma.assetVersion.findMany({
    where: { status: "ACTIVE", filePath: { not: { startsWith: "builtin:" } } },
    select: { id: true, filePath: true },
  });
  const activeAssetsWithoutStorage = active
    .filter((v) => !objectSet.has(v.filePath ?? ""))
    .map((v) => v.id);

  return {
    provider: storage.provider,
    bucket: storage.bucket,
    assetVersionsWithoutStorage,
    storageObjectsWithoutAssetVersion,
    activeAssetsWithoutStorage,
    checkedAt: new Date().toISOString(),
  };
}
