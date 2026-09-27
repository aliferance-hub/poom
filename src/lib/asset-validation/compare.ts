// P2-J (J4 + §11/§12): measured before/after comparison and the optimization
// quality gate. Numbers come from audits of the actual bytes — never estimates —
// and the gate refuses an optimized artifact that lost identity, names, or
// material data the mappings depend on.
import { GlbAudit, Problem, problem } from "./types";

export type MetricDelta = {
  raw: number;
  optimized: number;
  delta: number;
  ratio: number;
};

export type OptimizationComparison = {
  deltas: {
    fileBytes: MetricDelta;
    triangles: MetricDelta;
    vertices: MetricDelta;
    nodes: MetricDelta;
    meshes: MetricDelta;
    materials: MetricDelta;
    textures: MetricDelta;
  };
  /** Names that existed in the raw file and are gone after optimization. */
  lostMeshNames: string[];
  /** Names a mapping depends on that are missing after optimization (hard error). */
  missingRequiredNames: string[];
  problems: Problem[];
  ok: boolean;
};

function delta(raw: number, optimized: number): MetricDelta {
  return {
    raw,
    optimized,
    delta: optimized - raw,
    ratio: raw === 0 ? (optimized === 0 ? 1 : Infinity) : optimized / raw,
  };
}

/** Union bounding box of all mesh entries, for scale-preservation checks. */
function bounds(audit: GlbAudit): { min: [number, number, number]; max: [number, number, number] } | null {
  let min: [number, number, number] | null = null;
  let max: [number, number, number] | null = null;
  for (const e of audit.inventory?.entries ?? []) {
    if (!e.bboxMin || !e.bboxMax) continue;
    min = min === null ? e.bboxMin : [Math.min(min[0], e.bboxMin[0]), Math.min(min[1], e.bboxMin[1]), Math.min(min[2], e.bboxMin[2])];
    max = max === null ? e.bboxMax : [Math.max(max[0], e.bboxMax[0]), Math.max(max[1], e.bboxMax[1]), Math.max(max[2], e.bboxMax[2])];
  }
  return min && max ? { min, max } : null;
}

export type CompareOptions = {
  /** Mesh/node names some mapping or contract depends on — must survive. */
  requiredMeshNames?: string[];
  /** Ratio below this (after/before triangles) is flagged as identity-risking. */
  minTriangleRatio?: number;
  /** Relative bbox tolerance for scale preservation (default 2%). */
  boundsTolerance?: number;
};

/**
 * Compare a raw audit with an optimized audit. `ok` is only true when the
 * optimized artifact is itself valid AND no hard quality gate tripped — which is
 * exactly what §12 demands before an optimized asset may replace the raw one.
 */
export function compareAudits(raw: GlbAudit, optimized: GlbAudit, opts: CompareOptions = {}): OptimizationComparison {
  const problems: Problem[] = [];
  const minRatio = opts.minTriangleRatio ?? 0.05;
  const tol = opts.boundsTolerance ?? 0.02;

  const rm = raw.metrics;
  const om = optimized.metrics;
  if (!rm || !om) {
    problems.push(problem("COMPARE_WITHOUT_METRICS", "error", "metrics", "both audits must carry metrics"));
    return {
      deltas: {
        fileBytes: delta(0, 0), triangles: delta(0, 0), vertices: delta(0, 0),
        nodes: delta(0, 0), meshes: delta(0, 0), materials: delta(0, 0), textures: delta(0, 0),
      },
      lostMeshNames: [],
      missingRequiredNames: [],
      problems,
      ok: false,
    };
  }

  const deltas = {
    fileBytes: delta(rm.fileBytes, om.fileBytes),
    triangles: delta(rm.triangles, om.triangles),
    vertices: delta(rm.vertices, om.vertices),
    nodes: delta(rm.nodes, om.nodes),
    meshes: delta(rm.meshes, om.meshes),
    materials: delta(rm.materials, om.materials),
    textures: delta(rm.textures, om.textures),
  };

  if (optimized.verdict === "FAIL") problems.push(problem("OPTIMIZED_INVALID", "error", "optimized", "optimized artifact failed its own audit"));
  if (deltas.fileBytes.optimized >= deltas.fileBytes.raw) {
    problems.push(problem("SIZE_NOT_REDUCED", "warning", "fileBytes", `${deltas.fileBytes.raw} → ${deltas.fileBytes.optimized}`));
  }
  if (deltas.triangles.optimized === 0) {
    problems.push(problem("GEOMETRY_EMPTY", "error", "triangles", "optimized artifact has no triangles"));
  } else if (deltas.triangles.ratio < minRatio) {
    problems.push(
      problem("AGGRESSIVE_REDUCTION", "warning", "triangles", `${deltas.triangles.raw} → ${deltas.triangles.optimized} (${(deltas.triangles.ratio * 100).toFixed(1)}%)`),
    );
  }
  if (deltas.materials.raw > 0 && deltas.materials.optimized === 0) {
    problems.push(problem("MATERIALS_DROPPED", "error", "materials", "optimized artifact lost every material"));
  }
  if (deltas.textures.raw > 0 && deltas.textures.optimized === 0) {
    problems.push(problem("TEXTURES_DROPPED", "error", "textures", "every texture disappeared — appearance cannot be preserved"));
  }
  if (rm.largestTextureDimension > 0 && om.largestTextureDimension > rm.largestTextureDimension) {
    problems.push(problem("TEXTURES_ENLARGED", "warning", "images", `${rm.largestTextureDimension} → ${om.largestTextureDimension}`));
  }

  const rawAuthored = (raw.inventory?.entries ?? []).filter((e) => e.nameSource === "AUTHORED").map((e) => e.nodeName);
  const optAuthored = new Set((optimized.inventory?.entries ?? []).filter((e) => e.nameSource === "AUTHORED").map((e) => e.nodeName));
  const lostMeshNames = [...new Set(rawAuthored.filter((n) => !optAuthored.has(n)))];
  if (lostMeshNames.length > 0) {
    problems.push(
      problem("MESH_NAME_LOST", "warning", "inventory", `${lostMeshNames.length} authored name(s) no longer present: ${lostMeshNames.slice(0, 5).join(", ")}`),
    );
  }
  const required = opts.requiredMeshNames ?? [];
  const missingRequiredNames = required.filter((n) => !optAuthored.has(n));
  if (missingRequiredNames.length > 0) {
    problems.push(
      problem("REQUIRED_MESH_MISSING", "error", "inventory", `mapping targets missing after optimization: ${missingRequiredNames.join(", ")}`),
    );
  }

  const rb = bounds(raw);
  const ob = bounds(optimized);
  if (rb && ob) {
    // Compare the union bounds axis by axis: a simplification that rescaled the
    // vehicle would silently break every hotspot position derived from it.
    const axes = [
      { axis: "x", rawMin: rb.min[0], rawMax: rb.max[0], optMin: ob.min[0], optMax: ob.max[0] },
      { axis: "y", rawMin: rb.min[1], rawMax: rb.max[1], optMin: ob.min[1], optMax: ob.max[1] },
      { axis: "z", rawMin: rb.min[2], rawMax: rb.max[2], optMin: ob.min[2], optMax: ob.max[2] },
    ];
    for (const a of axes) {
      const span = Math.max(1e-6, a.rawMax - a.rawMin);
      const dMin = Math.abs(a.optMin - a.rawMin) / span;
      const dMax = Math.abs(a.optMax - a.rawMax) / span;
      if (dMin > tol || dMax > tol) {
        problems.push(
          problem(
            "SCALE_CHANGED",
            "warning",
            "bounds",
            `axis ${a.axis}: raw [${a.rawMin.toFixed(3)}, ${a.rawMax.toFixed(3)}] vs optimized [${a.optMin.toFixed(3)}, ${a.optMax.toFixed(3)}]`,
          ),
        );
      }
    }
  } else if (rb && !ob) {
    problems.push(problem("BOUNDS_UNAVAILABLE", "warning", "bounds", "optimized artifact has no usable bounds"));
  }

  const ok = !problems.some((p) => p.severity === "error");
  return { deltas, lostMeshNames, missingRequiredNames, problems, ok };
}

/** Human table for the validation doc / CLI (no invented values). */
export function formatDeltas(deltas: OptimizationComparison["deltas"]): string[] {
  const rows: string[] = [];
  for (const [key, d] of Object.entries(deltas)) {
    const pct = Number.isFinite(d.ratio) ? `${((d.ratio - 1) * 100).toFixed(1)}%` : "n/a";
    rows.push(`${key}: raw=${d.raw} optimized=${d.optimized} change=${pct}`);
  }
  return rows;
}
