import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { InMemoryStorage } from "@/lib/storage/memory";
import { StorageError, assertSafeKey, encodeKeyPath } from "@/lib/storage/types";
import { setAssetStorageForTests, getAssetStorage } from "@/lib/storage";
import { createAssetVersion } from "@/lib/asset-registry";
import { reconcileStorage } from "@/lib/asset-reconciliation";
/** Adapter-level bytes only: the storage provider does not parse GLB. */
const GLB = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(16, 0)]);

/**
 * P2-J: this file exercises storage mechanics, so the fixture is a minimal but
 * CONTAINER-VALID GLB (a real triangle). The old 20-byte "glTF"+zeros buffer is
 * no longer accepted anywhere in the pipeline — ingestion audits what it stores.
 */
function glbFixture(): Buffer {
  const positions = Buffer.alloc(3 * 3 * 4);
  const json = JSON.stringify({
    asset: { version: "2.0", generator: "p2h-storage-test" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Body", mesh: 0 }],
    meshes: [{ name: "Body_Mesh", primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{
      bufferView: 0, componentType: 5126, count: 3, type: "VEC3",
      min: [0, 0, 0], max: [1, 1, 0],
    }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
    buffers: [{ byteLength: positions.length }],
  });
  const pad = (b: Buffer, fill: number) => (b.length % 4 === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]));
  const jsonChunk = pad(Buffer.from(json, "utf8"), 0x20);
  const binChunk = pad(positions, 0);
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.write(type, 4, 4, "latin1");
    return Buffer.concat([head, data]);
  };
  const body = Buffer.concat([chunk("JSON", jsonChunk), chunk("BIN\0", binChunk)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

/** Minimal complete provenance so the audit reaches the storage layer. */
function p2jProvenance() {
  return {
    assetIdentity: "P2-H storage test fixture",
    sourceUrl: "https://github.com/aliferance-hub/poom",
    sourceProvider: "POOM test suite",
    creator: "POOM test suite",
    licenseType: "CC0-1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    commercialUse: "YES" as const,
    redistributionAllowed: "YES" as const,
    modificationAllowed: "YES" as const,
    attributionText: "POOM test fixture (CC0)",
    downloadDate: new Date().toISOString().slice(0, 10),
    originalFilename: "p2h-fixture.glb",
    intendedUsage: "storage adapter test",
    modifications: null,
    notes: null,
    variantClaim: null,
  };
}

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
    // Never delete a live production version; the suite's rows are RAW/REJECTED.
    await prisma.assetVersion.deleteMany({ where: { id, state: { notIn: ["PRODUCTION"] } } }).catch(() => {});
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
      fileBuffer: glbFixture(),
      fileName: "p2h-model.glb",
      mimeType: "model/gltf-binary",
      provenance: p2jProvenance(),
    });
    if (!v.ok) throw new Error(`ingest failed: ${v.error}`);
    createdVersionIds.push(v.versionId);
    // The valid fixture must clear the ingestion audit, otherwise nothing is
    // stored and this test would "pass" for the wrong reason.
    if (v.outcome !== "RAW") throw new Error(`fixture rejected: ${v.audit.problems.map((p) => p.code).join(",")}`);
    expect(getAssetStorage()).toBe(s);
    expect(s.size).toBe(before + 1);
    const row = await prisma.assetVersion.findUniqueOrThrow({ where: { id: v.versionId } });
    expect(row.filePath).toMatch(/^uploads\/assets\/peugeot-206-main-v1\/v\d+\/raw\/p2h-model\.glb$/);
    expect(row.fileUrl).toBe(`/${row.filePath}`);
    expect(row.state).toBe("RAW");
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
            fileBuffer: glbFixture(),
            fileName: "orphan.glb",
            provenance: p2jProvenance(),
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
      fileBuffer: glbFixture(),
      fileName: "recon.glb",
      mimeType: "model/gltf-binary",
      provenance: p2jProvenance(),
    });
    if (!v.ok) throw new Error(`ingest failed: ${v.error}`);
    createdVersionIds.push(v.versionId);
    await backfillExistingObjects();
    const report = await reconcileStorage();
    expect(report.assetVersionsWithoutStorage).toEqual([]);
    expect(report.storageObjectsWithoutAssetVersion).toEqual([]);
    expect(report.productionVersionsWithoutStorage).toEqual([]);
  });

  it("detects a DB row whose storage object is missing", async () => {
    const v = await createAssetVersion({
      assetId: assetBusinessId,
      fileBuffer: glbFixture(),
      fileName: "ghosted.glb",
      mimeType: "model/gltf-binary",
      provenance: p2jProvenance(),
    });
    if (!v.ok) throw new Error(`ingest failed: ${v.error}`);
    createdVersionIds.push(v.versionId);
    const row = await prisma.assetVersion.findUniqueOrThrow({ where: { id: v.versionId } });
    await getAssetStorage().delete(row.filePath); // simulate lost object
    const report = await reconcileStorage();
    expect(report.assetVersionsWithoutStorage).toContain(v.versionId);
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
