// P2-J: single entry point for auditing one untrusted 3D file.
//
// auditAsset() is pure with respect to the outside world: it reads bytes,
// returns a report. Callers (CLI, tests, a future admin route) decide what to do
// with the verdict — but nothing downstream may treat a FAIL as shippable.
import { createHash } from "node:crypto";
import { parseGlb } from "./glb";
import { validateStructure } from "./structure";
import { scanSecurity } from "./security";
import { buildInventory, mergeMetrics } from "./inventory";
import { ProvenanceRecord, validateProvenance } from "./provenance";
import {
  AssetMetrics,
  GlbAudit,
  GlbContainerInfo,
  LIMITS,
  Problem,
  RightsSummaryLike,
  Verdict,
  hasErrors,
  problem,
} from "./types";

type Json = Record<string, unknown>;

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export type AuditOptions = {
  /** Provenance record (J0/J1) to validate against the actual file. */
  provenance?: ProvenanceRecord | null;
  /**
   * raw-ingestion: generous ceilings for a just-downloaded source file.
   * production-delivery: adds the thresholds that decide browser deliverability.
   */
  limitProfile?: "raw-ingestion" | "production-delivery";
};

function deliveryThresholds(metrics: AssetMetrics | null, info: { counts: { meshes: number } } | null): Problem[] {
  const out: Problem[] = [];
  if (!metrics) return out;
  if (metrics.fileBytes > LIMITS.warnOptimizedFileBytes) {
    out.push(problem("DELIVERY_FILE_LARGE", "warning", "file", `${metrics.fileBytes} bytes > ${LIMITS.warnOptimizedFileBytes}`));
  }
  if (metrics.triangles > LIMITS.warnTriangles) {
    out.push(problem("DELIVERY_TRIANGLES_HIGH", "warning", "meshes", `${metrics.triangles} > ${LIMITS.warnTriangles}`));
  }
  if (metrics.largestTextureDimension > LIMITS.warnTextureDimension) {
    out.push(problem("DELIVERY_TEXTURE_LARGE", "warning", "images", `${metrics.largestTextureDimension}px > ${LIMITS.warnTextureDimension}px`));
  }
  if (info && info.counts.meshes > LIMITS.warnDrawCalls) {
    out.push(problem("DELIVERY_DRAW_CALLS_HIGH", "warning", "meshes", `${info.counts.meshes} draw calls`));
  }
  return out;
}

/**
 * Audit a file end-to-end. When the container cannot be parsed at all, the
 * remaining dimensions are NOT_EVALUATED (never "passed by default").
 */
export function auditAsset(buf: Buffer, opts: AuditOptions = {}): GlbAudit {
  const limitProfile = opts.limitProfile ?? "raw-ingestion";
  const digest = sha256(buf);
  const auditedAt = new Date().toISOString();

  if (buf.length > LIMITS.failFileBytes) {
    return {
      sha256: digest,
      byteLength: buf.length,
      container: null,
      structure: { verdict: "FAIL", problems: [problem("LIMIT_FILE_BYTES", "error", "file", `${buf.length} > ${LIMITS.failFileBytes}`)] },
      security: { verdict: "NOT_EVALUATED", problems: [] },
      selfContained: { verdict: "NOT_EVALUATED", externalReferences: [] },
      metrics: null,
      inventory: null,
      metadataUrls: [],
      provenance: null,
      verdict: "FAIL",
      limitProfile,
      auditedAt,
    };
  }

  const parsed = parseGlb(buf);
  if (!parsed.ok) {
    return {
      sha256: digest,
      byteLength: buf.length,
      container: null,
      structure: { verdict: "FAIL", problems: parsed.problems },
      security: { verdict: "NOT_EVALUATED", problems: [] },
      selfContained: { verdict: "NOT_EVALUATED", externalReferences: [] },
      metrics: null,
      inventory: null,
      metadataUrls: [],
      provenance: null,
      verdict: "FAIL",
      limitProfile,
      auditedAt,
    };
  }

  const json = parsed.json as Json;
  const structure = validateStructure(json, parsed.bin, Buffer.byteLength(parsed.jsonText, "utf8"));
  const container = {
    ...structure.info,
    declaredLength: parsed.declaredLength,
    actualLength: buf.length,
    chunks: parsed.chunks.map((c) => ({ type: c.type, length: c.length, offset: c.offset })),
  };
  const security = scanSecurity(json, parsed.bin, buf, parsed.chunks);

  const { inventory, metrics: baseMetrics } = buildInventory({ json, bin: parsed.bin });
  const metrics = mergeMetrics(baseMetrics, structure.info, structure.stats);
  metrics.fileBytes = buf.length;

  const selfContained: GlbAudit["selfContained"] =
    security.externalReferences.length === 0 ? { verdict: "PASS", externalReferences: [] } : { verdict: "FAIL", externalReferences: security.externalReferences };

  let provenance: GlbAudit["provenance"] = null;
  if (opts.provenance) {
    const check = validateProvenance(opts.provenance, { fileSize: buf.length, sha256: digest });
    provenance = {
      verdict: hasErrors(check.problems) ? "FAIL" : "PASS",
      problems: check.problems,
      rights: check.rights as RightsSummaryLike,
    };
  }

  // Delivery thresholds describe the *browser-facing* budget, so they are only
  // folded in for the production-delivery profile — a just-downloaded raw file
  // is measured, not judged.
  const structureProblems = limitProfile === "production-delivery"
    ? [...structure.problems, ...deliveryThresholds(metrics, container)]
    : [...structure.problems];
  const structureVerdict: Verdict = hasErrors(structure.problems) ? "FAIL" : "PASS";
  const securityVerdict: Verdict = hasErrors(security.problems) ? "FAIL" : "PASS";
  const allProblems = [...structureProblems, ...security.problems, ...(provenance?.problems ?? [])];
  const verdict: Verdict = hasErrors(allProblems) ? "FAIL" : "PASS";

  return {
    sha256: digest,
    byteLength: buf.length,
    container,
    structure: { verdict: structureVerdict, problems: structureProblems },
    security: { verdict: securityVerdict, problems: security.problems },
    selfContained,
    metrics,
    inventory,
    metadataUrls: security.metadataUrls,
    provenance,
    verdict,
    limitProfile,
    auditedAt,
  };
}

export type StoredAudit = {
  sha256: string;
  byteLength: number;
  verdict: Verdict;
  structure: Verdict;
  security: Verdict;
  selfContained: Verdict;
  provenance: Verdict | null;
  rights: RightsSummaryLike | null;
  limitProfile: GlbAudit["limitProfile"];
  auditedAt: string;
  generator: string | null;
  gltfVersion: string | null;
  extensionsRequired: string[];
  unknownExtensions: string[];
  counts: GlbContainerInfo["counts"];
  metrics: AssetMetrics | null;
  inventoryHash: string | null;
  inventory: {
    /** Trimmed inventory kept for mapping-drift detection (fingerprints are the point). */
    entries: {
      nodeIndex: number;
      path: string;
      nodeName: string;
      nameSource: "AUTHORED" | "DERIVED_UNNAMED";
      meshIndex: number | null;
      meshName: string;
      primitives: number;
      triangles: number;
      vertices: number;
      visible: boolean;
      bboxMin: [number, number, number] | null;
      bboxMax: [number, number, number] | null;
      fingerprint: string;
    }[];
    truncated: boolean;
    meshNodeCount: number;
    unnamedMeshNodes: number;
    duplicateMeshNames: string[];
  } | null;
  problems: Problem[];
  metadataUrls: string[];
};

const MAX_STORED_ENTRIES = 2000;

/** Compact, DB-storable form of an audit (full report stays in the docs/CLI output). */
export function summarizeAudit(audit: GlbAudit, metadataUrls: string[] = audit.metadataUrls): StoredAudit {
  const entries = audit.inventory?.entries ?? [];
  const problems = [
    ...audit.structure.problems,
    ...audit.security.problems,
    ...(audit.provenance?.problems ?? []),
  ];
  return {
    sha256: audit.sha256,
    byteLength: audit.byteLength,
    verdict: audit.verdict,
    structure: audit.structure.verdict,
    security: audit.security.verdict,
    selfContained: audit.selfContained.verdict,
    provenance: audit.provenance?.verdict ?? null,
    rights: audit.provenance?.rights ?? null,
    limitProfile: audit.limitProfile,
    auditedAt: audit.auditedAt,
    generator: audit.container?.generator ?? null,
    gltfVersion: audit.container?.gltfVersion ?? null,
    extensionsRequired: audit.container?.extensionsRequired ?? [],
    unknownExtensions: [
      ...(audit.container?.unknownExtensionsUsed ?? []),
      ...(audit.container?.unknownExtensionsRequired ?? []),
    ],
    counts: audit.container?.counts ?? {
      scenes: 0, nodes: 0, meshes: 0, materials: 0, textures: 0, images: 0,
      samplers: 0, accessors: 0, bufferViews: 0, buffers: 0, animations: 0, cameras: 0, skins: 0,
    },
    metrics: audit.metrics,
    inventoryHash: audit.inventory?.inventoryHash ?? null,
    inventory: audit.inventory
      ? {
          entries: entries.slice(0, MAX_STORED_ENTRIES).map((e) => ({
            nodeIndex: e.nodeIndex,
            path: e.path,
            nodeName: e.nodeName,
            nameSource: e.nameSource,
            meshIndex: e.meshIndex,
            meshName: e.meshName,
            primitives: e.primitives,
            triangles: e.triangles,
            vertices: e.vertices,
            visible: e.visible,
            bboxMin: e.bboxMin,
            bboxMax: e.bboxMax,
            fingerprint: e.fingerprint,
          })),
          truncated: entries.length > MAX_STORED_ENTRIES,
          meshNodeCount: audit.inventory.meshNodeCount,
          unnamedMeshNodes: audit.inventory.unnamedMeshNodes,
          duplicateMeshNames: audit.inventory.duplicateMeshNames,
        }
      : null,
    problems,
    metadataUrls,
  };
}

/** One-line human summary for CLI output. */
export function auditSummaryLine(audit: GlbAudit): string {
  const m = audit.metrics;
  const errs = [...audit.structure.problems, ...audit.security.problems, ...(audit.provenance?.problems ?? [])].filter(
    (p) => p.severity === "error",
  );
  return [
    `verdict=${audit.verdict}`,
    `bytes=${audit.byteLength}`,
    m ? `tris=${m.triangles}` : "tris=?",
    m ? `nodes=${m.nodes}` : "nodes=?",
    m ? `meshes=${m.meshes}` : "meshes=?",
    m ? `materials=${m.materials}` : "materials=?",
    m ? `textures=${m.textures}` : "textures=?",
    `errors=${errs.length}`,
  ].join(" · ");
}
