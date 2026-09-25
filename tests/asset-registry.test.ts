import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  createAssetVersion, markProcessing, validateVersion, activateVersion,
  rollbackToVersion, getActiveVersion, resolveContract,
} from "@/lib/asset-registry";

const prisma = new PrismaClient();
const GLB_MAGIC = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(16, 0)]);

async function assetId(): Promise<string> {
  const a = await prisma.asset.findFirstOrThrow({ where: { assetId: "peugeot-206-main-v1" } });
  return a.id; // internal cuid
}

let createdVersionIds: string[] = [];
let preExistingActiveId: string | null = null;

beforeAll(async () => {
  const count = await prisma.asset.count();
  if (count === 0) throw new Error("seed missing");
  const asset = await prisma.asset.findUniqueOrThrow({ where: { assetId: "peugeot-206-main-v1" } });
  preExistingActiveId = (await prisma.assetVersion.findFirst({ where: { assetId: asset.id, status: "ACTIVE" } }))?.id ?? null;
});

afterAll(async () => {
  // remove test-created versions (ACTIVE one first is fine — status transitions only)
  for (const id of createdVersionIds) {
    await prisma.assetVersion.deleteMany({ where: { id, status: { notIn: ["ACTIVE"] } } }).catch(() => {});
  }
  // restore whichever version was ACTIVE before this file ran — the app's active
  // asset is data, not a test fixture (v2 is the shipped engineering GLB; v1 is
  // only the fallback placeholder).
  const asset = await prisma.asset.findUniqueOrThrow({ where: { assetId: "peugeot-206-main-v1" } });
  if (preExistingActiveId) {
    const active = await prisma.assetVersion.findFirst({ where: { assetId: asset.id, status: "ACTIVE" } });
    if (!active || active.id !== preExistingActiveId) {
      await prisma.assetVersion.updateMany({ where: { assetId: asset.id, status: "ACTIVE" }, data: { status: "ARCHIVED" } });
      await prisma.assetVersion.update({ where: { id: preExistingActiveId }, data: { status: "ACTIVE", activatedAt: new Date() } });
    }
  } else {
    // legacy fallback: no pre-captured active → keep v1 ACTIVE (original behavior)
    const v1 = await prisma.assetVersion.findUniqueOrThrow({ where: { assetId_version: { assetId: asset.id, version: 1 } } });
    if (v1.status !== "ACTIVE") {
      await prisma.assetVersion.updateMany({ where: { assetId: asset.id, status: "ACTIVE" }, data: { status: "ARCHIVED" } });
      await prisma.assetVersion.update({ where: { id: v1.id }, data: { status: "ACTIVE", activatedAt: new Date() } });
    }
  }
  await prisma.$disconnect();
});

describe("asset version lifecycle (P2-A)", () => {
  it("creates DRAFT with checksum, refuses publish without validation", async () => {
    const aid = await assetId();
    const v = await createAssetVersion({
      assetId: "peugeot-206-main-v1",
      fileBuffer: GLB_MAGIC,
      fileName: "test-model.glb",
      mimeType: "model/gltf-binary",
      license: { licenseType: "CC-BY-4.0", commercialUse: true, creator: "tester" },
    });
    createdVersionIds.push(v.id);
    expect(v.status).toBe("DRAFT");
    expect(v.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(v.fileSize).toBe(GLB_MAGIC.length);
    expect(v.mimeType).toBe("model/gltf-binary");

    // DRAFT cannot jump to ACTIVE
    await expect(activateVersion(v.id)).rejects.toThrow(/BAD_STATE:DRAFT/);
  });

  it("rejects non-GLB buffers at validation (magic bytes)", async () => {
    const aid = await assetId();
    const v = await createAssetVersion({
      assetId: "peugeot-206-main-v1",
      fileBuffer: Buffer.from("<html>not a model</html>"),
      fileName: "fake.glb",
      license: { licenseType: "CC0", commercialUse: false },
    });
    createdVersionIds.push(v.id);
    await markProcessing(v.id);
    const result = await validateVersion(v.id, Buffer.from("<html>not a model</html>"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain("NOT_A_GLB");
    const after = await prisma.assetVersion.findUniqueOrThrow({ where: { id: v.id } });
    expect(after.status).toBe("REJECTED");
  });

  it("commercial use without license metadata is rejected", async () => {
    const v = await createAssetVersion({
      assetId: "peugeot-206-main-v1",
      fileBuffer: GLB_MAGIC,
      fileName: "commercial.glb",
      license: { licenseType: "", commercialUse: true },
    });
    createdVersionIds.push(v.id);
    await markProcessing(v.id);
    const result = await validateVersion(v.id, GLB_MAGIC);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain("COMMERCIAL_USE_NEEDS_LICENSE");
  });

  it("full lifecycle: DRAFT → PROCESSING → READY → ACTIVE, archiving previous active; rollback restores", async () => {
    const original = await getActiveVersion("peugeot-206-main-v1");
    expect(original).not.toBeNull();
    expect(original!.status).toBe("ACTIVE");

    // create + validate a new version
    const v = await createAssetVersion({
      assetId: "peugeot-206-main-v1",
      fileBuffer: GLB_MAGIC,
      fileName: "candidate.glb",
      license: {
        licenseType: "CC-BY-4.0",
        commercialUse: true,
        creator: "POOM test fixture",
        acquiredAt: new Date(),
        intendedUsage: "registry lifecycle test",
        modifications: "none",
      },
    });
    createdVersionIds.push(v.id);
    await markProcessing(v.id);
    const validated = await validateVersion(v.id, GLB_MAGIC);
    expect(validated.ok).toBe(true);
    expect((await prisma.assetVersion.findUniqueOrThrow({ where: { id: v.id } })).status).toBe("READY");

    // EMPTY_MAPPING_SET guard: a version with no mesh mappings must not go ACTIVE
    await expect(activateVersion(v.id)).rejects.toThrow(/EMPTY_MAPPING_SET/);

    // simulate the Mapping Studio assigning one mesh to the candidate version
    const anyZone = await prisma.vehicleZone.findFirstOrThrow({ orderBy: { sortOrder: "asc" } });
    await prisma.meshMapping.create({
      data: { versionId: v.id, meshName: "zone_body", kind: "zone", zoneId: anyZone.id },
    });

    // activate → previous ACTIVE archived, exactly one ACTIVE remains
    await activateVersion(v.id);
    const versions = await prisma.assetVersion.findMany({ where: { assetId: (await assetId()) } });
    const actives = versions.filter((x) => x.status === "ACTIVE");
    expect(actives.length).toBe(1);
    expect(actives[0]!.id).toBe(v.id);
    expect(actives[0]!.activatedAt).not.toBeNull();

    // contract resolver serves the NEW version now
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
    const contract = await resolveContract(vehicle.id);
    expect(contract?.versionId).toBe(v.id);

    // rollback restores original and keeps single-active invariant
    await rollbackToVersion(original!.id);
    const actives2 = (await prisma.assetVersion.findMany({ where: { assetId: (await assetId()) } }))
      .filter((x) => x.status === "ACTIVE");
    expect(actives2.length).toBe(1);
    expect(actives2[0]!.id).toBe(original!.id);
    const contract2 = await resolveContract(vehicle.id);
    expect(contract2?.versionId).toBe(original!.id);
  });
});

describe("Asset Contract v2 (from MeshMapping)", () => {
  it("exposes zones with camera presets + hotspot fields and parts with slugs", async () => {
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
    const c = await resolveContract(vehicle.id);
    expect(c).not.toBeNull();
    // The active version is data (v1 placeholder or v2 engineering GLB) — assert
    // the contract SHAPE, not which version happens to be activated.
    expect(c!.versionNumber).toBeGreaterThanOrEqual(1);
    expect(c!.license.licenseType).toBeTruthy();
    expect(c!.zones.length).toBe(8);
    const cooling = c!.zones.find((z) => z.zoneKey === "cooling")!;
    expect(cooling.meshName).toBe("zone_cooling");
    expect(cooling.camera.position).toEqual([2.6, 1.8, 3.4]);
    expect(cooling.hotspot).toEqual([0, 0.62, 1.62]);
    const radiator = c!.parts.find((p) => p.meshName === "part_radiator_main")!;
    // P2-F (F2): part_radiator_main now maps to the real imported part
    expect(radiator.partSlug).toBe("radiator-assembly");
    expect(radiator.hotspot).toEqual([0, 0.62, 1.62]);
    // the golden chain survives: cooling → assembly + radiator part mapping
    expect(cooling.assemblyAsset).toBe("assembly-cooling");
  });
});
