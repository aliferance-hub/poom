// P2-J (J3 thema): shared vocabulary of the 3D asset validation layer.
//
// Design rules:
//  - Pure data + pure functions: no Prisma, no storage, no network. The same
//    code runs in tests, in the ingestion CLI and (potentially) in a Next
//    server route, so it must not pull runtime-only dependencies.
//  - Every finding is a machine-readable `code` + human `detail`; nothing is
//    inferred from a filename, and a missing field is reported, never filled in.

export type Severity = "error" | "warning" | "info";

export type Problem = {
  /** Stable machine code, e.g. NOT_A_GLB / EXTERNAL_REFERENCE / LIMIT_TRIANGLES. */
  code: string;
  severity: Severity;
  /** Where the problem was found, e.g. "nodes[7].mesh" or "images[2].uri". */
  where?: string;
  detail?: string;
};

export function problem(code: string, severity: Severity, where?: string, detail?: string): Problem {
  return { code, severity, where, detail };
}

export function errors(problems: Problem[]): Problem[] {
  return problems.filter((p) => p.severity === "error");
}

export function hasErrors(problems: Problem[]): boolean {
  return problems.some((p) => p.severity === "error");
}

/**
 * Hard limits for an asset that must render inside a Next.js/R3F page on
 * consumer hardware and mobile browsers. Two kinds of thresholds:
 *  - `fail*`: beyond these an asset is not deliverable and validation fails.
 *  - `warn*`: measured values that require justification in the reports.
 * Limits are deliberately generous for RAW ingestion (we must be able to see
 * and measure a heavy source file) and tight for what may be promoted.
 */
export const LIMITS = {
  /** Raw ingestion ceiling (local CLI path; the HTTP upload route caps at 4 MB). */
  failFileBytes: 128 * 1024 * 1024,
  failJsonBytes: 32 * 1024 * 1024,
  failNodes: 20_000,
  failMeshes: 20_000,
  failMaterials: 4_000,
  failImages: 512,
  failTextureDimension: 8192,
  failTriangles: 5_000_000,
  failHierarchyDepth: 128,
  failDataUriBytes: 16 * 1024 * 1024,
  failAnimations: 256,
  /** Production-delivery thresholds: above these the asset needs measured justification. */
  warnOptimizedFileBytes: 8 * 1024 * 1024,
  warnTriangles: 400_000,
  warnTextureDimension: 4096,
  warnDrawCalls: 256,
} as const;

/** Rights summary as produced by the provenance layer (kept dependency-free here). */
export type RightsSummaryLike = {
  commercialUse: "YES" | "NO" | "UNKNOWN";
  redistribution: "YES" | "NO" | "UNKNOWN";
  modification: "YES" | "NO" | "UNKNOWN";
  attributionRequired: boolean;
  class: "OPEN_PERMISSIVE" | "OPEN_ATTRIBUTION" | "OPEN_SHARE_ALIKE" | "UNKNOWN" | "RESTRICTED";
};

/** Structural counters shared between the structure pass and the metrics block. */
export type StructureStatsLike = {
  triangles: number;
  vertices: number;
  primitives: number;
  hierarchyDepth: number;
};

/** Result of one validation dimension. */
export type Verdict = "PASS" | "FAIL" | "NOT_EVALUATED";

export type GlbAudit = {
  /** SHA-256 of the exact bytes that were audited. */
  sha256: string;
  byteLength: number;
  /** Container facts (null when the file could not be parsed at all). */
  container: GlbContainerInfo | null;
  structure: { verdict: Verdict; problems: Problem[] };
  security: { verdict: Verdict; problems: Problem[] };
  /** Self-contained = no external references; required before production. */
  selfContained: { verdict: Verdict; externalReferences: string[] };
  metrics: AssetMetrics | null;
  inventory: AssetInventory | null;
  /** URLs mentioned in the document's own metadata (provenance hints, not deps). */
  metadataUrls: string[];
  /** Present only when a provenance record was supplied (J0/J1 evidence). */
  provenance: { verdict: Verdict; problems: Problem[]; rights: RightsSummaryLike } | null;
  /** Single overall verdict: FAIL if any dimension failed. */
  verdict: Verdict;
  limitProfile: "raw-ingestion" | "production-delivery";
  auditedAt: string;
};

export type GlbContainerInfo = {
  version: number;
  declaredLength: number;
  actualLength: number;
  chunks: { type: string; length: number; offset: number }[];
  binChunkLength: number;
  jsonBytes: number;
  generator: string | null;
  gltfVersion: string | null;
  extensionsUsed: string[];
  extensionsRequired: string[];
  unknownExtensionsUsed: string[];
  unknownExtensionsRequired: string[];
  counts: {
    scenes: number;
    nodes: number;
    meshes: number;
    materials: number;
    textures: number;
    images: number;
    samplers: number;
    accessors: number;
    bufferViews: number;
    buffers: number;
    animations: number;
    cameras: number;
    skins: number;
  };
  /** Whether the JSON chunk declares a base scene with at least one node. */
  hasRenderableScene: boolean;
};

export type AssetMetrics = {
  fileBytes: number;
  triangles: number;
  vertices: number;
  nodes: number;
  meshes: number;
  meshPrimitives: number;
  materials: number;
  textures: number;
  images: number;
  animations: number;
  cameras: number;
  lights: number;
  /** Texture bytes actually embedded in the GLB (BIN + data URIs). */
  embeddedTextureBytes: number;
  largestTextureDimension: number;
  largestImageBytes: number;
  /** Rough GPU cost estimate (vertex attributes + indices + decoded textures). */
  estimatedGpuBytes: number;
  hierarchyDepth: number;
};

export type MeshInventoryEntry = {
  /** Index of the owning node in the glTF node array. */
  nodeIndex: number;
  /** Human path from the scene root, e.g. "Body/Wheel_FL". */
  path: string;
  /** Node name exactly as authored (`""` when unnamed — never invented). */
  nodeName: string;
  /** AUTHORED = the file carries this name; DERIVED_UNNAMED = positional key, not mappable. */
  nameSource: "AUTHORED" | "DERIVED_UNNAMED";
  meshIndex: number | null;
  meshName: string;
  primitives: number;
  triangles: number;
  vertices: number;
  materials: string[];
  visible: boolean;
  bboxMin: [number, number, number] | null;
  bboxMax: [number, number, number] | null;
  /** Structural fingerprint: identity of this mesh for mapping-drift detection. */
  fingerprint: string;
};

export type AssetInventory = {
  entries: MeshInventoryEntry[];
  /** Fingerprint of the whole inventory — stored with the version. */
  inventoryHash: string;
  /** Non-mesh nodes (groups, lights, cameras) for the hierarchy inspector. */
  groups: { path: string; name: string; children: number; hasMesh: boolean }[];
  meshNodeCount: number;
  unnamedMeshNodes: number;
  duplicateMeshNames: string[];
};
