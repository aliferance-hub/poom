// P2-J: the Asset Registry — the only writer of the asset lifecycle.
//
// Design of record: docs/phase2/PHASE2-J-ASSET-VALIDATION.md (+ PHASE2-J-MAPPING-REPORT.md).
//
// Invariants enforced here (not in the UI):
//   * a file is audited before it is stored and re-audited from storage before
//     anything is promoted;
//   * a rejected artifact is never uploaded — untrusted bytes stay out of the
//     customer-facing bucket;
//   * state transitions follow asset-lifecycle#canTransition (PLACEHOLDER is
//     terminal, the pipeline cannot be skipped, PRODUCTION cannot be rejected);
//   * a SYNTHETIC asset can never be promoted (§22/§3.1 NO FAKE GLB);
//   * every state change is written to AssetEventLog (§29 auditability).
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getAssetStorage } from "@/lib/storage";
import { StorageError } from "@/lib/storage/types";
import { auditAsset, summarizeAudit, sha256, type AuditOptions, type StoredAudit } from "@/lib/asset-validation";
import { compareAudits } from "@/lib/asset-validation/compare";
import {
  checkMappingHealth,
  describeAvailability,
  evaluatePromotion,
  summarizeMappingHealth,
  canTransition,
  type AssetState,
  type MappingHealthRow,
  type PromotionGate,
  type RenderVerification,
  type Vehicle3DAvailability,
} from "@/lib/asset-lifecycle";
import type { ProvenanceRecord } from "@/lib/asset-validation/provenance";

// Re-exported so callers (studio actions, UI, CLI) depend on one module.
export type { PromotionGate, RenderVerification, MappingHealthRow, AssetState } from "@/lib/asset-lifecycle";

export type RegistryOk<T> = { ok: true } & T;
export type RegistryFail = { ok: false; error: string; problems?: string[] };
export type RegistryResult<T> = RegistryOk<T> | RegistryFail;

// ─────────────────────────── audit trail ───────────────────────────

export type AssetEventName =
  | "created"
  | "validated"
  | "rejected"
  | "optimized"
  | "staged"
  | "verified"
  | "promoted"
  | "retired"
  | "rolled_back"
  | "mapping_assigned"
  | "mapping_removed"
  | "health_checked";

async function logEvent(input: {
  assetId: string;
  versionId: string | null;
  event: AssetEventName;
  fromState?: AssetState | null;
  toState?: AssetState | null;
  actor: string;
  note?: string | null;
  detail?: unknown;
}): Promise<void> {
  await prisma.assetEventLog.create({
    data: {
      assetId: input.assetId,
      versionId: input.versionId,
      event: input.event,
      fromState: input.fromState ?? null,
      toState: input.toState ?? null,
      actor: input.actor,
      note: input.note ?? null,
      detailJson: input.detail === undefined ? undefined : JSON.parse(JSON.stringify(input.detail)),
    },
  });
}

// ─────────────────────────── helpers ───────────────────────────

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
}

function guessMime(name: string): string {
  return name.toLowerCase().endsWith(".glb") ? "model/gltf-binary" : "application/octet-stream";
}

/** Immutable object key for one artifact of one version (H6 conventions). */
export function artifactKey(assetBusinessId: string, version: number, kind: "raw" | "optimized", fileName: string): string {
  return `uploads/assets/${assetBusinessId}/v${version}/${kind}/${sanitizeName(fileName)}`;
}

function toProvenanceRecord(input: ProvenanceInput & { fileSize: number; sha256: string }): ProvenanceRecord {
  return {
    assetIdentity: input.assetIdentity,
    sourceUrl: input.sourceUrl,
    sourceProvider: input.sourceProvider,
    creator: input.creator ?? null,
    licenseType: input.licenseType,
    licenseUrl: input.licenseUrl ?? null,
    commercialUse: input.commercialUse,
    redistributionAllowed: input.redistributionAllowed,
    modificationAllowed: input.modificationAllowed,
    attributionText: input.attributionText ?? null,
    downloadDate: input.downloadDate,
    originalFilename: input.originalFilename,
    fileSize: input.fileSize,
    sha256: input.sha256,
    intendedUsage: input.intendedUsage,
    modifications: input.modifications ?? null,
    notes: input.notes ?? null,
    variantClaim: input.variantClaim ?? null,
  };
}

/**
 * Provenance is verified against the RAW source artifact — the file that was
 * actually obtained. A derived (optimized) artifact inherits that verdict, and
 * the inheritance is recorded in the optimization report; the raw evidence stays
 * in `rawValidationJson` untouched. Without this the checksum/size fields of the
 * provenance record (which describe the source file) would be re-checked against
 * a different file, which would be a lie in either direction.
 */
function inheritProvenance(target: StoredAudit, source: StoredAudit | null): StoredAudit {
  if (!source?.provenance) return target;
  return { ...target, provenance: source.provenance, rights: source.rights };
}

export function storedAuditOf(json: unknown): StoredAudit | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const candidate = json as Partial<StoredAudit>;
  return typeof candidate.verdict === "string" ? (candidate as StoredAudit) : null;
}

/**
 * Provenance as supplied by an operator/CLI. `fileSize` and `sha256` are NOT
 * part of it on purpose: the registry derives both from the bytes it received,
 * so a record can never claim a checksum the file does not have.
 */
export type ProvenanceInput = Omit<ProvenanceRecord, "fileSize" | "sha256">;

// ─────────────────────────── ingestion (RAW) ───────────────────────────

export type CreateVersionResult =
  | { ok: true; outcome: "RAW"; versionId: string; version: number; audit: StoredAudit }
  | { ok: true; outcome: "REJECTED"; versionId: string; version: number; audit: StoredAudit }
  | RegistryFail;

/**
 * Register a freshly obtained file as a RAW version.
 *
 * The audit runs BEFORE storage: a file that fails validation is recorded as a
 * REJECTED version (with its evidence) but never uploaded — untrusted bytes must
 * not reach the bucket the browser reads from.
 */
export async function createAssetVersion(input: {
  assetId: string;
  fileBuffer: Buffer;
  fileName: string;
  mimeType?: string;
  provenance: ProvenanceInput;
  actor?: string;
}): Promise<CreateVersionResult> {
  const asset = await prisma.asset.findUnique({ where: { assetId: input.assetId } });
  if (!asset) return { ok: false, error: "ASSET_NOT_FOUND" };

  const last = await prisma.assetVersion.findFirst({
    where: { assetId: asset.id },
    orderBy: { version: "desc" },
  });
  const nextVersion = (last?.version ?? 0) + 1;

  const observed = { fileSize: input.fileBuffer.length, sha256: sha256(input.fileBuffer) };
  const provenanceRecord = toProvenanceRecord({ ...input.provenance, ...observed });
  const audit = auditAsset(input.fileBuffer, { provenance: provenanceRecord, limitProfile: "raw-ingestion" });
  const stored = summarizeAudit(audit);
  const problems = stored.problems.filter((p) => p.severity === "error").map((p) => p.code);
  const actor = input.actor ?? "registry:create";
  const mimeType = input.mimeType ?? guessMime(input.fileName);

  const baseData = {
    assetId: asset.id,
    version: nextVersion,
    mimeType,
    licenseType: provenanceRecord.licenseType,
    licenseUrl: provenanceRecord.licenseUrl,
    sourceUrl: provenanceRecord.sourceUrl,
    sourceProvider: provenanceRecord.sourceProvider,
    creator: provenanceRecord.creator,
    attributionText: provenanceRecord.attributionText,
    commercialUse: provenanceRecord.commercialUse === "YES",
    redistributionAllowed: provenanceRecord.redistributionAllowed === "YES",
    modificationAllowed: provenanceRecord.modificationAllowed === "YES",
    acquiredAt: new Date(provenanceRecord.downloadDate),
    modifications: provenanceRecord.modifications,
    intendedUsage: provenanceRecord.intendedUsage,
    provenanceJson: JSON.parse(JSON.stringify(provenanceRecord)),
    metadataJson: JSON.parse(JSON.stringify({
      originalFilename: provenanceRecord.originalFilename,
      downloadDate: provenanceRecord.downloadDate,
      notes: provenanceRecord.notes,
      variantClaim: provenanceRecord.variantClaim,
      metadataUrls: stored.metadataUrls,
    })),
  };

  if (audit.verdict === "FAIL" || problems.length > 0) {
    const version = await prisma.assetVersion.create({
      data: {
        ...baseData,
        state: "REJECTED",
        filePath: "rejected:never-stored",
        rawValidationJson: JSON.parse(JSON.stringify(stored)),
        rejectionReason: problems.length > 0 ? problems.join(",") : "AUDIT_FAILED",
      },
    });
    await logEvent({
      assetId: asset.id,
      versionId: version.id,
      event: "rejected",
      toState: "REJECTED",
      actor,
      note: `ingestion audit failed (${problems.slice(0, 4).join(", ") || "AUDIT_FAILED"})`,
      detail: { problems, sha256: stored.sha256, byteLength: stored.byteLength },
    });
    return { ok: true, outcome: "REJECTED", versionId: version.id, version: nextVersion, audit: stored };
  }

  const key = artifactKey(input.assetId, nextVersion, "raw", input.fileName);
  const storage = getAssetStorage();
  try {
    await storage.upload(key, input.fileBuffer, { contentType: mimeType });
  } catch (e) {
    if (e instanceof StorageError && e.code === "OBJECT_EXISTS") {
      return { ok: false, error: "OBJECT_EXISTS" };
    }
    return { ok: false, error: e instanceof StorageError ? e.code : "STORAGE_UPLOAD_FAILED" };
  }

  let version;
  try {
    version = await prisma.assetVersion.create({
      data: {
        ...baseData,
        state: "RAW",
        filePath: key,
        fileUrl: storage.getPublicUrl(key),
        fileSize: observed.fileSize,
        checksumSha256: observed.sha256,
        rawFilePath: key,
        rawFileSize: observed.fileSize,
        rawChecksumSha256: observed.sha256,
        rawValidationJson: JSON.parse(JSON.stringify(stored)),
      },
    });
  } catch (e) {
    // Compensating delete: never leave an object with no row (H8 pattern).
    await storage.delete(key).catch(() => {});
    throw e;
  }

  await logEvent({
    assetId: asset.id,
    versionId: version.id,
    event: "created",
    toState: "RAW",
    actor,
    note: `raw artifact stored (${observed.fileSize} bytes)`,
    detail: {
      sha256: observed.sha256,
      objectKey: key,
      sourceUrl: provenanceRecord.sourceUrl,
      sourceProvider: provenanceRecord.sourceProvider,
      licenseType: provenanceRecord.licenseType,
      provenanceVerdict: stored.provenance,
      inventoryHash: stored.inventoryHash,
    },
  });

  return { ok: true, outcome: "RAW", versionId: version.id, version: nextVersion, audit: stored };
}

// ─────────────────────────── stored-artifact integrity ───────────────────────────

type VersionRow = Awaited<ReturnType<typeof loadVersion>>;

async function loadVersion(versionId: string) {
  return prisma.assetVersion.findUnique({ where: { id: versionId }, include: { asset: true } });
}

/**
 * Re-read the artifact from storage and audit it. This is the check that makes
 * "the file on disk is what the registry says it is" a fact instead of a promise.
 */
async function auditStoredArtifact(
  version: NonNullable<VersionRow>,
  opts: { provenance?: ProvenanceRecord | null; profile: AuditOptions["limitProfile"] },
): Promise<RegistryResult<{ audit: StoredAudit; bytes: Buffer }>> {
  const key = version.filePath;
  if (!key || key.startsWith("builtin:")) return { ok: false, error: "NO_STORED_ARTIFACT" };
  let bytes: Uint8Array;
  try {
    bytes = await getAssetStorage().download(key);
  } catch (e) {
    return { ok: false, error: e instanceof StorageError ? e.code : "STORAGE_DOWNLOAD_FAILED" };
  }
  const buffer = Buffer.from(bytes);
  const audit = summarizeAudit(auditAsset(buffer, { provenance: opts.provenance ?? null, limitProfile: opts.profile }));
  if (version.checksumSha256 && audit.sha256 !== version.checksumSha256) {
    return { ok: false, error: "STORED_CHECKSUM_MISMATCH", problems: [`expected=${version.checksumSha256}`, `observed=${audit.sha256}`] };
  }
  return { ok: true, audit, bytes: buffer };
}

// ─────────────────────────── pipeline steps ───────────────────────────

async function transition(
  version: NonNullable<VersionRow>,
  to: AssetState,
  data: Record<string, unknown>,
  event: AssetEventName,
  actor: string,
  note: string,
  detail?: unknown,
): Promise<RegistryResult<{ id: string }>> {
  const check = canTransition(version.state as AssetState, to);
  if (!check.ok) return { ok: false, error: check.reason ?? "TRANSITION_NOT_ALLOWED" };
  const updated = await prisma.assetVersion.update({
    where: { id: version.id },
    data: { state: to, ...data },
  });
  await logEvent({
    assetId: version.assetId,
    versionId: version.id,
    event,
    fromState: version.state as AssetState,
    toState: to,
    actor,
    note,
    detail,
  });
  return { ok: true, id: updated.id };
}

/** RAW → VALIDATED (or REJECTED when the stored bytes fail the audit). */
export async function validateVersion(
  versionId: string,
  opts: { actor?: string } = {},
): Promise<RegistryResult<{ state: AssetState; problems: string[] }>> {
  const version = await loadVersion(versionId);
  if (!version) return { ok: false, error: "VERSION_NOT_FOUND" };
  const actor = opts.actor ?? "registry:validate";

  const provenance = (version.provenanceJson as unknown as ProvenanceRecord | null) ?? null;
  const audit = await auditStoredArtifact(version, { provenance, profile: "raw-ingestion" });
  if (!audit.ok) {
    await logEvent({
      assetId: version.assetId, versionId, event: "rejected", fromState: version.state as AssetState,
      toState: "REJECTED", actor, note: `stored artifact unusable: ${audit.error}`,
    });
    await prisma.assetVersion.update({ where: { id: versionId }, data: { state: "REJECTED", rejectionReason: audit.error } });
    return { ok: false, error: audit.error, problems: audit.problems };
  }

  const problems = audit.audit.problems.filter((p) => p.severity === "error").map((p) => `${p.code}${p.where ? `:${p.where}` : ""}`);
  if (audit.audit.verdict === "FAIL" || problems.length > 0) {
    await prisma.assetVersion.update({
      where: { id: versionId },
      data: {
        state: "REJECTED",
        rawValidationJson: JSON.parse(JSON.stringify(audit.audit)),
        rejectionReason: problems.slice(0, 8).join(",") || "AUDIT_FAILED",
      },
    });
    await logEvent({
      assetId: version.assetId, versionId, event: "rejected", fromState: version.state as AssetState,
      toState: "REJECTED", actor, note: "validation failed", detail: { problems },
    });
    return { ok: false, error: "AUDIT_FAILED", problems };
  }

  const moved = await transition(
    version, "VALIDATED",
    {
      validatedAt: new Date(),
      rawValidationJson: JSON.parse(JSON.stringify(audit.audit)),
      validationJson: JSON.parse(JSON.stringify(audit.audit)),
      rawFilePath: version.rawFilePath ?? version.filePath,
      rawFileSize: version.rawFileSize ?? version.fileSize,
      rawChecksumSha256: version.rawChecksumSha256 ?? version.checksumSha256,
    },
    "validated", actor, `structural+security+provenance audit PASS (${audit.audit.sha256.slice(0, 16)}…)`,
    { inventoryHash: audit.audit.inventoryHash, counts: audit.audit.counts, provenance: audit.audit.provenance },
  );
  if (!moved.ok) return moved;
  return { ok: true, state: "VALIDATED", problems: [] };
}

/**
 * VALIDATED → OPTIMIZED. The optimized bytes are audited (production-delivery
 * profile) and compared with the raw artifact before they replace it as the
 * viewer artifact. `requiredMeshNames` protects existing mapping targets (§12).
 */
export async function optimizeVersion(
  versionId: string,
  input: {
    optimizedBuffer: Buffer;
    fileName: string;
    optimizer: { tool: string; settings: Record<string, unknown> };
    requiredMeshNames?: string[];
    actor?: string;
  },
): Promise<RegistryResult<{ state: AssetState; deltas: unknown; warnings: string[] }>> {
  const version = await loadVersion(versionId);
  if (!version) return { ok: false, error: "VERSION_NOT_FOUND" };
  const actor = input.actor ?? "registry:optimize";

  const rawAudit = storedAuditOf(version.rawValidationJson) ?? storedAuditOf(version.validationJson);
  if (!rawAudit) return { ok: false, error: "RAW_EVIDENCE_MISSING" };

  const optimizedEvidence = inheritProvenance(
    summarizeAudit(auditAsset(input.optimizedBuffer, { limitProfile: "production-delivery" })),
    rawAudit,
  );
  if (optimizedEvidence.verdict === "FAIL") {
    return { ok: false, error: "OPTIMIZED_AUDIT_FAILED", problems: optimizedEvidence.problems.filter((p) => p.severity === "error").map((p) => p.code) };
  }

  // Re-audit the raw bytes for a like-for-like comparison (raw profile measures,
  // production profile only adds delivery warnings).
  const rawBytesResult = await auditStoredArtifact(version, { profile: "raw-ingestion" });
  if (!rawBytesResult.ok) return rawBytesResult;
  const comparison = compareAudits(
    auditAsset(rawBytesResult.bytes, { limitProfile: "raw-ingestion" }),
    auditAsset(input.optimizedBuffer, { limitProfile: "raw-ingestion" }),
    { requiredMeshNames: input.requiredMeshNames ?? [] },
  );
  if (!comparison.ok) {
    return {
      ok: false,
      error: "OPTIMIZATION_QUALITY_GATE_FAILED",
      problems: comparison.problems.filter((p) => p.severity === "error").map((p) => p.code),
    };
  }

  const key = artifactKey(version.asset.assetId, version.version, "optimized", input.fileName);
  const storage = getAssetStorage();
  try {
    await storage.upload(key, input.optimizedBuffer, { contentType: guessMime(input.fileName) });
  } catch (e) {
    return { ok: false, error: e instanceof StorageError ? e.code : "STORAGE_UPLOAD_FAILED" };
  }

  const optimization = {
    ...comparison,
    optimizer: input.optimizer,
    requiredMeshNames: input.requiredMeshNames ?? [],
    optimizedObjectKey: key,
    measuredAt: new Date().toISOString(),
    provenanceInheritedFrom: "RAW",
  };

  const moved = await transition(
    version, "OPTIMIZED",
    {
      optimizedAt: new Date(),
      filePath: key,
      fileUrl: storage.getPublicUrl(key),
      fileSize: input.optimizedBuffer.length,
      checksumSha256: sha256(input.optimizedBuffer),
      mimeType: guessMime(input.fileName),
      validationJson: JSON.parse(JSON.stringify(optimizedEvidence)),
      optimizationJson: JSON.parse(JSON.stringify(optimization)),
    },
    "optimized", actor,
    `optimized artifact stored (${input.optimizedBuffer.length} bytes) and compared with raw`,
    { deltas: comparison.deltas, warnings: comparison.problems.filter((p) => p.severity === "warning").map((p) => p.code), objectKey: key },
  );
  if (!moved.ok) return moved;
  return {
    ok: true,
    state: "OPTIMIZED",
    deltas: comparison.deltas,
    warnings: comparison.problems.filter((p) => p.severity === "warning").map((p) => p.code),
  };
}

/** Per-mapping health, computed against the version's stored inventory (§27). */
export async function mappingHealthRows(versionId: string): Promise<MappingHealthRow[]> {
  const version = await prisma.assetVersion.findUnique({
    where: { id: versionId },
    include: {
      asset: { select: { vehicleId: true } },
      meshMappings: { include: { zone: { select: { vehicleId: true } }, assembly: { select: { zone: { select: { vehicleId: true } } } } } },
    },
  });
  if (!version) return [];
  const audit = storedAuditOf(version.validationJson);
  const entries = audit?.inventory?.entries ?? null;
  return version.meshMappings.map((m) => {
    const health = checkMappingHealth({
      mapping: {
        id: m.id,
        meshName: m.meshName,
        kind: m.kind,
        meshFingerprint: m.meshFingerprint,
        zoneId: m.zoneId,
        assemblyId: m.assemblyId,
        partId: m.partId,
        targetVehicleId: m.zone?.vehicleId ?? m.assembly?.zone?.vehicleId ?? null,
      },
      assetVehicleId: version.asset.vehicleId ?? null,
      entries,
    });
    return { mappingId: m.id, meshName: m.meshName, kind: m.kind, status: health.status, detail: health.detail };
  });
}

/** Cache the health result on the mapping rows (studio + reports read the cache). */
export async function refreshMappingHealth(
  versionId: string,
  opts: { actor?: string } = {},
): Promise<RegistryResult<{ rows: MappingHealthRow[] }>> {
  const version = await loadVersion(versionId);
  if (!version) return { ok: false, error: "VERSION_NOT_FOUND" };
  const rows = await mappingHealthRows(versionId);
  const now = new Date();
  for (const row of rows) {
    await prisma.meshMapping.update({
      where: { id: row.mappingId },
      data: { mappingHealth: row.status, healthCheckedAt: now },
    });
  }
  await logEvent({
    assetId: version.assetId, versionId, event: "health_checked", fromState: version.state as AssetState,
    toState: version.state as AssetState, actor: opts.actor ?? "registry:health",
    note: `mapping health: ${rows.length} mapping(s)`,
    detail: { rows },
  });
  return { ok: true, rows };
}

/** OPTIMIZED → STAGED: mappings must not be broken before anything is rendered. */
export async function stageVersion(
  versionId: string,
  opts: { actor?: string } = {},
): Promise<RegistryResult<{ state: AssetState; mapping: ReturnType<typeof summarizeMappingHealth> }>> {
  const version = await loadVersion(versionId);
  if (!version) return { ok: false, error: "VERSION_NOT_FOUND" };
  const rows = await mappingHealthRows(versionId);
  const summary = summarizeMappingHealth(rows);
  if (summary.invalid > 0) {
    return {
      ok: false,
      error: "MAPPING_INVALID",
      problems: rows.filter((r) => r.status === "MAPPING_INVALID").map((r) => `${r.meshName}:${r.detail ?? ""}`),
    };
  }
  const moved = await transition(
    version, "STAGED", { stagedAt: new Date() }, "staged", opts.actor ?? "registry:stage",
    `staged for preview verification (${summary.total} mapping(s), ${summary.needsReview} needing review)`,
    { mapping: summary },
  );
  if (!moved.ok) return moved;
  // Cache the health result on the mapping rows so the studio/reports read one
  // consistent answer (the computation itself is read-only above).
  await refreshMappingHealth(versionId, { actor: opts.actor ?? "registry:stage" });
  return { ok: true, state: "STAGED", mapping: summary };
}

/** STAGED → VERIFIED: record real R3F rendering evidence (J11/J13/J34). */
export async function recordRenderVerification(
  versionId: string,
  verification: RenderVerification,
  opts: { actor?: string } = {},
): Promise<RegistryResult<{ state: AssetState }>> {
  const version = await loadVersion(versionId);
  if (!version) return { ok: false, error: "VERSION_NOT_FOUND" };
  const existing = (version.metadataJson as Record<string, unknown> | null) ?? {};
  const moved = await transition(
    version, "VERIFIED",
    {
      verifiedAt: new Date(),
      verifiedBy: verification.by,
      metadataJson: JSON.parse(JSON.stringify({ ...existing, renderVerification: verification })),
    },
    "verified", verification.by,
    `render verification (${verification.source}, ${verification.viewports.join("/")})`,
    verification,
  );
  if (!moved.ok) return moved;
  await logEvent({
    assetId: version.assetId, versionId, event: "verified", toState: "VERIFIED", actor: opts.actor ?? verification.by,
    note: "verification recorded", detail: { source: verification.source, url: verification.url },
  });
  return { ok: true, state: "VERIFIED" };
}

// ─────────────────────────── promotion / rollback ───────────────────────────

async function buildPromotionInput(versionId: string, mode: "promotion" | "rollback") {
  const version = await loadVersion(versionId);
  if (!version) return null;
  const validation = storedAuditOf(version.validationJson);
  const rawValidation = storedAuditOf(version.rawValidationJson);
  const rows = await mappingHealthRows(versionId);
  const mapping = summarizeMappingHealth(rows);
  const metadata = (version.metadataJson as Record<string, unknown> | null) ?? {};
  const renderVerification = (metadata.renderVerification as RenderVerification | undefined) ?? null;
  const previousProduction = await prisma.assetVersion.findFirst({
    where: { assetId: version.assetId, state: "PRODUCTION", id: { not: version.id } },
    select: { id: true, version: true, filePath: true },
  });

  const input = {
    assetKind: version.asset.kind as "SYNTHETIC" | "REAL",
    state: version.state as AssetState,
    validation,
    rawValidation,
    rights: {
      commercialUse: version.commercialUse,
      redistribution: version.redistributionAllowed === true,
      modification: version.modificationAllowed === true,
    },
    attribution: {
      text: version.attributionText,
      required: validation?.rights?.attributionRequired ?? false,
    },
    mapping,
    renderVerification,
    timestamps: {
      validatedAt: version.validatedAt,
      optimizedAt: version.optimizedAt,
      stagedAt: version.stagedAt,
      verifiedAt: version.verifiedAt,
    },
    previousProduction: {
      exists: previousProduction !== null,
      hasImmutableObject: Boolean(previousProduction?.filePath && !previousProduction.filePath.startsWith("builtin:")),
    },
  };
  return { version, input, previousProduction, mapping, mode };
}

function promotionViolations(input: Awaited<ReturnType<typeof buildPromotionInput>>, mode: "promotion" | "rollback"): PromotionGate[] {
  if (!input) return [];
  const evaluation = evaluatePromotion(input.input);
  if (mode === "promotion") return evaluation.gates;
  // Rollback re-uses the same evidence but does not re-run the preview step: the
  // target was already production once (verifiedAt proves the verification ran).
  return evaluation.gates.filter((g) => g.id !== "RENDER_VERIFICATION" && g.id !== "PIPELINE_ORDER" && g.id !== "RAW_EVIDENCE");
}

/**
 * VERIFIED → PRODUCTION. Every gate is evaluated from stored evidence; a failing
 * gate returns the reasons instead of promoting (§28: no bypass).
 */
export async function promoteVersion(
  versionId: string,
  opts: { actor: string; note?: string },
): Promise<RegistryResult<{ gates: PromotionGate[]; retiredPrevious: number | null }>> {
  const built = await buildPromotionInput(versionId, "promotion");
  if (!built) return { ok: false, error: "VERSION_NOT_FOUND" };
  const { version, previousProduction } = built;

  if (version.state !== "VERIFIED") {
    return { ok: false, error: `BAD_STATE:${version.state} (promotion requires VERIFIED)` };
  }
  // Re-verify the stored artifact right before promotion: the served bytes must
  // be exactly the audited bytes.
  const integrity = await auditStoredArtifact(version, { profile: "production-delivery" });
  if (!integrity.ok) return { ok: false, error: integrity.error, problems: integrity.problems };
  const evidence = inheritProvenance(integrity.audit, storedAuditOf(version.rawValidationJson) ?? storedAuditOf(version.validationJson));

  const gates = promotionViolations(built, "promotion");
  const blockers = gates.filter((g) => !g.pass).map((g) => g.id);
  if (blockers.length > 0) {
    await logEvent({
      assetId: version.assetId, versionId, event: "rejected", fromState: version.state as AssetState,
      toState: version.state as AssetState, actor: opts.actor,
      note: `promotion refused: ${blockers.join(", ")}`, detail: { gates },
    });
    return { ok: false, error: "PROMOTION_GATES_FAILED", problems: blockers };
  }

  const result = await prisma.$transaction(async (tx) => {
    let retired: number | null = null;
    if (previousProduction) {
      await tx.assetVersion.update({
        where: { id: previousProduction.id },
        data: { state: "RETIRED", activatedAt: null },
      });
      retired = previousProduction.version;
    }
    await tx.assetVersion.update({
      where: { id: version.id },
      data: {
        state: "PRODUCTION",
        activatedAt: new Date(),
        promotedAt: new Date(),
        promotionNote: opts.note ?? null,
        validationJson: JSON.parse(JSON.stringify(evidence)),
      },
    });
    return retired;
  });

  await logEvent({
    assetId: version.assetId, versionId, event: "promoted", fromState: "VERIFIED", toState: "PRODUCTION",
    actor: opts.actor, note: opts.note ?? "promoted to production",
    detail: { gates, retiredPreviousVersion: result, sha256: evidence.sha256, mapping: built.mapping },
  });
  if (previousProduction && result !== null) {
    await logEvent({
      assetId: version.assetId, versionId: previousProduction.id, event: "retired",
      fromState: "PRODUCTION", toState: "RETIRED", actor: opts.actor,
      note: `superseded by v${version.version} (kept for rollback)`,
    });
  }
  return { ok: true, gates, retiredPrevious: result };
}

/** RETIRED → PRODUCTION (rollback): evidence is reused, the swap is audited (§29). */
export async function rollbackToVersion(
  versionId: string,
  opts: { actor: string; reason: string },
): Promise<RegistryResult<{ gates: PromotionGate[]; retiredPrevious: number | null }>> {
  const built = await buildPromotionInput(versionId, "rollback");
  if (!built) return { ok: false, error: "VERSION_NOT_FOUND" };
  const { version, previousProduction } = built;
  if (version.state !== "RETIRED") return { ok: false, error: `BAD_STATE:${version.state} (rollback requires RETIRED)` };
  if (!version.promotedAt) return { ok: false, error: "NEVER_PROMOTED: a version that was never production cannot be rolled back to" };

  const integrity = await auditStoredArtifact(version, { profile: "production-delivery" });
  if (!integrity.ok) return { ok: false, error: integrity.error, problems: integrity.problems };

  const gates = promotionViolations(built, "rollback");
  const blockers = gates.filter((g) => !g.pass).map((g) => g.id);
  if (blockers.length > 0) return { ok: false, error: "ROLLBACK_GATES_FAILED", problems: blockers };

  const retired = await prisma.$transaction(async (tx) => {
    let retiredVersion: number | null = null;
    if (previousProduction) {
      await tx.assetVersion.update({ where: { id: previousProduction.id }, data: { state: "RETIRED", activatedAt: null } });
      retiredVersion = previousProduction.version;
    }
    await tx.assetVersion.update({
      where: { id: version.id },
      data: { state: "PRODUCTION", activatedAt: new Date(), promotedAt: new Date(), promotionNote: `rollback: ${opts.reason}` },
    });
    return retiredVersion;
  });

  await logEvent({
    assetId: version.assetId, versionId, event: "rolled_back", fromState: "RETIRED", toState: "PRODUCTION",
    actor: opts.actor, note: opts.reason, detail: { gates, retiredPreviousVersion: retired, sha256: integrity.audit.sha256 },
  });
  return { ok: true, gates, retiredPrevious: retired };
}

export async function retireVersion(
  versionId: string,
  opts: { actor: string; reason: string },
): Promise<RegistryResult<{ state: AssetState }>> {
  const version = await loadVersion(versionId);
  if (!version) return { ok: false, error: "VERSION_NOT_FOUND" };
  const moved = await transition(version, "RETIRED", { activatedAt: null }, "retired", opts.actor, opts.reason);
  if (!moved.ok) return moved;
  return { ok: true, state: "RETIRED" };
}

export async function rejectVersion(
  versionId: string,
  opts: { actor: string; reason: string },
): Promise<RegistryResult<{ state: AssetState }>> {
  const version = await loadVersion(versionId);
  if (!version) return { ok: false, error: "VERSION_NOT_FOUND" };
  const moved = await transition(
    version, "REJECTED", { rejectionReason: opts.reason }, "rejected", opts.actor, opts.reason,
  );
  if (!moved.ok) return moved;
  return { ok: true, state: "REJECTED" };
}

export async function getProductionVersion(assetId: string) {
  return prisma.assetVersion.findFirst({
    where: { asset: { assetId }, state: "PRODUCTION" },
    orderBy: { promotedAt: "desc" },
  });
}

// ─────────────────────────── Contract resolver v3 ───────────────────────────

export type MappingHealthLabel = MappingHealthRow["status"];

export type AssetContractV2 = {
  assetId: string;
  assetKind: "SYNTHETIC" | "REAL";
  vehicleId: string | null;
  versionId: string;
  versionNumber: number;
  state: AssetState;
  format: string;
  source: string;
  /** URL for the active version's file; null = builtin placeholder geometry. */
  fileUrl: string | null;
  checksumSha256: string | null;
  license: {
    licenseType: string | null;
    commercialUse: boolean;
    attributionText: string | null;
  };
  /** J25: what a customer surface is allowed to claim. */
  availability: Vehicle3DAvailability;
  camera: { position: [number, number, number]; target: [number, number, number] };
  zones: {
    meshName: string;
    zoneKey: string;
    label: string | null;
    camera: { position: [number, number, number]; target: [number, number, number] };
    assemblyAsset: string | null;
    hotspot: [number, number, number] | null;
    health: MappingHealthLabel;
    /** True only when the mapping is trustworthy for a customer claim. */
    trusted: boolean;
  }[];
  parts: {
    meshName: string;
    partId: string;
    partSlug: string | null;
    label: string | null;
    hotspot: [number, number, number] | null;
    health: MappingHealthLabel;
    trusted: boolean;
  }[];
};

function vec3(v: unknown): [number, number, number] | null {
  return Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === "number")
    ? [v[0] as number, v[1] as number, v[2] as number]
    : null;
}

/**
 * P2-H (H5)/P2-J: browser URL derived through the storage adapter. If the object
 * is not in storage (legacy tracked file not backfilled yet), fall back to the
 * web-root path so the viewer keeps rendering while the backfill is pending.
 */
async function deriveFileUrl(key: string): Promise<string> {
  try {
    const storage = getAssetStorage();
    if (await storage.exists(key)) return storage.getPublicUrl(key);
  } catch {
    // storage unconfigured/unreachable → static fallback below
  }
  return `/${key}`;
}

async function buildContract(versionId: string): Promise<AssetContractV2 | null> {
  const version = await prisma.assetVersion.findUnique({
    where: { id: versionId },
    include: { asset: true },
  });
  if (!version) return null;

  const mappings = await prisma.meshMapping.findMany({
    where: { versionId: version.id },
    include: {
      zone: {
        select: {
          key: true,
          vehicleId: true,
          assemblies: { select: { slug: true }, orderBy: { title: "asc" }, take: 1 },
        },
      },
      assembly: { select: { slug: true } },
      part: { select: { slug: true } },
    },
    orderBy: [{ kind: "asc" }, { sortOrder: "asc" }],
  });

  const audit = storedAuditOf(version.validationJson);
  const entries = audit?.inventory?.entries ?? null;
  const healthById = new Map<string, { status: MappingHealthRow["status"]; detail: string }>();
  for (const m of mappings) {
    healthById.set(
      m.id,
      checkMappingHealth({
        mapping: {
          id: m.id,
          meshName: m.meshName,
          kind: m.kind,
          meshFingerprint: m.meshFingerprint,
          zoneId: m.zoneId,
          assemblyId: m.assemblyId,
          partId: m.partId,
          targetVehicleId: m.zone?.vehicleId ?? null,
        },
        assetVehicleId: version.asset.vehicleId ?? null,
        entries,
      }),
    );
  }

  const zones = mappings
    .filter((m) => m.kind === "zone" && m.zone)
    .map((m) => {
      const health = healthById.get(m.id)?.status ?? "MAPPING_NEEDS_REVIEW";
      return {
        meshName: m.meshName,
        zoneKey: m.zone!.key,
        label: m.label,
        camera: {
          position: vec3(m.cameraPositionJson) ?? [6.5, 3.2, 7.5],
          target: vec3(m.cameraTargetJson) ?? [0, 0.7, 0],
        },
        assemblyAsset: m.assembly?.slug ?? m.assemblyId ?? m.zone?.assemblies[0]?.slug ?? null,
        hotspot: vec3(m.hotspotJson),
        health,
        trusted: health !== "MAPPING_INVALID",
      } as AssetContractV2["zones"][number];
    });

  const parts = mappings
    .filter((m) => m.kind === "part" && m.part)
    .map((m) => {
      const health = healthById.get(m.id)?.status ?? "MAPPING_NEEDS_REVIEW";
      return {
        meshName: m.meshName,
        partId: m.partId!,
        partSlug: m.part?.slug ?? null,
        label: m.label,
        hotspot: vec3(m.hotspotJson),
        health,
        trusted: health === "MAPPING_VALID",
      } as AssetContractV2["parts"][number];
    });

  const availability = describeAvailability({
    assetKind: version.asset.kind as "SYNTHETIC" | "REAL",
    assetId: version.asset.assetId,
    versionNumber: version.version,
    state: version.state as AssetState,
    zoneMappings: zones.map((z) => ({ meshName: z.meshName, status: z.health, detail: healthById.get(mappingIdOf(z.meshName))?.detail })),
    partMappings: parts.map((p) => ({ meshName: p.meshName, partId: p.partId, status: p.health, detail: healthById.get(mappingIdOf(p.meshName))?.detail })),
  });

  function mappingIdOf(meshName: string): string {
    return mappings.find((m) => m.meshName === meshName)?.id ?? "";
  }

  const camWithCam = zones.find(
    (z) => JSON.stringify(z.camera.position) !== JSON.stringify([6.5, 3.2, 7.5]),
  );

  return {
    assetId: version.asset.assetId,
    assetKind: version.asset.kind as "SYNTHETIC" | "REAL",
    vehicleId: version.asset.vehicleId,
    versionId: version.id,
    versionNumber: version.version,
    state: version.state as AssetState,
    format: version.asset.format,
    source: version.asset.source,
    fileUrl: version.filePath && !version.filePath.startsWith("builtin:") && !version.filePath.startsWith("rejected:")
      ? await deriveFileUrl(version.filePath)
      : null,
    checksumSha256: version.checksumSha256 ?? null,
    license: {
      licenseType: version.licenseType,
      commercialUse: version.commercialUse,
      attributionText: version.attributionText,
    },
    availability,
    camera: { position: camWithCam?.camera.position ?? [6.5, 3.2, 7.5], target: [0, 0.8, 0] },
    zones,
    parts,
  };
}

/**
 * Customer-facing resolution (J22/J25): a REAL asset in PRODUCTION when one
 * exists, otherwise the latest PLACEHOLDER version — clearly marked as such.
 */
export async function resolveContract(vehicleId: string): Promise<AssetContractV2 | null> {
  const assets = await prisma.asset.findMany({ where: { vehicleId } });
  if (assets.length === 0) return null;

  const production = await prisma.assetVersion.findFirst({
    where: { assetId: { in: assets.map((a) => a.id) }, state: "PRODUCTION" },
    orderBy: { promotedAt: "desc" },
    select: { id: true },
  });
  if (production) return buildContract(production.id);

  const placeholder = await prisma.assetVersion.findFirst({
    where: { assetId: { in: assets.map((a) => a.id) }, state: "PLACEHOLDER" },
    orderBy: { version: "desc" },
    select: { id: true },
  });
  return placeholder ? buildContract(placeholder.id) : null;
}

/** Admin/studio resolution: any version, regardless of state (J12/J34). */
export async function resolveVersionContract(versionId: string): Promise<AssetContractV2 | null> {
  return buildContract(versionId);
}
