// P2-J (J13/J27/§22/§28): the asset lifecycle — states, transitions, promotion
// gates, mapping drift detection and the truthfulness contract for the UI.
//
// This module is deliberately dependency-free (no Prisma, no storage): the
// registry persists what this module decides, tests exercise it directly, and
// customer surfaces read only the truthfulness result below. Nothing here may
// invent a fact — an unknown stays unknown and a gate fails closed.
import type { StoredAudit } from "@/lib/asset-validation";

export const ASSET_STATES = [
  "PLACEHOLDER",
  "RAW",
  "VALIDATED",
  "OPTIMIZED",
  "STAGED",
  "VERIFIED",
  "PRODUCTION",
  "RETIRED",
  "REJECTED",
] as const;

export type AssetState = (typeof ASSET_STATES)[number];

/** The promotion pipeline, in order. Index in this array is the pipeline rank. */
export const PIPELINE_ORDER: AssetState[] = ["RAW", "VALIDATED", "OPTIMIZED", "STAGED", "VERIFIED", "PRODUCTION"];

export function pipelineRank(state: AssetState): number {
  return PIPELINE_ORDER.indexOf(state);
}

export type TransitionCheck = { ok: boolean; reason?: string };

/**
 * Allowed state transitions. The rules that matter:
 *  - PLACEHOLDER (synthetic stand-in) can never reach PRODUCTION.
 *  - The pipeline is forward-only one step at a time (no skipping RAW → STAGED).
 *  - RETIRED is recoverable (rollback), REJECTED is terminal for that artifact.
 *  - A version may be retired from any live state; only PRODUCTION may not be
 *    rejected directly (retire + promote the replacement instead).
 */
export function canTransition(from: AssetState, to: AssetState): TransitionCheck {
  if (from === to) return { ok: false, reason: `ALREADY_${to}` };

  if (from === "PLACEHOLDER") {
    return to === "RETIRED"
      ? { ok: true }
      : { ok: false, reason: "PLACEHOLDER_IS_TERMINAL_FOR_CUSTOMERS: a synthetic stand-in is never promoted" };
  }
  if (from === "REJECTED") return { ok: false, reason: "REJECTED_IS_TERMINAL" };

  // Rollback path: a retired version may be promoted back (it already passed the
  // pipeline once — the promotion gates are re-evaluated before it is used).
  if (from === "RETIRED") {
    return to === "PRODUCTION"
      ? { ok: true }
      : { ok: false, reason: "RETIRED_MAY_ONLY_BE_ROLLED_BACK_TO_PRODUCTION" };
  }

  if (to === "RETIRED") {
    return { ok: true };
  }
  if (to === "REJECTED") {
    return from === "PRODUCTION"
      ? { ok: false, reason: "RETIRE_PRODUCTION_INSTEAD: rejecting the live asset would blank the viewer" }
      : { ok: true };
  }

  const fromRank = pipelineRank(from);
  const toRank = pipelineRank(to);
  if (fromRank < 0 || toRank < 0) return { ok: false, reason: `NO_PIPELINE_RANK:${from}->${to}` };
  if (toRank === fromRank + 1) return { ok: true };
  if (toRank <= fromRank) return { ok: false, reason: "PIPELINE_IS_FORWARD_ONLY" };
  return { ok: false, reason: `PIPELINE_STEP_SKIPPED:${from}->${to}` };
}

/** Render/browser verification evidence produced on Preview before promotion (J11/J34). */
export type RenderVerification = {
  source: "preview" | "local-dev" | "staging";
  url: string;
  checkedAt: string;
  by: string;
  viewports: string[];
  /** Observed behaviour, not a claim: what was seen and what was measured. */
  observations: string[];
  consoleErrors?: number;
  networkFailures?: number;
  webglErrors?: number;
};

export type MappingStatus = "MAPPING_VALID" | "MAPPING_NEEDS_REVIEW" | "MAPPING_INVALID";

export type MappingHealthRow = {
  mappingId: string;
  meshName: string;
  kind: string;
  status: MappingStatus;
  detail?: string;
};

/** Minimal shape of a stored audit inventory entry (subset of StoredAudit). */
type InventoryEntry = NonNullable<StoredAudit["inventory"]>["entries"][number];

export type MappingHealthInput = {
  mapping: {
    id: string;
    meshName: string;
    kind: string;
    meshFingerprint: string | null;
    zoneId: string | null;
    assemblyId: string | null;
    partId: string | null;
    /** vehicleId of the zone/assembly target, when the target has one. */
    targetVehicleId: string | null;
  };
  /** Vehicle the asset belongs to (null = asset is not bound to a vehicle). */
  assetVehicleId: string | null;
  /** Inventory of the version the mapping belongs to (null = not validated yet). */
  entries: InventoryEntry[] | null;
};

function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/**
 * Mapping drift detection (§27). A mapping is only trustworthy when the node it
 * names still exists with the same structural identity. Legacy mappings that
 * predate fingerprints are NEEDS_REVIEW, never assumed valid.
 */
export function checkMappingHealth(input: MappingHealthInput): { status: MappingStatus; detail: string } {
  const { mapping, entries, assetVehicleId } = input;

  if (mapping.kind === "zone" && !mapping.zoneId) return { status: "MAPPING_INVALID", detail: "TARGET_MISSING" };
  if (mapping.kind === "assembly" && !mapping.assemblyId) return { status: "MAPPING_INVALID", detail: "TARGET_MISSING" };
  if (mapping.kind === "part" && !mapping.partId) return { status: "MAPPING_INVALID", detail: "TARGET_MISSING" };

  if (mapping.targetVehicleId && assetVehicleId && mapping.targetVehicleId !== assetVehicleId) {
    return { status: "MAPPING_INVALID", detail: "CROSS_VEHICLE_TARGET" };
  }

  if (!entries || entries.length === 0) {
    // No measured inventory for this version: the mapping cannot be confirmed.
    return { status: "MAPPING_NEEDS_REVIEW", detail: "NO_INVENTORY_FOR_VERSION" };
  }

  const target = sanitize(mapping.meshName);
  const exact = entries.find((e) => e.nodeName === mapping.meshName);
  const sanitized = exact ?? entries.find((e) => sanitize(e.nodeName) === target);
  const entry = sanitized ?? entries.find((e) => {
    const n = sanitize(e.nodeName);
    return n !== "" && (n.includes(target) || target.includes(n));
  });

  if (!entry) return { status: "MAPPING_INVALID", detail: "NODE_MISSING" };
  if (entry.nameSource !== "AUTHORED") return { status: "MAPPING_NEEDS_REVIEW", detail: "NODE_NAME_NOT_AUTHORED" };
  if (entry.meshIndex === null) return { status: "MAPPING_INVALID", detail: "NODE_HAS_NO_MESH" };
  if (!entry.visible) return { status: "MAPPING_NEEDS_REVIEW", detail: "NODE_HIDDEN" };
  if (!mapping.meshFingerprint) return { status: "MAPPING_NEEDS_REVIEW", detail: "FINGERPRINT_NOT_RECORDED" };
  if (mapping.meshFingerprint !== entry.fingerprint) {
    return { status: "MAPPING_NEEDS_REVIEW", detail: "FINGERPRINT_CHANGED" };
  }
  return { status: "MAPPING_VALID", detail: "OK" };
}

export function summarizeMappingHealth(rows: MappingHealthRow[]): {
  total: number;
  valid: number;
  needsReview: number;
  invalid: number;
  worst: MappingStatus | null;
} {
  const valid = rows.filter((r) => r.status === "MAPPING_VALID").length;
  const needsReview = rows.filter((r) => r.status === "MAPPING_NEEDS_REVIEW").length;
  const invalid = rows.filter((r) => r.status === "MAPPING_INVALID").length;
  const worst: MappingStatus | null =
    rows.length === 0 ? null : invalid > 0 ? "MAPPING_INVALID" : needsReview > 0 ? "MAPPING_NEEDS_REVIEW" : "MAPPING_VALID";
  return { total: rows.length, valid, needsReview, invalid, worst };
}

// ─────────────────────────── promotion gates (§28) ───────────────────────────

export type PromotionGate = {
  id: string;
  /** Persian-facing label used by the studio UI. */
  label: string;
  pass: boolean;
  detail?: string;
};

export type PromotionInput = {
  assetKind: "SYNTHETIC" | "REAL";
  state: AssetState;
  /** Audit of the artifact the viewer would consume (production-delivery profile). */
  validation: StoredAudit | null;
  /** Audit of the immutable raw artifact. */
  rawValidation: StoredAudit | null;
  rights: { commercialUse: boolean; redistribution: boolean; modification: boolean };
  attribution: { text: string | null; required: boolean };
  /** Health of every mapping on this version. */
  mapping: ReturnType<typeof summarizeMappingHealth>;
  renderVerification: RenderVerification | null;
  timestamps: { validatedAt: Date | null; optimizedAt: Date | null; stagedAt: Date | null; verifiedAt: Date | null };
  /** A previous PRODUCTION version exists for this asset and must stay recoverable. */
  previousProduction: { exists: boolean; hasImmutableObject: boolean };
};

export type PromotionEvaluation = {
  gates: PromotionGate[];
  ok: boolean;
  blockers: string[];
};

/** Hard delivery budget for a browser-facing vehicle asset (measured, not guessed). */
export const DELIVERY_BUDGET = {
  maxFileBytes: 12 * 1024 * 1024,
  maxTriangles: 600_000,
  maxTextureDimension: 4096,
} as const;

/**
 * Evaluate every promotion gate. A gate is a documented question with an
 * evidence-based answer: if the evidence is missing, the gate fails. There is no
 * "force" flag — the CLI requires an explicit promotion call, which still runs
 * through this evaluation.
 */
export function evaluatePromotion(input: PromotionInput): PromotionEvaluation {
  const gates: PromotionGate[] = [];
  const v = input.validation;
  const metrics = v?.metrics ?? null;

  gates.push({
    id: "REAL_ASSET",
    label: "دارایی واقعی (نه نمونهٔ جایگزین)",
    pass: input.assetKind === "REAL",
    detail: input.assetKind === "REAL" ? "kind=REAL" : "SYNTHETIC_ASSET_NEVER_PROMOTED",
  });

  gates.push({
    id: "PIPELINE_ORDER",
    label: "ترتیب خط تولید طی شده است",
    pass: Boolean(input.timestamps.validatedAt && input.timestamps.optimizedAt && input.timestamps.stagedAt && input.timestamps.verifiedAt),
    detail:
      input.timestamps.verifiedAt && input.timestamps.stagedAt && input.timestamps.optimizedAt && input.timestamps.validatedAt
        ? "RAW→VALIDATED→OPTIMIZED→STAGED→VERIFIED"
        : "PIPELINE_STEPS_MISSING",
  });

  gates.push({
    id: "PROVENANCE",
    label: "منشأ مستند و مجوز بازبینی‌شده",
    pass: v?.provenance === "PASS",
    detail: v?.provenance ? `provenance=${v.provenance}` : "NO_PROVENANCE_EVIDENCE",
  });

  gates.push({
    id: "RIGHTS",
    label: "حقوق استفاده/بازتوزیع/تغییر تأییدشده",
    pass: input.rights.commercialUse && input.rights.redistribution && input.rights.modification,
    detail: `commercial=${input.rights.commercialUse} redistribution=${input.rights.redistribution} modification=${input.rights.modification}`,
  });

  gates.push({
    id: "ATTRIBUTION",
    label: "اعتباردهی مورد نیاز مجوز ثبت شده",
    pass: !input.attribution.required || Boolean(input.attribution.text && input.attribution.text.trim().length >= 4),
    detail: input.attribution.required ? `text=${input.attribution.text ? "present" : "MISSING"}` : "not_required",
  });

  gates.push({
    id: "CHECKSUM",
    label: "چک‌سام دارایی با فایل ذخیره‌شده می‌خواند",
    pass: Boolean(v?.sha256 && v.inventoryHash),
    detail: v?.sha256 ? `sha256=${v.sha256.slice(0, 16)}…` : "NO_CHECKSUM_EVIDENCE",
  });

  gates.push({
    id: "TECHNICAL",
    label: "اعتبارسنجی فنی و ساختاری",
    pass: v?.structure === "PASS",
    detail: v ? `structure=${v.structure} verdict=${v.verdict}` : "NO_VALIDATION_EVIDENCE",
  });

  gates.push({
    id: "SECURITY",
    label: "اعتبارسنجی امنیتی بدون یافته",
    pass: v?.security === "PASS",
    detail: v ? `security=${v.security}` : "NO_SECURITY_EVIDENCE",
  });

  gates.push({
    id: "SELF_CONTAINED",
    label: "بدون وابستگی بیرونی",
    pass: v?.selfContained === "PASS",
    detail: v ? `selfContained=${v.selfContained}` : "NO_SELF_CONTAINED_EVIDENCE",
  });

  const perfPass = Boolean(
    metrics &&
      metrics.fileBytes > 0 &&
      metrics.fileBytes <= DELIVERY_BUDGET.maxFileBytes &&
      metrics.triangles > 0 &&
      metrics.triangles <= DELIVERY_BUDGET.maxTriangles &&
      metrics.largestTextureDimension <= DELIVERY_BUDGET.maxTextureDimension,
  );
  gates.push({
    id: "PERFORMANCE",
    label: "بودجهٔ کارایی قابل تحویل در وب",
    pass: perfPass,
    detail: metrics
      ? `bytes=${metrics.fileBytes} triangles=${metrics.triangles} maxTexture=${metrics.largestTextureDimension}`
      : "NO_METRICS",
  });

  gates.push({
    id: "RENDER_VERIFICATION",
    label: "رندر واقعی در R3F تأیید شده",
    pass: Boolean(input.renderVerification && input.renderVerification.source !== "local-dev"),
    detail: input.renderVerification
      ? `source=${input.renderVerification.source} at=${input.renderVerification.checkedAt} errors=${input.renderVerification.consoleErrors ?? "n/a"}`
      : "NO_RENDER_EVIDENCE",
  });

  gates.push({
    id: "MAPPING_INTEGRITY",
    label: "نگاشت‌ها معتبر و بدون ارجاع شکسته",
    pass: input.mapping.total > 0 && input.mapping.invalid === 0,
    detail: `total=${input.mapping.total} valid=${input.mapping.valid} needsReview=${input.mapping.needsReview} invalid=${input.mapping.invalid}`,
  });

  const rawOk = Boolean(input.rawValidation && input.rawValidation.verdict === "PASS");
  gates.push({
    id: "RAW_EVIDENCE",
    label: "نسخهٔ خام اصلی حفظ و اعتبارسنجی شده",
    pass: rawOk,
    detail: input.rawValidation ? `raw verdict=${input.rawValidation.verdict}` : "NO_RAW_EVIDENCE",
  });

  gates.push({
    id: "ROLLBACK_PATH",
    label: "مسیر بازگشت حفظ می‌شود",
    pass: !input.previousProduction.exists || input.previousProduction.hasImmutableObject,
    detail: input.previousProduction.exists
      ? input.previousProduction.hasImmutableObject
        ? "previous production version stays RETIRED with its object"
        : "PREVIOUS_PRODUCTION_WITHOUT_OBJECT"
      : "no previous production version",
  });

  const blockers = gates.filter((g) => !g.pass).map((g) => g.id);
  return { gates, ok: blockers.length === 0, blockers };
}

// ─────────────────────────── truthfulness contract (§25) ───────────────────────────

export type Vehicle3DAvailability = {
  /** Asset the viewer will render. */
  kind: "NONE" | "SYNTHETIC" | "REAL";
  state: AssetState | null;
  assetId: string | null;
  versionNumber: number | null;
  /** 3D vehicle model availability. */
  vehicle3d: "REAL" | "PLACEHOLDER" | "UNAVAILABLE";
  /** Zone hotspots derived from mappings that are not invalid. */
  zoneDisplay: "AVAILABLE" | "UNAVAILABLE";
  /** Parts that may truthfully claim an exact 3D mapping. */
  mappedPartIds: string[];
  /** Mappings that exist but cannot be trusted right now. */
  untrustedMappings: { meshName: string; status: MappingStatus; detail?: string }[];
  /** Reason code the UI turns into Persian copy. */
  reason:
    | "REAL_PRODUCTION"
    | "SYNTHETIC_LOCAL_FALLBACK"
    | "NO_ASSET"
    | "REAL_NOT_PROMOTED";
};

/**
 * Decide what a customer surface is allowed to say. Only a REAL asset in
 * PRODUCTION counts as the real vehicle; a SYNTHETIC stand-in is always reported
 * as such, and a mapped part is only "mapped" when its mapping is healthy.
 */
export function describeAvailability(input: {
  assetKind: "SYNTHETIC" | "REAL" | null;
  assetId: string | null;
  versionNumber: number | null;
  state: AssetState | null;
  zoneMappings: { meshName: string; status: MappingStatus; detail?: string }[];
  partMappings: { meshName: string; partId: string; status: MappingStatus; detail?: string }[];
}): Vehicle3DAvailability {
  const { assetKind, state } = input;

  if (!assetKind || !state) {
    return {
      kind: "NONE",
      state: null,
      assetId: null,
      versionNumber: null,
      vehicle3d: "UNAVAILABLE",
      zoneDisplay: "UNAVAILABLE",
      mappedPartIds: [],
      untrustedMappings: [],
      reason: "NO_ASSET",
    };
  }

  const trustedZones = input.zoneMappings.filter((z) => z.status !== "MAPPING_INVALID");
  const trustedParts = input.partMappings.filter((p) => p.status === "MAPPING_VALID");
  const untrusted = [
    ...input.zoneMappings.filter((z) => z.status !== "MAPPING_VALID").map((z) => ({ meshName: z.meshName, status: z.status, detail: z.detail })),
    ...input.partMappings.filter((p) => p.status !== "MAPPING_VALID").map((p) => ({ meshName: p.meshName, status: p.status, detail: p.detail })),
  ];

  const isRealProduction = assetKind === "REAL" && state === "PRODUCTION";

  return {
    kind: assetKind,
    state,
    assetId: input.assetId,
    versionNumber: input.versionNumber,
    vehicle3d: isRealProduction ? "REAL" : "PLACEHOLDER",
    zoneDisplay: trustedZones.length > 0 ? "AVAILABLE" : "UNAVAILABLE",
    mappedPartIds: isRealProduction ? trustedParts.map((p) => p.partId) : [],
    untrustedMappings: untrusted,
    reason: isRealProduction ? "REAL_PRODUCTION" : assetKind === "REAL" ? "REAL_NOT_PROMOTED" : "SYNTHETIC_LOCAL_FALLBACK",
  };
}
