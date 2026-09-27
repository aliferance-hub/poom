import { describe, expect, it } from "vitest";
import { auditAsset, summarizeAudit, sha256 } from "@/lib/asset-validation";
import { parseGlb } from "@/lib/asset-validation/glb";
import { validateProvenance, rightsAllowProduction, type ProvenanceRecord } from "@/lib/asset-validation/provenance";
import { compareAudits } from "@/lib/asset-validation/compare";
import { imageDimensions } from "@/lib/asset-validation/inventory";
import { LIMITS } from "@/lib/asset-validation/types";
import { prune, dedup } from "@gltf-transform/functions";
import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";

// ─────────────────────────── fixtures ───────────────────────────

type Json = Record<string, unknown>;

function padTo4(buf: Buffer, fill: number): Buffer {
  const rem = buf.length % 4;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(4 - rem, fill)]);
}

function glbChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(data.length, 0);
  head.write(type, 4, 4, "latin1");
  return Buffer.concat([head, data]);
}

/** Build a real GLB container from a JSON document + optional binary chunk. */
function buildGlb(json: Json, bin?: Buffer, extra?: { type: string; data: Buffer }): Buffer {
  const jsonPadded = padTo4(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const parts = [glbChunk("JSON", jsonPadded)];
  if (bin) parts.push(glbChunk("BIN\0", padTo4(bin, 0x00)));
  if (extra) parts.push(glbChunk(extra.type, padTo4(extra.data, 0x00)));
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

/** A self-contained triangle mesh: `triangleCount` triangles, one material, named node/mesh. */
function triangleAsset(opts: {
  triangleCount?: number;
  nodeName?: string | null;
  meshName?: string;
  extraJson?: Json;
  extraNodes?: Json[];
  material?: Json | null;
} = {}): { json: Json; bin: Buffer } {
  const triangleCount = opts.triangleCount ?? 2;
  const vertexCount = triangleCount * 3;
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i += 1) {
    positions[i * 3] = i * 0.5;
    positions[i * 3 + 1] = (i % 2) * 0.25;
    positions[i * 3 + 2] = 1.0;
  }
  const bin = Buffer.from(positions.buffer.slice(0));
  const meshName = opts.meshName ?? "Cylinder_Engine";
  const node: Json = { mesh: 0 };
  if (opts.nodeName !== null) node.name = opts.nodeName ?? "Body";
  const materials = opts.material === null ? [] : [opts.material ?? { name: "Paint", pbrMetallicRoughness: { baseColorFactor: [0.2, 0.3, 0.8, 1] } }];
  const json: Json = {
    asset: { version: "2.0", generator: "poom-p2j-test" },
    scene: 0,
    scenes: [{ nodes: [0, ...(opts.extraNodes ? opts.extraNodes.map((_, i) => i + 1) : [])] }],
    nodes: [node, ...(opts.extraNodes ?? [])],
    meshes: [{ name: meshName, primitives: [{ attributes: { POSITION: 0 }, material: materials.length > 0 ? 0 : undefined }] }],
    materials,
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: vertexCount,
        type: "VEC3",
        min: [0, 0, 1],
        max: [(vertexCount - 1) * 0.5, 0.25, 1],
      },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length }],
  };
  Object.assign(json, opts.extraJson ?? {});
  return { json, bin };
}

/** Index a fixture array with an explicit failure instead of an undefined write. */
function at<T>(arr: T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`fixture index ${i} missing`);
  return v;
}

const validRecord = (overrides: Partial<ProvenanceRecord> = {}, actual = { fileSize: 1234, sha256: "a".repeat(64) }): ProvenanceRecord => ({
  assetIdentity: "Peugeot 206",
  sourceUrl: "https://sketchfab.com/3d-models/peugeot-206-example",
  sourceProvider: "Sketchfab",
  creator: "example-creator",
  licenseType: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  commercialUse: "YES",
  redistributionAllowed: "YES",
  modificationAllowed: "YES",
  attributionText: "\"Peugeot 206\" by example-creator, licensed CC-BY-4.0",
  downloadDate: "2026-09-27",
  originalFilename: "peugeot-206.glb",
  fileSize: actual.fileSize,
  sha256: actual.sha256,
  intendedUsage: "product viewer",
  modifications: null,
  ...overrides,
});

// ─────────────────────────── container / structure ───────────────────────────

describe("P2-J GLB container parsing", () => {
  it("accepts a valid self-contained GLB and reports measured metrics", () => {
    const { json, bin } = triangleAsset({ triangleCount: 3, nodeName: "Engine_Block", meshName: "Cylinder_Engine" });
    const audit = auditAsset(buildGlb(json, bin));
    expect(audit.verdict).toBe("PASS");
    expect(audit.structure.verdict).toBe("PASS");
    expect(audit.security.verdict).toBe("PASS");
    expect(audit.selfContained.verdict).toBe("PASS");
    expect(audit.metrics?.triangles).toBe(3);
    expect(audit.metrics?.vertices).toBe(9);
    expect(audit.container?.counts.meshes).toBe(1);
    expect(at(audit.inventory?.entries ?? [], 0).nodeName).toBe("Engine_Block");
    expect(at(audit.inventory?.entries ?? [], 0).nameSource).toBe("AUTHORED");
  });

  it("rejects a truncated container whose declared length disagrees with the file", () => {
    const { json, bin } = triangleAsset();
    const full = buildGlb(json, bin);
    const audit = auditAsset(full.subarray(0, full.length - 8));
    expect(audit.verdict).toBe("FAIL");
    expect(audit.structure.problems.map((p) => p.code)).toContain("LENGTH_MISMATCH");
  });

  it("names a bare .gltf / zip for what it is instead of a generic failure", () => {
    const gltf = auditAsset(Buffer.from('{"asset":{"version":"2.0"}}'));
    expect(at(gltf.structure.problems, 0).code).toBe("NOT_A_GLB");
    expect(at(gltf.structure.problems, 0).detail).toContain(".gltf");

    const zip = auditAsset(Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(64)]));
    expect(at(zip.structure.problems, 0).code).toBe("NOT_A_GLB");
    expect(at(zip.structure.problems, 0).detail).toContain("ZIP");
  });

  it("rejects malformed JSON in the JSON chunk", () => {
    const jsonPadded = padTo4(Buffer.from("{not json", "utf8"), 0x20);
    const body = glbChunk("JSON", jsonPadded);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + body.length, 8);
    const audit = auditAsset(Buffer.concat([header, body]));
    expect(audit.verdict).toBe("FAIL");
    expect(audit.structure.problems.map((p) => p.code)).toContain("MALFORMED_GLTF_JSON");
  });

  it("detects a dangling node → mesh reference", () => {
    const { json, bin } = triangleAsset();
    at(json.nodes as Json[], 0).mesh = 7;
    const audit = auditAsset(buildGlb(json, bin));
    expect(audit.verdict).toBe("FAIL");
    expect(audit.structure.problems.some((p) => p.code === "DANGLING_REFERENCE" && p.where === "nodes[0].mesh")).toBe(true);
  });

  it("detects an accessor that overruns its bufferView", () => {
    const { json, bin } = triangleAsset();
    at(json.accessors as Json[], 0).count = 5000;
    const audit = auditAsset(buildGlb(json, bin));
    expect(audit.structure.problems.map((p) => p.code)).toContain("ACCESSOR_OUT_OF_RANGE");
  });

  it("detects a cycle in the node hierarchy", () => {
    const { json, bin } = triangleAsset({ extraNodes: [{ name: "Child" }] });
    at(json.nodes as Json[], 0).children = [1];
    at(json.nodes as Json[], 1).children = [0];
    const audit = auditAsset(buildGlb(json, bin));
    expect(audit.structure.problems.map((p) => p.code)).toContain("NODE_GRAPH_CYCLE");
  });

  it("rejects non-finite numbers smuggled through JSON exponents", () => {
    const raw = '{"asset":{"version":"2.0"},"nodes":[{"name":"x","scale":[1e999,1,1]}],"scenes":[{"nodes":[0]}],"meshes":[],"extra":{"v":1e999}}';
    const padded = padTo4(Buffer.from(raw, "utf8"), 0x20);
    const body = glbChunk("JSON", padded);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + body.length, 8);
    const audit = auditAsset(Buffer.concat([header, body]));
    expect(audit.structure.problems.filter((p) => p.code === "NON_FINITE_NUMBER").length).toBeGreaterThanOrEqual(2);
  });

  it("rejects an unknown extension that the document marks required", () => {
    const { json, bin } = triangleAsset({ extraJson: { extensionsUsed: ["VENDOR_secret_payload"], extensionsRequired: ["VENDOR_secret_payload"] } });
    const audit = auditAsset(buildGlb(json, bin));
    expect(audit.structure.problems.map((p) => p.code)).toContain("UNSUPPORTED_REQUIRED_EXTENSION");
    expect(audit.structure.problems.map((p) => p.code)).toContain("UNKNOWN_EXTENSION");
  });

  it("flags a document with no geometry and an empty scene", () => {
    const json: Json = { asset: { version: "2.0" }, scenes: [{ nodes: [] }], nodes: [] };
    const audit = auditAsset(buildGlb(json));
    expect(audit.structure.problems.map((p) => p.code)).toContain("NO_MESHES");
    expect(audit.structure.problems.map((p) => p.code)).toContain("EMPTY_SCENE");
  });

  it("detects a GLB buffer longer than the BIN chunk and a missing BIN chunk", () => {
    const { json, bin } = triangleAsset();
    at(json.buffers as Json[], 0).byteLength = bin.length + 4096;
    let audit = auditAsset(buildGlb(json, bin));
    expect(audit.structure.problems.map((p) => p.code)).toContain("BUFFER_LENGTH_MISMATCH");

    audit = auditAsset(buildGlb(json));
    expect(audit.structure.problems.map((p) => p.code)).toContain("MISSING_BIN_CHUNK");
  });

  it("warns about degenerate meshes without failing the file", () => {
    const { json, bin } = triangleAsset();
    at(json.accessors as Json[], 0).count = 0;
    const audit = auditAsset(buildGlb(json, bin));
    expect(audit.structure.problems.map((p) => p.code)).toContain("DEGENERATE_MESHES");
  });

  it("parses a GLB with an unknown extra chunk as a warning", () => {
    const { json, bin } = triangleAsset();
    const buf = buildGlb(json, bin, { type: "XTRA", data: Buffer.from("hello") });
    const parsed = parseGlb(buf);
    expect(parsed.ok).toBe(true);
    const audit = auditAsset(buf);
    expect(audit.security.problems.map((p) => p.code)).toContain("UNKNOWN_CHUNK");
    expect(audit.verdict).toBe("PASS");
  });
});

// ─────────────────────────── security ───────────────────────────

describe("P2-J asset security validation", () => {
  it("blocks external references and records them", () => {
    const { json } = triangleAsset();
    json.images = [{ uri: "https://cdn.evil.test/payload.png", mimeType: "image/png" }];
    json.textures = [{ source: 0 }];
    at(json.materials as Json[], 0).pbrMetallicRoughness = { baseColorTexture: { index: 0 } };
    const audit = auditAsset(buildGlb(json));
    expect(audit.verdict).toBe("FAIL");
    expect(audit.selfContained.verdict).toBe("FAIL");
    expect(audit.selfContained.externalReferences).toEqual(["https://cdn.evil.test/payload.png"]);
    expect(audit.security.problems.map((p) => p.code)).toContain("EXTERNAL_REFERENCE");
  });

  it("blocks path traversal, absolute and windows-style references", () => {
    for (const uri of ["../../../etc/passwd", "file:///C:/secrets.txt", "C:/windows/system32/x.bin", "/abs/path.bin", "%2e%2e/escape.bin"]) {
      const { json } = triangleAsset({ extraJson: { images: [{ uri, mimeType: "image/png" }], textures: [{ source: 0 }] } });
      const audit = auditAsset(buildGlb(json));
      expect(audit.security.problems.some((p) => p.code === "SUSPICIOUS_URI" || p.code === "EXTERNAL_REFERENCE"), uri).toBe(true);
      expect(audit.verdict).toBe("FAIL");
    }
  });

  it("rejects script markers inside metadata", () => {
    const { json, bin } = triangleAsset({ extraJson: { asset: { version: "2.0", extras: { note: "<script>alert(1)</script>" } } } });
    const audit = auditAsset(buildGlb(json, bin));
    expect(audit.security.problems.map((p) => p.code)).toContain("SUSPICIOUS_CONTENT_MARKER");
  });

  it("rejects an executable header inside the binary chunk", () => {
    const { json } = triangleAsset();
    const bin = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);
    json.buffers = [{ byteLength: bin.length }];
    json.bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: bin.length }];
    const audit = auditAsset(buildGlb(json, bin));
    expect(audit.security.problems.map((p) => p.code)).toContain("EMBEDDED_EXECUTABLE");
  });

  it("rejects an oversized inline data URI", () => {
    const payload = "x".repeat(17 * 1024 * 1024);
    const { json } = triangleAsset({ extraJson: { images: [{ uri: `data:image/png,${payload}`, mimeType: "image/png" }], textures: [{ source: 0 }] } });
    const audit = auditAsset(buildGlb(json));
    expect(audit.security.problems.map((p) => p.code)).toContain("LIMIT_INLINE_DATA");
    expect(audit.security.problems.some((p) => p.code === "SUSPICIOUS_URI" && p.detail?.includes("abnormally long"))).toBe(false);
  });

  it("rejects an absurd accessor count before it reaches a decoder", () => {
    const { json, bin } = triangleAsset();
    at(json.accessors as Json[], 0).count = 90000000;
    const audit = auditAsset(buildGlb(json, bin));
    expect(audit.security.problems.map((p) => p.code)).toContain("LIMIT_ACCESSOR_COUNT");
  });

  it("keeps metadata URLs informational rather than fatal", () => {
    const { json, bin } = triangleAsset({
      extraJson: { asset: { version: "2.0", extras: { source: "https://sketchfab.com/models/abc", license: "CC-BY-4.0" } } },
    });
    const audit = auditAsset(buildGlb(json, bin));
    expect(audit.verdict).toBe("PASS");
    expect(audit.selfContained.externalReferences).toEqual([]);
    const stored = summarizeAudit(audit, ["https://sketchfab.com/models/abc"]);
    expect(stored.metadataUrls).toEqual(["https://sketchfab.com/models/abc"]);
  });
});

// ─────────────────────────── inventory / metrics ───────────────────────────

describe("P2-J node + mesh inventory", () => {
  it("builds authored paths from the hierarchy and keeps the authored names verbatim", () => {
    const { json, bin } = triangleAsset({
      nodeName: "Body",
      meshName: "Body_Shell",
      extraNodes: [{ name: "Engine", children: [2] }, { name: "Cylinder_Head", mesh: 0 }],
    });
    at(json.nodes as Json[], 0).children = [1]; // Body → Engine → Cylinder_Head
    const audit = auditAsset(buildGlb(json, bin));
    const paths = audit.inventory?.entries.map((e) => e.path).sort();
    expect(paths).toContain("Body");
    expect(paths).toContain("Body/Engine/Cylinder_Head");
    expect(audit.inventory?.entries.every((e) => e.nameSource === "AUTHORED")).toBe(true);
  });

  it("marks unnamed nodes as DERIVED_UNNAMED instead of inventing a name", () => {
    const { json, bin } = triangleAsset({ nodeName: null, meshName: "Engine_Part" });
    const audit = auditAsset(buildGlb(json, bin));
    const entry = at(audit.inventory?.entries ?? [], 0);
    expect(entry?.nodeName).toBe("");
    expect(entry?.nameSource).toBe("DERIVED_UNNAMED");
    expect(audit.inventory?.unnamedMeshNodes).toBe(1);
  });

  it("reports duplicate authored names (mapping ambiguity)", () => {
    const { json, bin } = triangleAsset({ nodeName: "Wheel", extraNodes: [{ name: "Wheel", mesh: 0 }] });
    const audit = auditAsset(buildGlb(json, bin));
    expect(audit.inventory?.duplicateMeshNames).toEqual(["Wheel"]);
  });

  it("keeps the inventory hash stable across identical audits and changes it when geometry moves", () => {
    const a = triangleAsset({ triangleCount: 4 });
    const same = triangleAsset({ triangleCount: 4 });
    const different = triangleAsset({ triangleCount: 8 });
    const h1 = auditAsset(buildGlb(a.json, a.bin)).inventory?.inventoryHash;
    const h2 = auditAsset(buildGlb(same.json, same.bin)).inventory?.inventoryHash;
    const h3 = auditAsset(buildGlb(different.json, different.bin)).inventory?.inventoryHash;
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it("carries per-mesh bounding boxes from POSITION accessor bounds", () => {
    const { json, bin } = triangleAsset({ triangleCount: 2 });
    const entry = at(auditAsset(buildGlb(json, bin)).inventory?.entries ?? [], 0);
    expect(entry?.bboxMin).toEqual([0, 0, 1]);
    expect(entry?.bboxMax?.[0]).toBeCloseTo(2.5, 6);
  });

  it("decodes texture dimensions for png, jpeg and ktx2 payloads", async () => {
    const png = await sharp({ create: { width: 64, height: 32, channels: 4, background: "#fff" } }).png().toBuffer();
    expect(imageDimensions(png)).toEqual({ width: 64, height: 32, format: "png" });

    const jpeg = await sharp({ create: { width: 48, height: 24, channels: 3, background: "#123" } }).jpeg().toBuffer();
    expect(imageDimensions(jpeg)).toEqual({ width: 48, height: 24, format: "jpeg" });

    const ktx2 = Buffer.alloc(40);
    ktx2.write("«KTX 20»\r\n\x1a\n", 0, "latin1");
    ktx2.writeUInt32LE(512, 20);
    ktx2.writeUInt32LE(256, 24);
    expect(imageDimensions(ktx2)).toEqual({ width: 512, height: 256, format: "ktx2" });

    expect(imageDimensions(Buffer.from("not an image"))).toBeNull();
  });

  it("counts embedded PNG bytes and decoded texture cost in metrics", async () => {
    const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#f00" } }).png().toBuffer();
    const positions = new Float32Array(6 * 3); // ACCESSOR count 6 × VEC3 float
    const bin = Buffer.concat([Buffer.from(positions.buffer.slice(0)), png]);
    const { json } = triangleAsset();
    json.buffers = [{ byteLength: bin.length }];
    json.bufferViews = [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: png.length },
    ];
    at(json.accessors as Json[], 0).bufferView = 0;
    json.images = [{ bufferView: 1, mimeType: "image/png" }];
    json.textures = [{ source: 0 }];
    at(json.materials as Json[], 0).pbrMetallicRoughness = { baseColorTexture: { index: 0 } };
    const audit = auditAsset(buildGlb(json, bin));
    expect(audit.metrics?.embeddedTextureBytes).toBe(png.length);
    expect(audit.metrics?.largestTextureDimension).toBe(32);
    expect(audit.metrics?.estimatedGpuBytes).toBeGreaterThanOrEqual(32 * 32 * 4);
    expect(audit.verdict).toBe("PASS");
  });
});

// ─────────────────────────── provenance ───────────────────────────

describe("P2-J provenance validation", () => {
  it("accepts a complete CC-BY record and reports the attribution requirement", () => {
    const check = validateProvenance(validRecord(), { fileSize: 1234, sha256: "a".repeat(64) });
    expect(check.canIngest).toBe(true);
    expect(check.canPromote).toBe(true);
    expect(check.rights.class).toBe("OPEN_ATTRIBUTION");
    expect(check.rights.attributionRequired).toBe(true);
    expect(rightsAllowProduction(check.rights).ok).toBe(true);
  });

  it("accepts CC0 without demanding attribution", () => {
    const check = validateProvenance(validRecord({ licenseType: "CC0-1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/", attributionText: null }), {
      fileSize: 1234,
      sha256: "a".repeat(64),
    });
    expect(check.canIngest).toBe(true);
    expect(check.rights.class).toBe("OPEN_PERMISSIVE");
    expect(check.rights.attributionRequired).toBe(false);
  });

  it("rejects a missing or unknown license", () => {
    for (const licenseType of ["", "UNSPECIFIED", "UNKNOWN"]) {
      const check = validateProvenance(validRecord({ licenseType }), { fileSize: 1234, sha256: "a".repeat(64) });
      expect(check.canIngest).toBe(false);
      expect(check.problems.map((p) => p.code)).toContain("LICENSE_MISSING");
    }
  });

  it("rejects non-commercial, no-derivatives and platform-restricted licenses", () => {
    for (const licenseType of ["CC-BY-NC-4.0", "CC-BY-ND-4.0", "Free Standard", "Editorial Use Only"]) {
      const check = validateProvenance(validRecord({ licenseType }), { fileSize: 1234, sha256: "a".repeat(64) });
      const codes = check.problems.map((p) => p.code);
      expect(codes.some((c) => c === "LICENSE_RESTRICTED" || c === "LICENSE_MISSING"), licenseType).toBe(true);
      expect(check.canIngest, licenseType).toBe(false);
      expect(check.rights.commercialUse, licenseType).not.toBe("YES");
    }
  });

  it("rejects an unreviewed license id instead of assuming it is permissive", () => {
    const check = validateProvenance(validRecord({ licenseType: "SCENE-LICENSE-1.0" }), { fileSize: 1234, sha256: "a".repeat(64) });
    expect(check.problems.map((p) => p.code)).toContain("LICENSE_NOT_IN_ALLOWLIST");
    expect(check.canIngest).toBe(false);
  });

  it("keeps UNKNOWN rights as hard stops", () => {
    for (const field of ["commercialUse", "redistributionAllowed", "modificationAllowed"] as const) {
      const check = validateProvenance(validRecord({ [field]: "UNKNOWN" }), { fileSize: 1234, sha256: "a".repeat(64) });
      expect(check.problems.some((p) => p.code === "RIGHT_UNKNOWN" && p.where === field)).toBe(true);
      expect(check.canPromote).toBe(false);
    }
  });

  it("rejects a checksum or size that does not match the bytes on disk", () => {
    const sizeMismatch = validateProvenance(validRecord(), { fileSize: 9999, sha256: "a".repeat(64) });
    expect(sizeMismatch.problems.map((p) => p.code)).toContain("FILE_SIZE_MISMATCH");

    const hashMismatch = validateProvenance(validRecord(), { fileSize: 1234, sha256: "b".repeat(64) });
    expect(hashMismatch.problems.map((p) => p.code)).toContain("CHECKSUM_MISMATCH");
    expect(hashMismatch.canIngest).toBe(false);
  });

  it("rejects placeholder evidence URLs and future acquisition dates", () => {
    const check = validateProvenance(
      validRecord({ sourceUrl: "https://example.org/peugeot-206.glb", downloadDate: "2030-01-01", originalFilename: "assets/206.glb" }),
      { fileSize: 1234, sha256: "a".repeat(64) },
    );
    const codes = check.problems.map((p) => p.code);
    expect(codes).toContain("SOURCE_URL_UNVERIFIABLE");
    expect(codes).toContain("ACQUISITION_DATE_INVALID");
    expect(codes).toContain("ORIGINAL_FILENAME_INVALID");
    expect(check.canIngest).toBe(false);
  });

  it("requires an attribution string for attribution licenses and flags one that omits the creator", () => {
    const missing = validateProvenance(validRecord({ attributionText: null }), { fileSize: 1234, sha256: "a".repeat(64) });
    expect(missing.problems.map((p) => p.code)).toContain("ATTRIBUTION_TEXT_REQUIRED");

    const wrong = validateProvenance(validRecord({ attributionText: "some model" }), { fileSize: 1234, sha256: "a".repeat(64) });
    expect(wrong.problems.map((p) => p.code)).toContain("ATTRIBUTION_MISSING_CREATOR");
    expect(wrong.canIngest).toBe(true); // warning, not a hard stop
  });

  it("treats an unknown creator as a promotion blocker but not an ingestion blocker", () => {
    const check = validateProvenance(validRecord({ creator: null }), { fileSize: 1234, sha256: "a".repeat(64) }, { requirePromotionReady: true });
    expect(check.canIngest).toBe(true);
    expect(check.canPromote).toBe(false);
    expect(check.problems.map((p) => p.code)).toContain("CREATOR_UNKNOWN");
  });
});

// ─────────────────────────── audit ↔ provenance wiring ───────────────────────────

describe("P2-J audit with provenance", () => {
  it("verifies size + checksum against the real bytes and reports a FAIL on mismatch", () => {
    const { json, bin } = triangleAsset({ triangleCount: 2 });
    const buf = buildGlb(json, bin);
    const good = validRecord({}, { fileSize: buf.length, sha256: sha256(buf) });
    const pass = auditAsset(buf, { provenance: good });
    expect(pass.provenance?.verdict).toBe("PASS");
    expect(pass.verdict).toBe("PASS");
    expect(pass.provenance?.rights.class).toBe("OPEN_ATTRIBUTION");

    const bad = auditAsset(buf, { provenance: validRecord({ licenseType: "CC-BY-NC-4.0" }, { fileSize: buf.length, sha256: sha256(buf) }) });
    expect(bad.provenance?.verdict).toBe("FAIL");
    expect(bad.verdict).toBe("FAIL");
  });

  it("applies production-delivery thresholds only in the production profile", () => {
    const { json, bin } = triangleAsset({ triangleCount: LIMITS.warnTriangles + 1 });
    const buf = buildGlb(json, bin);
    const raw = auditAsset(buf, { limitProfile: "raw-ingestion" });
    expect(raw.structure.problems.some((p) => p.code.startsWith("DELIVERY_"))).toBe(false);

    const prod = auditAsset(buf, { limitProfile: "production-delivery" });
    const codes = prod.structure.problems.map((p) => p.code);
    expect(codes).toContain("DELIVERY_TRIANGLES_HIGH");
    expect(prod.verdict).toBe("PASS"); // warnings, not errors — measured and justified, not fatal
  });

  it("summarizes an audit into a storable shape with the full inventory fingerprints", () => {
    const { json, bin } = triangleAsset({ triangleCount: 3, nodeName: "Cylinder_Head" });
    const audit = auditAsset(buildGlb(json, bin));
    const stored = summarizeAudit(audit);
    expect(stored.verdict).toBe("PASS");
    expect(at(stored.inventory?.entries ?? [], 0).nodeName).toBe("Cylinder_Head");
    expect(at(stored.inventory?.entries ?? [], 0).fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(stored.inventoryHash).toBe(audit.inventory?.inventoryHash);
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored); // round-trips into a Json column
  });
});

// ─────────────────────────── optimization comparison ───────────────────────────

describe("P2-J raw vs optimized comparison", () => {
  async function realDocGlb(): Promise<Buffer> {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const mat = doc.createMaterial("Paint").setBaseColorFactor([0.8, 0.1, 0.1, 1]);
    const positions: number[] = [];
    for (let i = 0; i < 60; i += 1) positions.push(i * 0.1, (i % 3) * 0.1, 0);
    const acc = doc.createAccessor("POSITION").setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer);
    const prim = doc.createPrimitive().setAttribute("POSITION", acc).setMaterial(mat);
    const mesh = doc.createMesh("Body_Shell").addPrimitive(prim);
    const child = doc.createNode("Cylinder_Head").setMesh(mesh);
    const rootNode = doc.createNode("Body").addChild(child);
    doc.createScene("Scene").addChild(rootNode);
    const io = new NodeIO();
    return Buffer.from(await io.writeBinary(doc));
  }

  it("passes a prune/dedup round-trip and reports measured deltas", async () => {
    const rawBytes = await realDocGlb();
    const raw = auditAsset(rawBytes);
    const io = new NodeIO();
    const doc = await io.readBinary(new Uint8Array(rawBytes));
    await doc.transform(prune(), dedup());
    const optimizedBytes = Buffer.from(await io.writeBinary(doc));
    const optimized = auditAsset(optimizedBytes, { limitProfile: "production-delivery" });

    // Mapping targets are mesh-bearing nodes: "Body" is a group (inspected via
    // inventory.groups), "Cylinder_Head" carries the geometry.
    const cmp = compareAudits(raw, optimized, { requiredMeshNames: ["Cylinder_Head"] });
    expect(cmp.ok).toBe(true);
    expect(cmp.deltas.triangles.raw).toBe(cmp.deltas.triangles.optimized);
    expect(cmp.lostMeshNames).toEqual([]);
    expect(cmp.missingRequiredNames).toEqual([]);
    expect(raw.inventory?.groups.map((g) => g.name)).toContain("Body");
  });

  it("hard-fails when a mapping target disappears from the optimized artifact", async () => {
    const rawBytes = await realDocGlb();
    const raw = auditAsset(rawBytes);
    const io = new NodeIO();
    const doc = await io.readBinary(new Uint8Array(rawBytes));
    for (const node of doc.getRoot().listNodes()) if (node.getName() === "Cylinder_Head") node.dispose();
    const optimized = auditAsset(Buffer.from(await io.writeBinary(doc)));
    const cmp = compareAudits(raw, optimized, { requiredMeshNames: ["Cylinder_Head"] });
    expect(cmp.ok).toBe(false);
    expect(cmp.problems.map((p) => p.code)).toContain("REQUIRED_MESH_MISSING");
    expect(cmp.missingRequiredNames).toEqual(["Cylinder_Head"]);
  });

  it("refuses an optimized artifact that lost every material or texture", async () => {
    const rawBytes = await realDocGlb();
    const raw = auditAsset(rawBytes);
    const io = new NodeIO();
    const doc = await io.readBinary(new Uint8Array(rawBytes));
    for (const m of doc.getRoot().listMaterials()) m.dispose();
    const optimized = auditAsset(Buffer.from(await io.writeBinary(doc)));
    const cmp = compareAudits(raw, optimized);
    expect(cmp.problems.map((p) => p.code)).toContain("MATERIALS_DROPPED");
    expect(cmp.ok).toBe(false);
  });
});
