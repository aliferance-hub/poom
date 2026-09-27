// P2-J (J5 + J4): node/mesh inventory and measured metrics.
//
// The inventory is the *only* source of truth for mapping targets: a name is
// either present in the file (AUTHORED) or it is a positional key we derived
// (DERIVED_UNNAMED) which the viewer/mapping layer must not treat as an authored
// identity. Nothing is renamed, nothing is invented.
import { createHash } from "node:crypto";
import { AssetInventory, AssetMetrics, GlbContainerInfo, MeshInventoryEntry, StructureStatsLike } from "./types";

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const numOr = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
const intOr = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Format a float deterministically so fingerprints survive re-serialization. */
function fixed(n: number): string {
  return n.toFixed(3);
}

// ─────────────────────────── image dimension decoding ───────────────────────────

/** Decode pixel dimensions from raw image bytes (PNG / JPEG / WebP / KTX2). */
export function imageDimensions(buf: Buffer): { width: number; height: number; format: string } | null {
  if (buf.length > 24 && buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: "png" };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off += 1;
        continue;
      }
      const marker = buf[off + 1] ?? -1;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      const segLen = buf.readUInt16BE(off + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5), format: "jpeg" };
      off += 2 + segLen;
    }
    return null;
  }
  if (buf.length > 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const fourcc = buf.toString("latin1", 12, 16);
    if (fourcc === "VP8X") {
      // VP8X canvas size is 24-bit little-endian, stored as size-1.
      const w = 1 + buf.readUIntLE(24, 3);
      const h = 1 + buf.readUIntLE(27, 3);
      return { width: w, height: h, format: "webp" };
    }
    if (fourcc === "VP8 " && buf.length > 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: "webp" };
    }
    if (fourcc === "VP8L" && buf.length > 25) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: "webp" };
    }
    return null;
  }
  const KTX2_MAGIC = "«KTX 20»\r\n\x1a\n";
  if (buf.length > 32 && buf.toString("latin1", 0, 12) === KTX2_MAGIC) {
    return { width: buf.readUInt32LE(20), height: buf.readUInt32LE(24), format: "ktx2" };
  }
  return null;
}

function embeddedImageBytes(json: Json, bin: Buffer | null, img: Json): Buffer | null {
  const uri = typeof img.uri === "string" ? img.uri : null;
  if (uri) {
    const m = /^data:([^;,]*)(;base64)?,/i.exec(uri);
    if (!m) return null;
    const payload = uri.slice(m[0].length);
    try {
      return m[2] ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
    } catch {
      return null;
    }
  }
  const viewIdx = intOr(img.bufferView);
  if (viewIdx === null || !bin) return null;
  const views = arr(json.bufferViews);
  const view = isObj(views[viewIdx]) ? views[viewIdx] : null;
  if (!view) return null;
  const buffers = arr(json.buffers);
  const buffer = isObj(buffers[intOr(view.buffer) ?? 0]) ? (buffers[intOr(view.buffer) ?? 0] as Json) : null;
  if (!buffer || (typeof buffer.uri === "string" && !String(buffer.uri).startsWith("data:"))) return null;
  const off = numOr(view.byteOffset, 0);
  const len = numOr(view.byteLength, 0);
  if (off + len > bin.length) return null;
  return bin.subarray(off, off + len);
}

// ─────────────────────────── inventory ───────────────────────────

export type InventoryInput = {
  json: Json;
  bin: Buffer | null;
};

/**
 * Build the machine-readable inventory of nodes/meshes plus the metrics block.
 * Paths come from the default scene's hierarchy; nodes outside every scene are
 * inventoried too and marked as such (they are not silently dropped).
 */
export function buildInventory({ json, bin }: InventoryInput): { inventory: AssetInventory; metrics: AssetMetrics } {
  const nodes = arr(json.nodes).map((n) => (isObj(n) ? n : {}));
  const meshes = arr(json.meshes).map((m) => (isObj(m) ? m : {}));
  const accessors = arr(json.accessors).map((a) => (isObj(a) ? a : {}));
  const materials = arr(json.materials).map((m) => (isObj(m) ? m : {}));
  const images = arr(json.images).map((i) => (isObj(i) ? i : {}));
  const scenes = arr(json.scenes).map((s) => (isObj(s) ? s : {}));

  const sceneIndex = intOr(json.scene) ?? 0;
  const roots = arr(scenes[sceneIndex]?.nodes ?? scenes[0]?.nodes)
    .map((r) => intOr(r))
    .filter((r): r is number => r !== null && r >= 0 && r < nodes.length);

  const entries: MeshInventoryEntry[] = [];
  const groups: AssetInventory["groups"] = [];
  const visited = new Set<number>();

  const accessorStats = (idx: unknown): { count: number; bytes: number } => {
    const i = intOr(idx);
    if (i === null || i < 0 || i >= accessors.length) return { count: 0, bytes: 0 };
    const a = accessors[i] ?? {};
    const count = numOr(a.count, 0);
    const compBytes = COMPONENT_BYTES[numOr(a.componentType, 0)] ?? 0;
    const comps = TYPE_COMPONENTS[typeof a.type === "string" ? a.type : ""] ?? 0;
    return { count, bytes: count * compBytes * comps };
  };

  const walk = (nodeIndex: number, path: string[], depth: number): void => {
    if (visited.has(nodeIndex) || depth > 200) return;
    visited.add(nodeIndex);
    const node = nodes[nodeIndex] ?? {};
    const authored = typeof node.name === "string" ? node.name : "";
    const myPath = [...path, authored !== "" ? authored : `#${nodeIndex}`];
    const pathStr = myPath.join("/");

    const meshIdx = intOr(node.mesh);
    if (meshIdx !== null && meshIdx >= 0 && meshIdx < meshes.length) {
      const mesh = meshes[meshIdx] ?? {};
      const prims = arr(mesh.primitives).map((p) => (isObj(p) ? p : {}));
      let triangles = 0;
      let vertices = 0;
      const materialNames: string[] = [];
      let min: [number, number, number] | null = null;
      let max: [number, number, number] | null = null;

      for (const p of prims) {
        const attrs = isObj(p.attributes) ? p.attributes : {};
        const posAcc = accessors[intOr(attrs.POSITION) ?? -1] ?? null;
        const posCount = posAcc ? numOr(posAcc.count, 0) : 0;
        vertices += posCount;
        let drawCount = posCount;
        if (p.indices !== undefined) {
          const ia = accessors[intOr(p.indices) ?? -1];
          if (ia) drawCount = numOr(ia.count, 0);
        }
        const mode = p.mode === undefined ? 4 : intOr(p.mode) ?? 4;
        triangles += mode === 4 ? Math.floor(drawCount / 3) : mode === 5 || mode === 6 ? Math.max(0, drawCount - 2) : 0;

        if (posAcc) {
          const mn = Array.isArray(posAcc.min) ? (posAcc.min as unknown[]).map((x) => numOr(x, 0)) : null;
          const mx = Array.isArray(posAcc.max) ? (posAcc.max as unknown[]).map((x) => numOr(x, 0)) : null;
          if (mn && mx && mn.length >= 3 && mx.length >= 3) {
            const m3 = [mn[0], mn[1], mn[2]] as [number, number, number];
            const x3 = [mx[0], mx[1], mx[2]] as [number, number, number];
            min = min === null ? m3 : [Math.min(min[0], m3[0]), Math.min(min[1], m3[1]), Math.min(min[2], m3[2])];
            max = max === null ? x3 : [Math.max(max[0], x3[0]), Math.max(max[1], x3[1]), Math.max(max[2], x3[2])];
          }
        }
        const matIdx = intOr(p.material);
        if (matIdx !== null && matIdx >= 0 && matIdx < materials.length) {
          const mat = materials[matIdx] ?? {};
          const name = typeof mat.name === "string" ? mat.name : "";
          materialNames.push(name !== "" ? name : `material[${matIdx}]`);
        }
      }

      const meshName = typeof mesh.name === "string" ? mesh.name : "";
      const fingerprint = sha256Hex(
        [
          authored,
          meshName,
          String(prims.length),
          String(triangles),
          String(vertices),
          min ? min.map(fixed).join(",") : "nobounds",
          max ? max.map(fixed).join(",") : "nobounds",
        ].join("|"),
      ).slice(0, 40);

      const visibilityExt = isObj(node.extensions) && isObj((node.extensions as Json).KHR_node_visibility)
        ? ((node.extensions as Json).KHR_node_visibility as Json)
        : null;
      const visible = visibilityExt ? visibilityExt.visible !== false : true;

      entries.push({
        nodeIndex,
        path: pathStr,
        nodeName: authored,
        nameSource: authored !== "" ? "AUTHORED" : "DERIVED_UNNAMED",
        meshIndex: meshIdx,
        meshName,
        primitives: prims.length,
        triangles,
        vertices,
        materials: materialNames,
        visible,
        bboxMin: min,
        bboxMax: max,
        fingerprint,
      });
    } else {
      groups.push({
        path: pathStr,
        name: authored,
        children: arr(node.children).length,
        hasMesh: false,
      });
    }

    for (const c of arr(node.children)) {
      const ci = intOr(c);
      if (ci !== null && ci >= 0 && ci < nodes.length) walk(ci, myPath, depth + 1);
    }
  };

  for (const r of roots) walk(r, [] as string[], 0);
  // Nodes outside the default scene are still part of the file — inventory them.
  for (let i = 0; i < nodes.length; i += 1) if (!visited.has(i)) walk(i, ["(unscened)"], 0);

  const authoredNames = entries.filter((e) => e.nameSource === "AUTHORED").map((e) => e.nodeName);
  const seen = new Map<string, number>();
  for (const n of authoredNames) seen.set(n, (seen.get(n) ?? 0) + 1);
  const duplicateMeshNames = [...seen.entries()].filter(([, c]) => c > 1).map(([n]) => n);

  const inventoryHash = sha256Hex(
    [...entries]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((e) => `${e.path}#${e.fingerprint}`)
      .join("\n"),
  );

  const inventory: AssetInventory = {
    entries,
    inventoryHash,
    groups,
    meshNodeCount: entries.length,
    unnamedMeshNodes: entries.filter((e) => e.nameSource === "DERIVED_UNNAMED").length,
    duplicateMeshNames,
  };

  // ── metrics ────────────────────────────────────────────────────────────────
  let embeddedTextureBytes = 0;
  let largestTextureDimension = 0;
  let largestImageBytes = 0;
  let decodedTextureBytes = 0;
  for (const img of images) {
    const bytes = embeddedImageBytes(json, bin, img);
    if (!bytes) continue;
    largestImageBytes = Math.max(largestImageBytes, bytes.length);
    embeddedTextureBytes += bytes.length;
    const dims = imageDimensions(bytes);
    if (dims) {
      largestTextureDimension = Math.max(largestTextureDimension, dims.width, dims.height);
      decodedTextureBytes += dims.width * dims.height * 4;
    }
  }

  let accessorBytes = 0;
  for (const mesh of meshes) {
    for (const pRaw of arr(mesh.primitives)) {
      const p = isObj(pRaw) ? pRaw : {};
      const attrs = isObj(p.attributes) ? p.attributes : {};
      for (const accIdx of Object.values(attrs)) accessorBytes += accessorStats(accIdx).bytes;
      if (p.indices !== undefined) accessorBytes += accessorStats(p.indices).bytes;
    }
  }

  const lights = arr(json.extensions && isObj(json.extensions) && isObj((json.extensions as Json).KHR_lights_punctual)
    ? ((json.extensions as Json).KHR_lights_punctual as Json).lights
    : []).length;

  const metrics: AssetMetrics = {
    fileBytes: bin ? bin.length : 0,
    triangles: entries.reduce((s, e) => s + e.triangles, 0),
    vertices: entries.reduce((s, e) => s + e.vertices, 0),
    nodes: nodes.length,
    meshes: meshes.length,
    meshPrimitives: entries.reduce((s, e) => s + e.primitives, 0),
    materials: materials.length,
    textures: arr(json.textures).length,
    images: images.length,
    animations: arr(json.animations).length,
    cameras: arr(json.cameras).length,
    lights,
    embeddedTextureBytes,
    largestTextureDimension,
    largestImageBytes,
    estimatedGpuBytes: Math.round(accessorBytes + decodedTextureBytes),
    // Depth here is a path-based proxy; mergeMetrics() replaces it with the
    // exact hierarchy depth measured by the structure pass.
    hierarchyDepth: depthFromEntries(entries),
  };

  return { inventory, metrics };
}

function depthFromEntries(entries: MeshInventoryEntry[]): number {
  let depth = 0;
  for (const e of entries) depth = Math.max(depth, e.path.split("/").length);
  return depth;
}

/** Attach container-level counts that only the structure pass knows. */
export function mergeMetrics(base: AssetMetrics, info: GlbContainerInfo, stats: StructureStatsLike): AssetMetrics {
  return {
    ...base,
    fileBytes: base.fileBytes,
    triangles: stats.triangles,
    vertices: stats.vertices,
    meshPrimitives: stats.primitives,
    hierarchyDepth: stats.hierarchyDepth,
    nodes: info.counts.nodes,
    meshes: info.counts.meshes,
    materials: info.counts.materials,
    textures: info.counts.textures,
    images: info.counts.images,
    animations: info.counts.animations,
    cameras: info.counts.cameras,
  };
}
