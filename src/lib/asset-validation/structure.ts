// P2-J (J3): structural validation of a parsed glTF/GLB document.
//
// Every check answers "is this document internally consistent and renderable?",
// never "does the filename look plausible?". Cross-references (node→mesh,
// mesh→accessor, accessor→bufferView→buffer, material→texture→image) are all
// bound-checked, the node graph is cycle-checked, and every number in the JSON
// must be finite (JSON.parse happily yields Infinity for `1e999`).
import { GlbContainerInfo, LIMITS, Problem, problem } from "./types";

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

/** glTF 2.0 extensions this project understands (registry + what gltf-transform writes). */
export const KNOWN_EXTENSIONS = new Set([
  "KHR_draco_mesh_compression",
  "KHR_mesh_quantization",
  "KHR_materials_unlit",
  "KHR_materials_pbrSpecularGlossiness",
  "KHR_materials_transmission",
  "KHR_materials_volume",
  "KHR_materials_ior",
  "KHR_materials_specular",
  "KHR_materials_clearcoat",
  "KHR_materials_sheen",
  "KHR_materials_emissive_strength",
  "KHR_materials_iridescence",
  "KHR_materials_anisotropy",
  "KHR_materials_dispersion",
  "KHR_materials_variants",
  "KHR_lights_punctual",
  "KHR_texture_transform",
  "KHR_texture_basisu",
  "KHR_xmp_json_ld",
  "EXT_meshopt_compression",
  "EXT_texture_webp",
  "EXT_mesh_gpu_instancing",
  "EXT_texture_avif",
  "EXT_structural_metadata",
  "MSFT_texture_dds",
  "MSFT_lod",
  "KHR_animation_pointer",
  "KHR_node_visibility",
]);

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** Walk every number in the document; JSON `1e999` decodes to Infinity. */
function scanFiniteNumbers(value: unknown, path: string, out: Problem[], depth = 0): void {
  if (depth > 200) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(problem("NON_FINITE_NUMBER", "error", path));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanFiniteNumbers(v, `${path}[${i}]`, out, depth + 1));
    return;
  }
  if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) scanFiniteNumbers(v, path ? `${path}.${k}` : k, out, depth + 1);
  }
}

export type StructureStats = {
  triangles: number;
  vertices: number;
  primitives: number;
  zeroTriangleMeshes: number;
  hierarchyDepth: number;
};

export type StructureResult = { problems: Problem[]; info: GlbContainerInfo; stats: StructureStats };

/**
 * Validate structure and collect container facts in one pass over the JSON.
 * `bin` is the GLB binary chunk (null for a .gltf-only document, which the
 * security layer rejects for production anyway).
 */
export function validateStructure(json: Json, bin: Buffer | null, jsonBytes: number): StructureResult {
  const problems: Problem[] = [];
  const list = (key: string): Json[] => arr(json[key]).map((x) => (isObj(x) ? x : {}));

  const nodes = list("nodes");
  const meshes = list("meshes");
  const materials = list("materials");
  const textures = list("textures");
  const images = list("images");
  const samplers = list("samplers");
  const accessors = list("accessors");
  const bufferViews = list("bufferViews");
  const buffers = list("buffers");
  const animations = list("animations");
  const cameras = list("cameras");
  const skins = list("skins");
  const scenes = list("scenes");

  const asset = isObj(json.asset) ? json.asset : {};
  const gltfVersion = typeof asset.version === "string" ? asset.version : null;
  const generator = typeof asset.generator === "string" ? asset.generator : null;

  if (gltfVersion === null) problems.push(problem("MISSING_ASSET_VERSION", "error", "asset.version"));
  else if (!gltfVersion.startsWith("2.")) {
    problems.push(problem("GLTF_VERSION_UNSUPPORTED", "error", "asset.version", `${gltfVersion} (2.x required)`));
  }

  scanFiniteNumbers(json, "", problems);

  const inRange = (i: unknown, len: number, where: string, what: string): boolean => {
    const v = intOrNull(i);
    if (v === null || v < 0 || v >= len) {
      problems.push(problem("DANGLING_REFERENCE", "error", where, `${what} index ${String(i)} out of range (0..${len - 1})`));
      return false;
    }
    return true;
  };

  // ── buffers ────────────────────────────────────────────────────────────────
  let bufferWithoutUriCount = 0;
  buffers.forEach((b, i) => {
    const len = num(b.byteLength);
    if (len === null || len <= 0) problems.push(problem("BUFFER_BAD_BYTELENGTH", "error", `buffers[${i}].byteLength`));
    const uri = typeof b.uri === "string" ? b.uri : null;
    if (uri === null) {
      bufferWithoutUriCount += 1;
      if (i !== 0) problems.push(problem("GLB_BUFFER_INDEX", "error", `buffers[${i}]`, "buffer without uri must be index 0 in a GLB"));
      if (bin === null) problems.push(problem("MISSING_BIN_CHUNK", "error", `buffers[${i}]`, "declares GLB buffer but no BIN chunk exists"));
      else if (len !== null && len > bin.length + 3) {
        problems.push(problem("BUFFER_LENGTH_MISMATCH", "error", `buffers[${i}].byteLength`, `${len} > BIN chunk ${bin.length}`));
      }
    }
  });
  if (bufferWithoutUriCount > 1) {
    problems.push(problem("MULTIPLE_GLB_BUFFERS", "error", "buffers", `${bufferWithoutUriCount} buffers without uri`));
  }

  // ── bufferViews ────────────────────────────────────────────────────────────
  bufferViews.forEach((bv, i) => {
    const bufLen = buffers.length;
    const okBuf = inRange(bv.buffer, bufLen, `bufferViews[${i}].buffer`, "buffer");
    const declared = num(okBuf ? (buffers[bv.buffer as number]?.byteLength as number) : 0) ?? 0;
    const off = num(bv.byteOffset) ?? 0;
    const len = num(bv.byteLength);
    if (len === null || len <= 0) problems.push(problem("BUFFERVIEW_BAD_LENGTH", "error", `bufferViews[${i}].byteLength`));
    else if (off + len > declared) {
      problems.push(problem("BUFFERVIEW_OUT_OF_RANGE", "error", `bufferViews[${i}]`, `offset ${off} + length ${len} exceeds buffer ${declared}`));
    }
    const stride = bv.byteStride;
    if (stride !== undefined) {
      const s = num(stride);
      if (s === null || s < 4 || s > 252 || s % 4 !== 0) {
        problems.push(problem("BUFFERVIEW_BAD_STRIDE", "error", `bufferViews[${i}].byteStride`, String(stride)));
      }
    }
  });

  // ── accessors ──────────────────────────────────────────────────────────────
  accessors.forEach((a, i) => {
    const where = `accessors[${i}]`;
    const count = intOrNull(a.count);
    const comp = intOrNull(a.componentType);
    const type = typeof a.type === "string" ? a.type : "";
    if (count === null || count <= 0) problems.push(problem("ACCESSOR_BAD_COUNT", "error", `${where}.count`));
    if (comp === null || !(comp in COMPONENT_BYTES)) problems.push(problem("ACCESSOR_BAD_COMPONENT_TYPE", "error", `${where}.componentType`, String(a.componentType)));
    if (!(type in TYPE_COMPONENTS)) problems.push(problem("ACCESSOR_BAD_TYPE", "error", `${where}.type`, type));

    const compBytes = comp !== null ? COMPONENT_BYTES[comp] : undefined;
    const comps = TYPE_COMPONENTS[type];
    if (a.bufferView !== undefined && a.bufferView !== null) {
      if (!inRange(a.bufferView, bufferViews.length, `${where}.bufferView`, "bufferView")) return;
      const bv = bufferViews[a.bufferView as number] ?? {};
      const bvLen = num(bv.byteLength) ?? 0;
      const off = num(a.byteOffset) ?? 0;
      if (compBytes === undefined || comps === undefined || count === null) return;
      const elementBytes = compBytes * comps;
      const stride = num(bv.byteStride) ?? elementBytes;
      const needed = count <= 0 ? 0 : (count - 1) * stride + elementBytes;
      if (off + needed > bvLen + 3) {
        problems.push(
          problem("ACCESSOR_OUT_OF_RANGE", "error", where, `needs ${off + needed} bytes but bufferView holds ${bvLen}`),
        );
      }
    } else if (a.bufferView === null) {
      // Spec: null bufferView = all zeros (valid but suspicious for real geometry).
      problems.push(problem("ACCESSOR_NULL_BUFFERVIEW", "warning", `${where}.bufferView`));
    } else {
      problems.push(problem("ACCESSOR_WITHOUT_BUFFERVIEW", "warning", where));
    }

    for (const bound of ["min", "max"] as const) {
      const v = a[bound];
      if (Array.isArray(v)) {
        if (comps !== undefined && v.length !== comps) {
          problems.push(problem("ACCESSOR_BOUND_LENGTH", "error", `${where}.${bound}`, `${v.length} values for ${type}`));
        }
        for (const x of v) if (typeof x !== "number" || !Number.isFinite(x)) problems.push(problem("NON_FINITE_NUMBER", "error", `${where}.${bound}`));
      }
    }
    if (comp === 5126 && Array.isArray(a.min) && Array.isArray(a.max)) {
      const mn = a.min as number[];
      const mx = a.max as number[];
      let inverted = false;
      for (let k = 0; k < Math.min(mn.length, mx.length); k += 1) {
        const lo = mn[k];
        const hi = mx[k];
        if (typeof lo === "number" && typeof hi === "number" && lo > hi) inverted = true;
      }
      if (inverted) problems.push(problem("ACCESSOR_MIN_GT_MAX", "error", where));
    }
  });

  // ── meshes ─────────────────────────────────────────────────────────────────
  let triangleCount = 0;
  let vertexCount = 0;
  let primitiveCount = 0;
  let zeroTriangleMeshes = 0;
  meshes.forEach((m, i) => {
    const prims = arr(m.primitives);
    const where = `meshes[${i}]`;
    if (prims.length === 0) problems.push(problem("MESH_WITHOUT_PRIMITIVES", "error", where));
    let meshTris = 0;
    prims.forEach((pRaw, pi) => {
      const p = isObj(pRaw) ? pRaw : {};
      const pWhere = `${where}.primitives[${pi}]`;
      primitiveCount += 1;
      const mode = p.mode === undefined ? 4 : intOrNull(p.mode);
      if (mode === null || mode < 0 || mode > 6) problems.push(problem("PRIMITIVE_BAD_MODE", "error", `${pWhere}.mode`, String(p.mode)));
      const attrs = isObj(p.attributes) ? p.attributes : {};
      const posIdx = attrs.POSITION;
      let posCount = 0;
      if (intOrNull(posIdx) === null) {
        problems.push(problem("PRIMITIVE_WITHOUT_POSITION", "error", `${pWhere}.attributes.POSITION`));
      } else if (inRange(posIdx, accessors.length, `${pWhere}.attributes.POSITION`, "accessor")) {
        const posAcc = accessors[posIdx as number] ?? {};
        if (posAcc.componentType !== 5126 && posAcc.componentType !== 5122 && posAcc.componentType !== 5123) {
          problems.push(problem("POSITION_BAD_COMPONENT_TYPE", "error", `${pWhere}.attributes.POSITION`, String(posAcc.componentType)));
        }
        if (posAcc.type !== "VEC3") problems.push(problem("POSITION_BAD_TYPE", "error", `${pWhere}.attributes.POSITION`, String(posAcc.type)));
        if (!Array.isArray(posAcc.min) || !Array.isArray(posAcc.max)) {
          problems.push(problem("POSITION_MISSING_BOUNDS", "warning", `${pWhere}.attributes.POSITION`));
        }
        posCount = intOrNull(posAcc.count) ?? 0;
        vertexCount += Math.max(0, posCount);
      }
      for (const [name, accIdx] of Object.entries(attrs)) {
        if (name === "POSITION") continue;
        if (intOrNull(accIdx) === null) problems.push(problem("ATTRIBUTE_NOT_ACCESSOR", "error", `${pWhere}.attributes.${name}`));
        else inRange(accIdx, accessors.length, `${pWhere}.attributes.${name}`, "accessor");
      }
      let drawCount = posCount;
      if (p.indices !== undefined) {
        if (inRange(p.indices, accessors.length, `${pWhere}.indices`, "accessor")) {
          const idxAcc = accessors[p.indices as number] ?? {};
          if (![5121, 5123, 5125].includes(idxAcc.componentType as number)) {
            problems.push(problem("INDICES_BAD_COMPONENT_TYPE", "error", `${pWhere}.indices`, String(idxAcc.componentType)));
          }
          if (idxAcc.type !== "SCALAR") problems.push(problem("INDICES_BAD_TYPE", "error", `${pWhere}.indices`, String(idxAcc.type)));
          drawCount = intOrNull(idxAcc.count) ?? 0;
        }
      } else {
        problems.push(problem("PRIMITIVE_WITHOUT_INDICES", "info", pWhere));
      }
      const tris =
        mode === 4 ? Math.floor(drawCount / 3) : mode === 5 || mode === 6 ? Math.max(0, drawCount - 2) : 0;
      meshTris += tris;
      if (p.material !== undefined) inRange(p.material, materials.length, `${pWhere}.material`, "material");
      if (p.targets !== undefined && !Array.isArray(p.targets)) problems.push(problem("MORPH_TARGETS_INVALID", "error", `${pWhere}.targets`));
    });
    if (meshTris === 0 && prims.length > 0) zeroTriangleMeshes += 1;
    triangleCount += meshTris;
  });

  // ── materials / textures / images / samplers ───────────────────────────────
  materials.forEach((mat, i) => {
    const where = `materials[${i}]`;
    const pbr = isObj(mat.pbrMetallicRoughness) ? mat.pbrMetallicRoughness : null;
    if (pbr) {
      for (const key of ["baseColorTexture", "metallicRoughnessTexture"]) {
        const t = pbr[key];
        if (t !== undefined) {
          if (!isObj(t)) problems.push(problem("TEXTURE_REF_INVALID", "error", `${where}.pbrMetallicRoughness.${key}`));
          else inRange(t.index, textures.length, `${where}.pbrMetallicRoughness.${key}.index`, "texture");
        }
      }
      for (const key of ["baseColorFactor", "metallicFactor", "roughnessFactor", "alphaCutoff"]) {
        const v = pbr[key];
        if (v !== undefined && !Array.isArray(v) && num(v) === null) problems.push(problem("MATERIAL_NON_FINITE", "error", `${where}.${key}`));
        if (Array.isArray(v) && v.some((x) => num(x) === null)) problems.push(problem("MATERIAL_NON_FINITE", "error", `${where}.${key}`));
      }
    }
    for (const key of ["normalTexture", "occlusionTexture", "emissiveTexture"]) {
      const t = mat[key];
      if (t !== undefined) {
        if (!isObj(t)) problems.push(problem("TEXTURE_REF_INVALID", "error", `${where}.${key}`));
        else inRange(t.index, textures.length, `${where}.${key}.index`, "texture");
      }
    }
    if (mat.alphaMode !== undefined && !["OPAQUE", "MASK", "BLEND"].includes(String(mat.alphaMode))) {
      problems.push(problem("MATERIAL_BAD_ALPHA_MODE", "error", `${where}.alphaMode`, String(mat.alphaMode)));
    }
  });

  textures.forEach((t, i) => {
    const where = `textures[${i}]`;
    if (t.source !== undefined) inRange(t.source, images.length, `${where}.source`, "image");
    if (t.sampler !== undefined) inRange(t.sampler, samplers.length, `${where}.sampler`, "sampler");
    const ext = isObj(t.extensions) ? t.extensions : {};
    const basisu = isObj(ext.KHR_texture_basisu) ? ext.KHR_texture_basisu : null;
    if (basisu) inRange(basisu.source, images.length, `${where}.extensions.KHR_texture_basisu.source`, "image");
    const webp = isObj(ext.EXT_texture_webp) ? ext.EXT_texture_webp : null;
    if (webp) inRange(webp.source, images.length, `${where}.extensions.EXT_texture_webp.source`, "image");
    if (t.source === undefined && !basisu && !webp) problems.push(problem("TEXTURE_WITHOUT_SOURCE", "error", where));
  });

  images.forEach((img, i) => {
    const where = `images[${i}]`;
    const hasUri = typeof img.uri === "string";
    const hasView = img.bufferView !== undefined && img.bufferView !== null;
    if (hasUri && hasView) problems.push(problem("IMAGE_AMBIGUOUS_SOURCE", "error", where, "both uri and bufferView"));
    if (!hasUri && !hasView) problems.push(problem("IMAGE_WITHOUT_SOURCE", "error", where));
    if (hasView) {
      inRange(img.bufferView, bufferViews.length, `${where}.bufferView`, "bufferView");
      if (typeof img.mimeType !== "string") problems.push(problem("IMAGE_MISSING_MIMETYPE", "error", `${where}.mimeType`));
    }
  });

  // ── nodes / scenes (with cycle detection) ──────────────────────────────────
  nodes.forEach((n, i) => {
    const where = `nodes[${i}]`;
    for (const c of arr(n.children)) inRange(c, nodes.length, `${where}.children`, "node");
    if (n.mesh !== undefined) inRange(n.mesh, meshes.length, `${where}.mesh`, "mesh");
    if (n.camera !== undefined) inRange(n.camera, cameras.length, `${where}.camera`, "camera");
    if (n.skin !== undefined) inRange(n.skin, skins.length, `${where}.skin`, "skin");
    if (n.matrix !== undefined) {
      if (!Array.isArray(n.matrix) || n.matrix.length !== 16) problems.push(problem("NODE_MATRIX_INVALID", "error", `${where}.matrix`));
    }
    for (const key of ["translation", "rotation", "scale"] as const) {
      const v = n[key];
      if (v !== undefined) {
        const expected = key === "rotation" ? 4 : 3;
        if (!Array.isArray(v) || v.length !== expected || v.some((x) => num(x) === null)) {
          problems.push(problem("NODE_TRANSFORM_INVALID", "error", `${where}.${key}`));
        }
      }
    }
    if (n.matrix !== undefined && (n.translation !== undefined || n.rotation !== undefined || n.scale !== undefined)) {
      problems.push(problem("NODE_TRS_AND_MATRIX", "error", where, "matrix and TRS are mutually exclusive"));
    }
    if (n.weights !== undefined && !Array.isArray(n.weights)) problems.push(problem("NODE_WEIGHTS_INVALID", "error", `${where}.weights`));
  });

  const CYCLES: { path: string }[] = [];
  {
    const state = new Uint8Array(nodes.length); // 0 unseen, 1 on stack, 2 done
    const visit = (i: number, path: number[]): void => {
      if (state[i] === 1) {
        CYCLES.push({ path: [...path, i].join("→") });
        return;
      }
      if (state[i] === 2) return;
      state[i] = 1;
      for (const c of arr(nodes[i]?.children)) {
        const ci = intOrNull(c);
        if (ci !== null && ci >= 0 && ci < nodes.length) visit(ci, [...path, i]);
      }
      state[i] = 2;
    };
    for (let i = 0; i < nodes.length; i += 1) if (state[i] === 0) visit(i, []);
  }
  for (const c of CYCLES.slice(0, 5)) problems.push(problem("NODE_GRAPH_CYCLE", "error", "nodes", `cycle through ${c.path}`));
  if (CYCLES.length > 5) problems.push(problem("NODE_GRAPH_CYCLE", "error", "nodes", `${CYCLES.length} cycles total`));

  scenes.forEach((s, i) => {
    const where = `scenes[${i}]`;
    for (const r of arr(s.nodes)) inRange(r, nodes.length, `${where}.nodes`, "node");
    if (arr(s.nodes).length === 0) problems.push(problem("EMPTY_SCENE", "error", where));
  });
  if (scenes.length === 0) problems.push(problem("NO_SCENES", "error", "scenes", "glTF without a scene is not renderable as an asset"));
  if (json.scene !== undefined) inRange(json.scene, scenes.length, "scene", "scene");
  if (meshes.length === 0) problems.push(problem("NO_MESHES", "error", "meshes", "asset contains no geometry"));
  if (zeroTriangleMeshes > 0) problems.push(problem("DEGENERATE_MESHES", "warning", "meshes", `${zeroTriangleMeshes} mesh(es) with 0 triangles`));

  // ── animations / skins / cameras ───────────────────────────────────────────
  animations.forEach((a, i) => {
    const where = `animations[${i}]`;
    const samplersIn = arr(a.samplers);
    if (samplersIn.length === 0) problems.push(problem("ANIMATION_WITHOUT_SAMPLERS", "error", where));
    samplersIn.forEach((sRaw, si) => {
      if (!isObj(sRaw)) return;
      inRange(sRaw.input, accessors.length, `${where}.samplers[${si}].input`, "accessor");
      inRange(sRaw.output, accessors.length, `${where}.samplers[${si}].output`, "accessor");
    });
    arr(a.channels).forEach((cRaw, ci) => {
      if (!isObj(cRaw)) {
        problems.push(problem("ANIMATION_CHANNEL_INVALID", "error", `${where}.channels[${ci}]`));
        return;
      }
      inRange(cRaw.sampler, samplersIn.length, `${where}.channels[${ci}].sampler`, "sampler");
      const target = isObj(cRaw.target) ? cRaw.target : {};
      if (target.node !== undefined) inRange(target.node, nodes.length, `${where}.channels[${ci}].target.node`, "node");
    });
  });

  skins.forEach((s, i) => {
    const where = `skins[${i}]`;
    if (s.inverseBindMatrices !== undefined) inRange(s.inverseBindMatrices, accessors.length, `${where}.inverseBindMatrices`, "accessor");
    const joints = arr(s.joints);
    if (joints.length === 0) problems.push(problem("SKIN_WITHOUT_JOINTS", "error", where));
    for (const j of joints) inRange(j, nodes.length, `${where}.joints`, "node");
    if (s.skeleton !== undefined) inRange(s.skeleton, nodes.length, `${where}.skeleton`, "node");
  });

  cameras.forEach((c, i) => {
    const where = `cameras[${i}]`;
    const type = c.type;
    if (type !== "perspective" && type !== "orthographic") {
      problems.push(problem("CAMERA_BAD_TYPE", "error", `${where}.type`, String(type)));
      return;
    }
    const spec = isObj(type === "perspective" ? c.perspective : c.orthographic) ? (type === "perspective" ? (c.perspective as Json) : (c.orthographic as Json)) : null;
    if (!spec) problems.push(problem("CAMERA_MISSING_SPEC", "error", where));
    else if (type === "perspective" && num(spec.yfov) === null) problems.push(problem("CAMERA_MISSING_YFOV", "error", `${where}.perspective.yfov`));
  });

  // ── extensions ─────────────────────────────────────────────────────────────
  const extensionsUsed = arr(json.extensionsUsed).filter((x): x is string => typeof x === "string");
  const extensionsRequired = arr(json.extensionsRequired).filter((x): x is string => typeof x === "string");
  const unknownUsed = extensionsUsed.filter((e) => !KNOWN_EXTENSIONS.has(e));
  const unknownRequired = extensionsRequired.filter((e) => !KNOWN_EXTENSIONS.has(e));
  for (const e of extensionsRequired) {
    if (!extensionsUsed.includes(e)) problems.push(problem("REQUIRED_EXTENSION_NOT_USED", "error", "extensionsRequired", e));
  }
  for (const e of unknownRequired) problems.push(problem("UNSUPPORTED_REQUIRED_EXTENSION", "error", "extensionsRequired", e));
  for (const e of unknownUsed) problems.push(problem("UNKNOWN_EXTENSION", "warning", "extensionsUsed", e));

  // ── depth + counts ─────────────────────────────────────────────────────────
  let depth = 0;
  {
    const memo = new Map<number, number>();
    const onStack = new Set<number>();
    const depthOf = (i: number): number => {
      const cached = memo.get(i);
      if (cached !== undefined) return cached;
      // A cycle is already reported as an error above; measuring its depth is
      // meaningless — bail out instead of recursing forever.
      if (onStack.has(i)) return 0;
      onStack.add(i);
      const kids = arr(nodes[i]?.children)
        .map((c) => intOrNull(c))
        .filter((c): c is number => c !== null && c >= 0 && c < nodes.length);
      const d = kids.length === 0 ? 1 : 1 + Math.max(0, ...kids.map(depthOf));
      onStack.delete(i);
      memo.set(i, d);
      return d;
    };
    for (let i = 0; i < nodes.length; i += 1) depth = Math.max(depth, depthOf(i));
  }

  const defaultScene = intOrNull(json.scene);
  const sceneNodes = defaultScene !== null && scenes[defaultScene] ? arr((scenes[defaultScene] as Json).nodes) : scenes[0] ? arr((scenes[0] as Json).nodes) : [];
  const hasRenderableScene = meshes.length > 0 && sceneNodes.length > 0;

  if (nodes.length > LIMITS.failNodes) problems.push(problem("LIMIT_NODES", "error", "nodes", `${nodes.length} > ${LIMITS.failNodes}`));
  if (meshes.length > LIMITS.failMeshes) problems.push(problem("LIMIT_MESHES", "error", "meshes", `${meshes.length} > ${LIMITS.failMeshes}`));
  if (materials.length > LIMITS.failMaterials) problems.push(problem("LIMIT_MATERIALS", "error", "materials", `${materials.length} > ${LIMITS.failMaterials}`));
  if (images.length > LIMITS.failImages) problems.push(problem("LIMIT_IMAGES", "error", "images", `${images.length} > ${LIMITS.failImages}`));
  if (triangleCount > LIMITS.failTriangles) problems.push(problem("LIMIT_TRIANGLES", "error", "meshes", `${triangleCount} > ${LIMITS.failTriangles}`));
  if (depth > LIMITS.failHierarchyDepth) problems.push(problem("LIMIT_HIERARCHY_DEPTH", "error", "nodes", `${depth} > ${LIMITS.failHierarchyDepth}`));
  if (animations.length > LIMITS.failAnimations) problems.push(problem("LIMIT_ANIMATIONS", "error", "animations", `${animations.length} > ${LIMITS.failAnimations}`));
  if (jsonBytes > LIMITS.failJsonBytes) problems.push(problem("LIMIT_JSON_BYTES", "error", "chunks[JSON]", `${jsonBytes} > ${LIMITS.failJsonBytes}`));

  const info: GlbContainerInfo = {
    version: 2,
    declaredLength: 0,
    actualLength: 0,
    chunks: [],
    binChunkLength: bin ? bin.length : 0,
    jsonBytes,
    generator,
    gltfVersion,
    extensionsUsed,
    extensionsRequired,
    unknownExtensionsUsed: unknownUsed,
    unknownExtensionsRequired: unknownRequired,
    counts: {
      scenes: scenes.length,
      nodes: nodes.length,
      meshes: meshes.length,
      materials: materials.length,
      textures: textures.length,
      images: images.length,
      samplers: samplers.length,
      accessors: accessors.length,
      bufferViews: bufferViews.length,
      buffers: buffers.length,
      animations: animations.length,
      cameras: cameras.length,
      skins: skins.length,
    },
    hasRenderableScene,
  };

  const stats: StructureStats = {
    triangles: triangleCount,
    vertices: vertexCount,
    primitives: primitiveCount,
    zeroTriangleMeshes,
    hierarchyDepth: depth,
  };

  return { problems, info, stats };
}

/** Exported for the inventory layer: per-primitive triangle math, single source. */
export function primitiveTriangles(mode: number | null, drawCount: number): number {
  if (mode === 4) return Math.floor(drawCount / 3);
  if (mode === 5 || mode === 6) return Math.max(0, drawCount - 2);
  return 0;
}
