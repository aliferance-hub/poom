import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { Document, NodeIO } from "@gltf-transform/core";
import { prune, dedup } from "@gltf-transform/functions";
import { PrismaClient } from "@prisma/client";
import { InMemoryStorage } from "@/lib/storage/memory";
import { getAssetStorage, setAssetStorageForTests } from "@/lib/storage";
import {
  createAssetVersion,
  mappingHealthRows,
  optimizeVersion,
  promoteVersion,
  recordRenderVerification,
  resolveContract,
  rollbackToVersion,
  stageVersion,
  validateVersion,
  type ProvenanceInput,
} from "@/lib/asset-registry";
import { canTransition, evaluatePromotion, summarizeMappingHealth } from "@/lib/asset-lifecycle";
import { reconcileStorage } from "@/lib/asset-reconciliation";
import { sha256 } from "@/lib/asset-validation";

const prisma = new PrismaClient();
const TEST_ASSET_ID = "peugeot-206-real-test-v1";

/** A real (if tiny) GLB: Body group + Body_Shell + Cylinder_Head meshes. */
async function fixtureGlb(opts: { withMaterials?: boolean } = {}): Promise<Buffer> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const material = doc.createMaterial("Paint").setBaseColorFactor([0.7, 0.12, 0.12, 1]);
  const positions: number[] = [];
  for (let i = 0; i < 36; i += 1) positions.push(i * 0.05, (i % 5) * 0.05, 0);
  const makeMesh = (name: string) => {
    const acc = doc.createAccessor(`${name}_POSITION`).setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer);
    const prim = doc.createPrimitive().setAttribute("POSITION", acc);
    if (opts.withMaterials !== false) prim.setMaterial(material);
    return doc.createMesh(name).addPrimitive(prim);
  };
  const body = doc.createNode("Body");
  body.addChild(doc.createNode("Body_Shell").setMesh(makeMesh("Body_Shell_Mesh")));
  body.addChild(doc.createNode("Cylinder_Head").setMesh(makeMesh("Cylinder_Head_Mesh")));
  doc.createScene("Scene").addChild(body);
  return Buffer.from(await new NodeIO().writeBinary(doc));
}

async function optimizedFixture(raw: Buffer): Promise<Buffer> {
  const doc = await new NodeIO().readBinary(new Uint8Array(raw));
  await doc.transform(prune(), dedup());
  return Buffer.from(await new NodeIO().writeBinary(doc));
}

function provenance(overrides: Partial<ProvenanceInput> = {}): ProvenanceInput {
  return {
    assetIdentity: "Peugeot 206",
    sourceUrl: "https://sketchfab.com/3d-models/peugeot-206-test-fixture",
    sourceProvider: "Sketchfab",
    creator: "p2j-test-creator",
    licenseType: "CC-BY-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    commercialUse: "YES",
    redistributionAllowed: "YES",
    modificationAllowed: "YES",
    attributionText: "\"Peugeot 206\" by p2j-test-creator (CC-BY-4.0)",
    downloadDate: new Date().toISOString().slice(0, 10),
    originalFilename: "peugeot-206.glb",
    intendedUsage: "product viewer",
    modifications: null,
    notes: "P2-J test fixture",
    variantClaim: null,
    ...overrides,
  };
}

const createdVersionIds: string[] = [];

async function realAssetRow() {
  const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
  return prisma.asset.upsert({
    where: { assetId: TEST_ASSET_ID },
    update: { kind: "REAL", vehicleId: vehicle.id },
    create: {
      assetId: TEST_ASSET_ID,
      kind: "REAL",
      vehicleId: vehicle.id,
      format: "glb",
      source: "P2J_TEST_FIXTURE",
      licenseNote: "test fixture asset (not a customer asset)",
    },
  });
}

async function ingestAndValidate(raw: Buffer, opts: { provenance?: Partial<ProvenanceInput> } = {}) {
  const created = await createAssetVersion({
    assetId: TEST_ASSET_ID,
    fileBuffer: raw,
    fileName: "peugeot-206-fixture.glb",
    mimeType: "model/gltf-binary",
    provenance: provenance(opts.provenance),
    actor: "test:ingest",
  });
  if (!created.ok) throw new Error(`ingest failed: ${created.error}`);
  createdVersionIds.push(created.versionId);
  const validated = await validateVersion(created.versionId, { actor: "test:validate" });
  expect(validated.ok, !validated.ok ? validated.problems?.join(",") : "").toBe(true);
  return created;
}

beforeAll(async () => {
  const count = await prisma.asset.count();
  if (count === 0) throw new Error("seed missing");
  setAssetStorageForTests(new InMemoryStorage());
  await realAssetRow();
});

beforeEach(() => {
  setAssetStorageForTests(new InMemoryStorage());
});

afterAll(async () => {
  await prisma.asset.deleteMany({ where: { assetId: TEST_ASSET_ID } }).catch(() => {}); // cascades versions + events
  setAssetStorageForTests(null);
  await prisma.$disconnect();
});

describe("P2-J state machine rules", () => {
  it("never lets a placeholder become production and forbids skipping pipeline steps", () => {
    expect(canTransition("PLACEHOLDER", "PRODUCTION").ok).toBe(false);
    expect(canTransition("PLACEHOLDER", "RETIRED").ok).toBe(true);
    expect(canTransition("RAW", "STAGED").ok).toBe(false);
    expect(canTransition("RAW", "VALIDATED").ok).toBe(true);
    expect(canTransition("VERIFIED", "PRODUCTION").ok).toBe(true);
    expect(canTransition("RETIRED", "PRODUCTION").ok).toBe(true);
    expect(canTransition("REJECTED", "RAW").ok).toBe(false);
    expect(canTransition("PRODUCTION", "REJECTED").ok).toBe(false);
  });

  it("fails every promotion gate when the evidence is missing", () => {
    const evaluation = evaluatePromotion({
      assetKind: "SYNTHETIC",
      state: "VERIFIED",
      validation: null,
      rawValidation: null,
      rights: { commercialUse: false, redistribution: false, modification: false },
      attribution: { text: null, required: true },
      mapping: summarizeMappingHealth([]),
      renderVerification: null,
      timestamps: { validatedAt: null, optimizedAt: null, stagedAt: null, verifiedAt: null },
      previousProduction: { exists: false, hasImmutableObject: false },
    });
    expect(evaluation.ok).toBe(false);
    expect(evaluation.blockers).toEqual(
      expect.arrayContaining([
        "REAL_ASSET", "PIPELINE_ORDER", "PROVENANCE", "RIGHTS", "ATTRIBUTION",
        "CHECKSUM", "TECHNICAL", "SECURITY", "SELF_CONTAINED", "PERFORMANCE",
        "RENDER_VERIFICATION", "MAPPING_INTEGRITY", "RAW_EVIDENCE",
      ]),
    );
  });
});

describe("P2-J ingestion (RAW)", () => {
  it("stores a valid, fully-provenanced file as RAW with a raw artifact key and hash", async () => {
    const raw = await fixtureGlb();
    const created = await createAssetVersion({
      assetId: TEST_ASSET_ID,
      fileBuffer: raw,
      fileName: "peugeot-206-fixture.glb",
      provenance: provenance(),
      actor: "test:ingest",
    });
    expect(created.ok).toBe(true);
    if (!created.ok || created.outcome !== "RAW") throw new Error("expected RAW outcome");
    createdVersionIds.push(created.versionId);

    const row = await prisma.assetVersion.findUniqueOrThrow({ where: { id: created.versionId } });
    expect(row.state).toBe("RAW");
    expect(row.rawFilePath).toBe(`uploads/assets/${TEST_ASSET_ID}/v${row.version}/raw/peugeot-206-fixture.glb`);
    expect(row.rawChecksumSha256).toBe(sha256(raw));
    expect(row.filePath).toBe(row.rawFilePath);
    expect(created.audit.verdict).toBe("PASS");
    expect(created.audit.inventory?.meshNodeCount).toBe(2);

    const events = await prisma.assetEventLog.findMany({ where: { versionId: created.versionId } });
    expect(events.map((e) => e.event)).toContain("created");
  });

  it("records an unusable license as REJECTED without ever storing the bytes", async () => {
    const raw = await fixtureGlb();
    const created = await createAssetVersion({
      assetId: TEST_ASSET_ID,
      fileBuffer: raw,
      fileName: "noncommercial.glb",
      provenance: provenance({ licenseType: "CC-BY-NC-4.0" }),
      actor: "test:ingest",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unexpected failure");
    expect(created.outcome).toBe("REJECTED");
    createdVersionIds.push(created.versionId);

    const row = await prisma.assetVersion.findUniqueOrThrow({ where: { id: created.versionId } });
    expect(row.state).toBe("REJECTED");
    expect(row.filePath).toBe("rejected:never-stored");
    expect(await new InMemoryStorage().listKeys()).toEqual([]);
    expect(row.rejectionReason).toContain("LICENSE_RESTRICTED");
  });

  it("rejects a non-GLB payload before storage", async () => {
    const created = await createAssetVersion({
      assetId: TEST_ASSET_ID,
      fileBuffer: Buffer.from("<html>definitely not a model</html>"),
      fileName: "fake.glb",
      provenance: provenance(),
      actor: "test:ingest",
    });
    if (!created.ok) throw new Error("unexpected failure");
    expect(created.outcome).toBe("REJECTED");
    createdVersionIds.push(created.versionId);
    const row = await prisma.assetVersion.findUniqueOrThrow({ where: { id: created.versionId } });
    expect(row.rejectionReason).toContain("NOT_A_GLB");
  });

  it("refuses an exception file (missing source URL) rather than guessing provenance", async () => {
    const created = await createAssetVersion({
      assetId: TEST_ASSET_ID,
      fileBuffer: await fixtureGlb(),
      fileName: "unknown-source.glb",
      provenance: provenance({ sourceUrl: "https://example.org/peugeot-206.glb", creator: null }),
      actor: "test:ingest",
    });
    if (!created.ok) throw new Error("unexpected failure");
    expect(created.outcome).toBe("REJECTED");
    createdVersionIds.push(created.versionId);
  });
});

describe("P2-J pipeline → promotion → rollback", () => {
  it("walks RAW → VALIDATED → OPTIMIZED → STAGED → VERIFIED → PRODUCTION and audits every step", async () => {
    const raw = await fixtureGlb();
    const { versionId, audit } = await ingestAndValidate(raw);

    const optimized = await optimizedFixture(raw);
    const opt = await optimizeVersion(versionId, {
      optimizedBuffer: optimized,
      fileName: "peugeot-206-optimized.glb",
      optimizer: { tool: "p2j-test", settings: { prune: true, dedup: true } },
      requiredMeshNames: ["Body_Shell", "Cylinder_Head"],
      actor: "test:optimize",
    });
    expect(opt.ok, !opt.ok ? opt.problems?.join(",") : "").toBe(true);
    const afterOptimize = await prisma.assetVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(afterOptimize.state).toBe("OPTIMIZED");
    expect(afterOptimize.filePath).toContain("/optimized/");
    expect(afterOptimize.rawFilePath).toContain("/raw/");
    expect(afterOptimize.optimizationJson).toBeTruthy();

    // A mapping whose fingerprint comes from the measured inventory → VALID.
    const zone = await prisma.vehicleZone.findFirstOrThrow({
      where: { key: "body" },
      orderBy: { sortOrder: "asc" },
    });
    const bodyShell = audit.inventory!.entries.find((e) => e.nodeName === "Body_Shell")!;
    await prisma.meshMapping.create({
      data: {
        versionId, meshName: "Body_Shell", kind: "zone", zoneId: zone.id,
        meshFingerprint: bodyShell.fingerprint, hotspotJson: [0, 0.6, 0],
      },
    });
    const health = await mappingHealthRows(versionId);
    expect(health.map((h) => h.status)).toEqual(["MAPPING_VALID"]);

    const staged = await stageVersion(versionId, { actor: "test:stage" });
    expect(staged.ok).toBe(true);

    // Promotion is impossible before the render verification is recorded.
    const premature = await promoteVersion(versionId, { actor: "test:promote" });
    expect(premature.ok).toBe(false);
    if (!premature.ok) expect(premature.error).toContain("BAD_STATE");

    const verified = await recordRenderVerification(versionId, {
      source: "preview",
      url: "https://poom-preview.vercel.app/vehicles/peugeot/206/type-5",
      checkedAt: new Date().toISOString(),
      by: "test:verify",
      viewports: ["desktop", "mobile"],
      observations: ["mock vehicle renders"],
      consoleErrors: 0,
      networkFailures: 0,
      webglErrors: 0,
    }, { actor: "test:verify" });
    expect(verified.ok, !verified.ok ? verified.error : "").toBe(true);

    const promoted = await promoteVersion(versionId, { actor: "test:promote", note: "test promotion" });
    expect(promoted.ok, !promoted.ok ? `${promoted.error}:${promoted.problems?.join(",")}` : "").toBe(true);
    const live = await prisma.assetVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(live.state).toBe("PRODUCTION");
    expect(live.promotedAt).not.toBeNull();

    // Customer contract now resolves the REAL production version and may claim
    // the mapped part; the synthetic placeholder is not what customers get.
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
    const contract = await resolveContract(vehicle.id);
    expect(contract?.assetId).toBe(TEST_ASSET_ID);
    expect(contract?.assetKind).toBe("REAL");
    expect(contract?.availability.vehicle3d).toBe("REAL");
    expect(contract?.zones[0]?.trusted).toBe(true);

    const events = await prisma.assetEventLog.findMany({ where: { versionId }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining(["created", "validated", "optimized", "staged", "verified", "promoted"]),
    );

    // ── rollback: promote a second version, then bring the first one back ──
    const second = await ingestAndValidate(await fixtureGlb());
    const secondOpt = await optimizeVersion(second.versionId, {
      optimizedBuffer: await optimizedFixture(await fixtureGlb()),
      fileName: "second-optimized.glb",
      optimizer: { tool: "p2j-test", settings: {} },
      requiredMeshNames: ["Body_Shell"],
      actor: "test:optimize",
    });
    expect(secondOpt.ok, !secondOpt.ok ? secondOpt.problems?.join(",") : "").toBe(true);
    await prisma.meshMapping.create({
      data: { versionId: second.versionId, meshName: "Cylinder_Head", kind: "zone", zoneId: zone.id },
    });
    expect((await stageVersion(second.versionId, { actor: "test:stage" })).ok).toBe(true);
    expect((await recordRenderVerification(second.versionId, {
      source: "preview", url: "https://poom-preview.vercel.app/x", checkedAt: new Date().toISOString(),
      by: "test:verify", viewports: ["desktop"], observations: [],
    }, { actor: "test:verify" })).ok).toBe(true);
    const promotedSecond = await promoteVersion(second.versionId, { actor: "test:promote" });
    expect(promotedSecond.ok, !promotedSecond.ok ? `${promotedSecond.error}:${promotedSecond.problems?.join(",")}` : "").toBe(true);
    expect(promotedSecond.ok && promotedSecond.retiredPrevious).toBe(live.version);

    const rolledBack = await rollbackToVersion(versionId, { actor: "test:rollback", reason: "regression in v2" });
    expect(rolledBack.ok, !rolledBack.ok ? `${rolledBack.error}:${rolledBack.problems?.join(",")}` : "").toBe(true);
    const restored = await prisma.assetVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(restored.state).toBe("PRODUCTION");
    const superseded = await prisma.assetVersion.findUniqueOrThrow({ where: { id: second.versionId } });
    expect(superseded.state).toBe("RETIRED");
    expect(superseded.filePath).toBeTruthy(); // rollback asset kept, not deleted
    const rollbackEvents = await prisma.assetEventLog.findMany({ where: { event: "rolled_back" } });
    expect(rollbackEvents.length).toBeGreaterThan(0);
  });

  it("detects mapping drift: a renamed/removed node invalidates the mapping", async () => {
    const raw = await fixtureGlb();
    const { versionId, audit } = await ingestAndValidate(raw);
    const zone = await prisma.vehicleZone.findFirstOrThrow({ where: { key: "body" } });
    const entry = audit.inventory!.entries.find((e) => e.nodeName === "Cylinder_Head")!;
    const mapping = await prisma.meshMapping.create({
      data: { versionId, meshName: "Cylinder_Head", kind: "zone", zoneId: zone.id, meshFingerprint: entry.fingerprint },
    });

    expect((await mappingHealthRows(versionId))[0]?.status).toBe("MAPPING_VALID");

    // Simulate a new inventory where the node is gone (drift, §27).
    const stored = await prisma.assetVersion.findUniqueOrThrow({ where: { id: versionId } });
    const auditJson = stored.validationJson as Record<string, unknown>;
    const inventory = auditJson.inventory as Record<string, unknown>;
    const entries = (inventory.entries as { nodeName: string }[]).filter((e) => e.nodeName !== "Cylinder_Head");
    await prisma.assetVersion.update({
      where: { id: versionId },
      data: { validationJson: { ...auditJson, inventory: { ...inventory, entries } } },
    });
    const afterDrift = await mappingHealthRows(versionId);
    expect(afterDrift.find((h) => h.mappingId === mapping.id)?.status).toBe("MAPPING_INVALID");
    expect(afterDrift.find((h) => h.mappingId === mapping.id)?.detail).toBe("NODE_MISSING");

    // …and a legacy mapping without a fingerprint is never assumed valid.
    await prisma.meshMapping.update({ where: { id: mapping.id }, data: { meshFingerprint: null } });
    await prisma.assetVersion.update({
      where: { id: versionId },
      data: { validationJson: stored.validationJson as object },
    });
    expect((await mappingHealthRows(versionId))[0]?.status).toBe("MAPPING_NEEDS_REVIEW");
    expect((await mappingHealthRows(versionId))[0]?.detail).toBe("FINGERPRINT_NOT_RECORDED");
  });

  it("keeps the synthetic placeholder out of production and reports it as a placeholder", async () => {
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
    const synthetic = await prisma.asset.findUniqueOrThrow({ where: { assetId: "peugeot-206-main-v1" } });
    expect(synthetic.kind).toBe("SYNTHETIC");
    const versions = await prisma.assetVersion.findMany({ where: { assetId: synthetic.id } });
    expect(versions.every((v) => v.state === "PLACEHOLDER")).toBe(true);

    // The real test asset was promoted earlier in this file, so the customer
    // contract is REAL — the synthetic stand-in is not what anyone sees.
    const live = await resolveContract(vehicle.id);
    expect(live?.assetKind).toBe("REAL");
    expect(live?.state).toBe("PRODUCTION");
    expect(live?.assetId).toBe(TEST_ASSET_ID);

    // A vehicle with no asset at all resolves to null instead of a fake model.
    expect(await resolveContract("no-such-vehicle")).toBeNull();
  });

  it("reconciles storage against both artifacts and keeps rejected files out of the bucket", async () => {
    const raw = await fixtureGlb();
    const { versionId } = await ingestAndValidate(raw);
    await optimizeVersion(versionId, {
      optimizedBuffer: await optimizedFixture(raw),
      fileName: "recon-optimized.glb",
      optimizer: { tool: "p2j-test", settings: {} },
      requiredMeshNames: ["Body_Shell", "Cylinder_Head"],
      actor: "test:optimize",
    });
    const version = await prisma.assetVersion.findUniqueOrThrow({ where: { id: versionId } });
    const keys = await getAssetStorage().listKeys("uploads/");
    expect(keys).toContain(version.filePath);
    expect(keys).toContain(version.rawFilePath);

    const report = await reconcileStorage();
    expect(report.assetVersionsWithoutStorage).not.toContain(versionId);
    expect(report.rawArtifactsWithoutStorage).not.toContain(versionId);
    expect(report.storageObjectsWithoutAssetVersion).toEqual([]);
    expect(report.rejectedVersionsWithStorage).toEqual([]);
  });
});
