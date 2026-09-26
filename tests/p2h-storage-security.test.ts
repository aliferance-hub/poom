import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { InMemoryStorage } from "@/lib/storage/memory";
import { StorageError, assertSafeKey, encodeKeyPath } from "@/lib/storage/types";
import { setAssetStorageForTests, getAssetStorage } from "@/lib/storage";
import { createAssetVersion } from "@/lib/asset-registry";
import { reconcileStorage } from "@/lib/asset-reconciliation";
const GLB = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(16, 0)]);

/** Expects fn() to reject with a StorageError carrying `code` (or throw code directly). */
async function expectStorageCode(fn: () => Promise<unknown> | unknown, code: string) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof StorageError) {
      expect(e.code).toBe(code);
      return;
    }
    if (e instanceof Error && (e.message === code || e.message.startsWith(code + ":"))) {
      return;
    }
    throw e;
  }
  throw new Error(`expected error with code ${code}, but call succeeded`);
}

let assetBusinessId = "peugeot-206-main-v1";
let createdVersionIds: string[] = [];

beforeEach(() => {
  setAssetStorageForTests(new InMemoryStorage());
});

afterEach(async () => {
  for (const id of createdVersionIds) {
    await prisma.assetVersion.deleteMany({ where: { id, status: { notIn: ["ACTIVE"] } } }).catch(() => {});
  }
  createdVersionIds = [];
  setAssetStorageForTests(null);
});

describe("P2-H storage adapter contract", () => {
  it("upload → exists → metadata → delete round-trip", async () => {
    const s = getAssetStorage();
    await s.upload("uploads/assets/x/v1/a.glb", GLB, { contentType: "model/gltf-binary" });
    expect(await s.exists("uploads/assets/x/v1/a.glb")).toBe(true);
    const meta = await s.metadata("uploads/assets/x/v1/a.glb");
    expect(meta?.size).toBe(GLB.length);
    expect(meta?.contentType).toBe("model/gltf-binary");
    await s.delete("uploads/assets/x/v1/a.glb");
    expect(await s.exists("uploads/assets/x/v1/a.glb")).toBe(false);
  });

  it("rejects overwriting an existing object key (immutable paths, H6)", async () => {
    const s = getAssetStorage();
    const key = "uploads/assets/x/v1/dup.glb";
    await s.upload(key, GLB, { contentType: "model/gltf-binary" });
    await expectStorageCode(
      () => s.upload(key, GLB, { contentType: "model/gltf-binary" }),
      "OBJECT_EXISTS",
    );
    await s.delete(key);
  });

  it("delete of a missing object is idempotent", async () => {
    const s = getAssetStorage();
    await expect(s.delete("uploads/assets/x/v9/never-existed.glb")).resolves.toBeUndefined();
  });

  it("listKeys returns recursive keys under a prefix", async () => {
    const s = getAssetStorage();
    await s.upload("uploads/assets/x/v1/one.glb", GLB, { contentType: "model/gltf-binary" });
    await s.upload("uploads/assets/x/v2/two.glb", GLB, { contentType: "model/gltf-binary" });
    const keys = await s.listKeys("uploads/assets/x/");
    expect(keys.sort()).toEqual(["uploads/assets/x/v1/one.glb", "uploads/assets/x/v2/two.glb"]);
    await s.delete("uploads/assets/x/v1/one.glb");
    await s.delete("uploads/assets/x/v2/two.glb");
  });
});

describe("P2-H object key hardening (H7)", () => {
  const badKeys = [
    "../escape.glb",
    "uploads/../../etc/passwd",
    "uploads/./x.glb",
    "/absolute/path.glb",
    "uploads//double.glb",
    "uploads\\windows\\path.glb",
    "uploads/\0null.glb",
    "uploads/enc/%2e%2e/escape.glb",
    "uploads/enc/%2f/x.glb",
    "uploads/enc/%00/x.glb",
  ];
  for (const key of badKeys) {
    it(`rejects key "${key}"`, () => {
      expect(() => assertSafeKey(key)).toThrow(StorageError);
    });
  }

  it("accepts a legitimate versioned key", () => {
    expect(assertSafeKey("uploads/assets/peugeot-206-main-v1/v2/model.glb")).toBe(
      "uploads/assets/peugeot-206-main-v1/v2/model.glb",
    );
  });

  it("encodes URL path segments without touching separators", () => {
    expect(encodeKeyPath("uploads/assets/a b/v1/x+y.glb")).toBe("uploads/assets/a%20b/v1/x%2By.glb");
  });
});

describe("P2-H upload ↔ DB consistency (H8)", () => {
  it("creates the object alongside the AssetVersion row", async () => {
    const s = getAssetStorage() as InMemoryStorage;
    const before = s.size;
    const v = await createAssetVersion({
      assetId: assetBusinessId,
      fileBuffer: GLB,
      fileName: "p2h-model.glb",
      mimeType: "model/gltf-binary",
      license: { licenseType: "CC0", commercialUse: false },
    });
    createdVersionIds.push(v.id);
    expect(s.size).toBe(before + 1);
    expect(v.filePath).toMatch(/^uploads\/assets\/peugeot-206-main-v1\/v\d+\/p2h-model\.glb$/);
    expect(v.fileUrl).toBe(`/${v.filePath}`);
  });

  it("compensates: DB failure after successful upload removes the orphan object", async () => {
    const s = getAssetStorage() as InMemoryStorage;
    const before = s.size;
    // Manual override/restore: vi.spyOn does not survive Prisma delegates
    // (restoring leaves the property undefined for subsequent tests).
    const delegate = prisma.assetVersion as unknown as Record<string, unknown>;
    const originalCreate = delegate.create;
    delegate.create = async () => {
      throw new Error("SIMULATED_DB_FAILURE");
    };
    try {
      await expectStorageCode(
        () =>
          createAssetVersion({
            assetId: assetBusinessId,
            fileBuffer: GLB,
            fileName: "orphan.glb",
            license: { licenseType: "CC0", commercialUse: false },
          }),
        "SIMULATED_DB_FAILURE",
      );
    } finally {
      delegate.create = originalCreate; // deterministic restore
    }
    expect(s.size).toBe(before); // uploaded object was compensated away — no leak
  });
});

describe("P2-H reconciliation checks (H8)", () => {
  /** Backfill: give every pre-existing non-builtin DB row its storage object.
   *  Mirrors the real H5 rollout step that uploads the tracked v2 GLB into the
   *  bucket under the SAME key so the row needs no migration. */
  async function backfillExistingObjects(): Promise<void> {
    const s = getAssetStorage();
    const rows = await prisma.assetVersion.findMany({
      where: { filePath: { not: { startsWith: "builtin:" } } },
      select: { filePath: true },
    });
    for (const r of rows) {
      if (r.filePath && !(await s.exists(r.filePath))) {
        await s.upload(r.filePath, GLB, { contentType: "model/gltf-binary" });
      }
    }
  }

  it("reports clean when everything matches", async () => {
    const v = await createAssetVersion({
      assetId: assetBusinessId,
      fileBuffer: GLB,
      fileName: "recon.glb",
      mimeType: "model/gltf-binary",
      license: { licenseType: "CC0", commercialUse: false },
    });
    createdVersionIds.push(v.id);
    await backfillExistingObjects();
    const report = await reconcileStorage();
    expect(report.assetVersionsWithoutStorage).toEqual([]);
    expect(report.storageObjectsWithoutAssetVersion).toEqual([]);
    expect(report.activeAssetsWithoutStorage).toEqual([]);
  });

  it("detects a DB row whose storage object is missing", async () => {
    const v = await createAssetVersion({
      assetId: assetBusinessId,
      fileBuffer: GLB,
      fileName: "ghosted.glb",
      mimeType: "model/gltf-binary",
      license: { licenseType: "CC0", commercialUse: false },
    });
    createdVersionIds.push(v.id);
    await getAssetStorage().delete(v.filePath!); // simulate lost object
    const report = await reconcileStorage();
    expect(report.assetVersionsWithoutStorage).toContain(v.id);
  });

  it("detects an orphaned storage object", async () => {
    const orphanKey = `uploads/assets/peugeot-206-main-v1/v9999/orphan.glb`;
    await getAssetStorage().upload(orphanKey, GLB, { contentType: "model/gltf-binary" });
    try {
      const report = await reconcileStorage();
      expect(report.storageObjectsWithoutAssetVersion).toContain(orphanKey);
    } finally {
      await getAssetStorage().delete(orphanKey);
    }
  });
});
