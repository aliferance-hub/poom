#!/usr/bin/env node
/**
 * P2-J — Peugeot 206 asset pipeline CLI.
 *
 * The ONLY supported way to move a downloaded 3D file through the lifecycle:
 *
 *   inbox                     → what is waiting in .freebuff/asset-inbox/ (with checksums)
 *   ingest <file> --meta <m>  → audit + immutable raw upload + RAW version row
 *   validate <versionId>      → RAW → VALIDATED (re-audits the STORED bytes)
 *   inventory <versionId>     → node/mesh inventory of the validated version
 *   optimize <versionId>      → measured optimization → OPTIMIZED
 *   stage <versionId>         → mapping integrity check → STAGED
 *   verify <versionId> ...    → record real R3F render evidence → VERIFIED
 *   promote <versionId>       → every gate evaluated from stored evidence → PRODUCTION
 *   rollback <versionId>      → RETIRED → PRODUCTION (previous artifacts kept)
 *   retire | reject | health | reconcile | status | report
 *
 * Safety rails:
 *   * Writing to a NON-LOCAL database (production) requires ALLOW_PROD_PROMOTION=1.
 *   * Promotion/rollback never bypass a gate; failures print the failing gate ids.
 *   * Nothing is downloaded or executed here — files come from the operator.
 *
 * Usage examples:
 *   npx -y tsx scripts/p2j-asset-pipeline.mts inbox
 *   npx -y tsx scripts/p2j-asset-pipeline.mts ingest .freebuff/asset-inbox/peugeot-206.glb \
 *       --meta .freebuff/asset-inbox/peugeot-206.meta.json --asset peugeot-206-body-real-v1
 */
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { KHRONOS_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { prune, dedup, weld, quantize, simplify, meshopt } from "@gltf-transform/functions";
import { MeshoptSimplifier, MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";
import { PrismaClient } from "@prisma/client";
import { auditAsset, summarizeAudit, sha256 } from "../src/lib/asset-validation/index.ts";
import type { ProvenanceRecord } from "../src/lib/asset-validation/provenance.ts";
import {
  createAssetVersion,
  mappingHealthRows,
  optimizeVersion,
  promoteVersion,
  recordRenderVerification,
  refreshMappingHealth,
  rejectVersion,
  resolveVersionContract,
  retireVersion,
  rollbackToVersion,
  stageVersion,
  storedAuditOf,
  validateVersion,
} from "../src/lib/asset-registry.ts";
import { evaluatePromotion, summarizeMappingHealth, type AssetState } from "../src/lib/asset-lifecycle.ts";
import { getAssetStorage } from "../src/lib/storage/index.ts";
import { reconcileStorage } from "../src/lib/asset-reconciliation.ts";

const prisma = new PrismaClient();
const ROOT = path.resolve(import.meta.dirname ?? import.meta.url.replace(/^file:\/\//, ""), "..");
const INBOX = path.join(ROOT, ".freebuff", "asset-inbox");
const REPORTS = path.join(ROOT, ".freebuff", "p2j-reports");

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "";
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function positional(): string[] {
  const out: string[] = [];
  for (let i = 2; i < process.argv.length; i += 1) {
    const token = process.argv[i];
    if (token === undefined) continue;
    if (token.startsWith("--")) { i += 1; continue; }
    out.push(token);
  }
  return out;
}
function num(name: string, dflt: number): number {
  const raw = arg(name);
  if (raw === null || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}
function dbHost(): string {
  try { return new URL(process.env.DATABASE_URL ?? "").hostname; } catch { return ""; }
}
function isLocalDb(): boolean {
  const h = dbHost();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "";
}
function assertWriteAllowed(command: string): void {
  if (isLocalDb()) return;
  if (process.env.ALLOW_PROD_PROMOTION === "1") return;
  fail(
    `${command}: target database host "${dbHost()}" is NOT local. ` +
    `Re-run with ALLOW_PROD_PROMOTION=1 only when you truly intend to write to that database.`,
  );
}
function fail(message: string): never {
  console.error(`✘ ${message}`);
  process.exit(1);
}
function ok(message: string): void {
  console.log(`✔ ${message}`);
}
function line(...parts: (string | number | null | undefined)[]): void {
  console.log(parts.filter((p) => p !== null && p !== undefined).join(" · "));
}

// ─────────────────────────── commands ───────────────────────────

async function cmdInbox(): Promise<void> {
  await mkdir(INBOX, { recursive: true });
  const entries = await readdir(INBOX);
  const candidates = entries.filter((f) => /\.(glb|gltf|zip)$/i.test(f));
  if (candidates.length === 0) {
    line("inbox is empty:", path.relative(ROOT, INBOX));
    line("drop the .glb (or the unzipped .gltf + textures) from the source page here,");
    line("plus a <name>.meta.json provenance record (see docs/phase2/PHASE2-J-ASSET-SOURCE-REPORT.md §4).");
    return;
  }
  for (const file of candidates) {
    const bytes = await readFile(path.join(INBOX, file));
    const metaPath = path.join(INBOX, file.replace(/\.(glb|gltf|zip)$/i, ".meta.json"));
    let hasMeta = true;
    try { await readFile(metaPath); } catch { hasMeta = false; }
    line(`• ${file}`, `${bytes.byteLength} bytes`, `sha256 ${sha256(bytes).slice(0, 16)}…`, hasMeta ? "meta ✓" : "meta MISSING");
  }
}

async function cmdIngest(): Promise<void> {
  assertWriteAllowed("ingest");
  const [fileArg] = positional();
  if (!fileArg) fail("ingest needs a file: ingest <path-to.glb> [--meta <path>] [--asset <assetId>]");
  const file = path.isAbsolute(fileArg) ? fileArg : path.join(ROOT, fileArg);
  const bytes = await readFile(file);
  const metaPath = path.join(arg("meta") || file.replace(/\.(glb|gltf|zip)$/i, ".meta.json"));
  let meta: ProvenanceRecord;
  try {
    meta = JSON.parse(await readFile(metaPath, "utf8")) as ProvenanceRecord;
  } catch {
    fail(`provenance record not found or unreadable: ${metaPath} (see PHASE2-J-ASSET-SOURCE-REPORT.md §4)`);
  }
  // The CLI never trusts the record's size/checksum: both are re-derived here.
  const observed = { fileSize: bytes.byteLength, sha256: sha256(bytes) };
  const assetBusinessId = arg("asset") || "peugeot-206-body-real-v1";

  const asset = await prisma.asset.findUnique({ where: { assetId: assetBusinessId } });
  if (!asset) {
    const vehicle = await prisma.vehicle.findFirst({ where: { model: "206" } });
    if (!vehicle) fail("canonical Peugeot 206 vehicle not found — run the seed first");
    await prisma.asset.create({
      data: {
        assetId: assetBusinessId,
        vehicleId: vehicle.id,
        kind: "REAL",
        format: "glb",
        source: meta.sourceProvider || "UNKNOWN",
        licenseNote: `${meta.licenseType} — ${meta.sourceUrl}`,
      },
    });
    ok(`registered asset row ${assetBusinessId} (kind=REAL) on the canonical 206 vehicle`);
  }

  const payload = { ...meta, fileSize: observed.fileSize, sha256: observed.sha256 };
  const result = await createAssetVersion({
    assetId: assetBusinessId,
    fileBuffer: bytes,
    fileName: path.basename(file),
    provenance: {
      assetIdentity: payload.assetIdentity,
      sourceUrl: payload.sourceUrl,
      sourceProvider: payload.sourceProvider,
      creator: payload.creator,
      licenseType: payload.licenseType,
      licenseUrl: payload.licenseUrl,
      commercialUse: payload.commercialUse,
      redistributionAllowed: payload.redistributionAllowed,
      modificationAllowed: payload.modificationAllowed,
      attributionText: payload.attributionText,
      downloadDate: payload.downloadDate,
      originalFilename: payload.originalFilename || path.basename(file),
      intendedUsage: payload.intendedUsage,
      modifications: payload.modifications,
      notes: payload.notes ?? null,
      variantClaim: payload.variantClaim ?? null,
    },
    actor: arg("actor") || "cli:ingest",
  });
  if (!result.ok) fail(`ingest failed: ${result.error}`);

  const report = summarizeAudit(
    auditAsset(bytes, { provenance: payload, limitProfile: "raw-ingestion" }),
  );
  await mkdir(REPORTS, { recursive: true });
  const reportPath = path.join(REPORTS, `ingest-${observed.sha256.slice(0, 12)}.json`);
  await writeFile(reportPath, JSON.stringify({ provenance: payload, audit: report }, null, 2));

  line("outcome:", result.outcome);
  line("versionId:", result.versionId, "version:", result.version);
  line("sha256:", observed.sha256);
  line("bytes:", observed.byteLength, "triangles:", report.metrics?.triangles, "nodes:", report.metrics?.nodes);
  line("counts:", JSON.stringify(report.counts));
  line("verdict:", report.verdict, "structure:", report.structure, "security:", report.security, "selfContained:", report.selfContained, "provenance:", report.provenance);
  if (report.problems.length > 0) {
    console.log("problems:");
    for (const p of report.problems.slice(0, 12)) line(`  ${p.severity}:${p.code}`, p.where ?? "", p.detail ?? "");
  }
  if (report.inventory) {
    console.log("inventory (first 20 mesh nodes):");
    for (const e of report.inventory.entries.slice(0, 20)) {
      line(`  ${e.nodeName || "(unnamed)"}`, `tris=${e.triangles}`, `prims=${e.primitives}`, e.nameSource);
    }
  }
  line("report:", path.relative(ROOT, reportPath));
  if (result.outcome === "RAW") ok("stored as RAW — next: validate");
  else ok("REJECTED — evidence recorded, nothing was uploaded");
}

async function cmdValidate(): Promise<void> {
  assertWriteAllowed("validate");
  const [versionId] = positional();
  if (!versionId) fail("validate needs a versionId");
  const res = await validateVersion(versionId, { actor: arg("actor") || "cli:validate" });
  if (!res.ok) fail(`${res.error}${res.problems?.length ? ` — ${res.problems.join(", ")}` : ""}`);
  ok(`version ${versionId} → ${res.state}`);
}

const DEFAULT_ASSET_ID = "peugeot-206-main-v1";

async function latestVersionId(assetId: string): Promise<string> {
  const version = await prisma.assetVersion.findFirst({
    where: { asset: { assetId } },
    orderBy: { version: "desc" },
    select: { id: true },
  });
  if (!version) fail(`no versions exist for asset ${assetId}`);
  return version.id;
}

async function loadVersionOrFail(versionId: string) {
  const version = await prisma.assetVersion.findUnique({ where: { id: versionId }, include: { asset: true } });
  if (!version) fail(`version not found: ${versionId}`);
  return version;
}

async function cmdInventory(): Promise<void> {
  const [versionId] = positional();
  if (!versionId) fail("inventory needs a versionId");
  const version = await loadVersionOrFail(versionId);
  const audit = storedAuditOf(version.validationJson) ?? storedAuditOf(version.rawValidationJson);
  if (!audit) fail("no audit evidence for this version — validate it first");
  line("version:", version.version, "state:", version.state, "inventoryHash:", audit.inventoryHash);
  line("metrics:", JSON.stringify(audit.metrics));
  line("unnamed mesh nodes:", audit.inventory?.unnamedMeshNodes, "duplicate names:", audit.inventory?.duplicateMeshNames.join(", ") || "none");
  for (const e of audit.inventory?.entries ?? []) {
    line(`• ${e.path}`, `node=${e.nodeName || "(unnamed)"}`, `mesh=${e.meshName || "(unnamed)"}`, `tris=${e.triangles}`, `verts=${e.vertices}`, e.nameSource, `fp=${e.fingerprint.slice(0, 12)}`);
  }
}

async function cmdOptimize(): Promise<void> {
  assertWriteAllowed("optimize");
  const [versionId] = positional();
  if (!versionId) fail("optimize needs a versionId");
  const version = await loadVersionOrFail(versionId);
  const rawKey = version.rawFilePath ?? version.filePath;
  if (!rawKey || rawKey.startsWith("builtin:")) fail("this version has no stored raw artifact to optimize");
  const rawBytes = Buffer.from(await getAssetStorage().download(rawKey));

  const ratio = num("ratio", 0.7);
  const textureMax = num("texture-max", 2048);
  const useMeshopt = !flag("no-meshopt");

  const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
  const doc = await io.readBinary(new Uint8Array(rawBytes));
  const builder = doc.getRoot().listMeshes();
  const before = {
    meshes: builder.length,
    nodes: doc.getRoot().listNodes().length,
    materials: doc.getRoot().listMaterials().length,
    textures: doc.getRoot().listTextures().length,
  };

  const steps: string[] = ["prune", "dedup", "weld"];
  await doc.transform(prune(), dedup(), weld());
  if (ratio < 1) {
    await MeshoptSimplifier.ready;
    steps.push(`simplify(ratio=${ratio})`);
    await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.001, lockBorder: true }));
  }
  steps.push("quantize");
  await doc.transform(quantize());

  if (textureMax > 0) {
    let resized = 0;
    for (const texture of doc.getRoot().listTextures()) {
      const size = texture.getSize();
      if (!size || Math.max(size[0], size[1]) <= textureMax) continue;
      const image = texture.getImage();
      if (!image) continue;
      const out = await sharp(Buffer.from(image))
        .resize({ width: textureMax, height: textureMax, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      texture.setImage(new Uint8Array(out)).setMimeType("image/png");
      resized += 1;
    }
    if (resized > 0) steps.push(`textures→≤${textureMax}px (${resized})`);
  }

  if (useMeshopt) {
    // meshopt (not Draco): the decoder ships with three, so the browser needs no
    // extra runtime fetch. Draco stays available but is only used if measured
    // better — see PHASE2-J-ASSET-VALIDATION.md §optimization.
    doc.createExtension(EXTMeshoptCompression)
      .setRequired(true)
      .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
    await MeshoptEncoder.ready;
    steps.push("meshopt(medium)");
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: "medium" }));
  }

  const optimized = Buffer.from(await io.writeBinary(doc));
  const mappingTargets = await prisma.meshMapping.findMany({ where: { versionId }, select: { meshName: true } });

  line("raw bytes:", rawBytes.byteLength, "→ optimized bytes:", optimized.byteLength);
  line("steps:", steps.join(" → "));
  line("before:", JSON.stringify(before));

  const res = await optimizeVersion(versionId, {
    optimizedBuffer: optimized,
    fileName: `${version.asset.assetId}-v${version.version}-optimized.glb`,
    optimizer: { tool: "gltf-transform + sharp + meshoptimizer", settings: { ratio, textureMax, meshopt: useMeshopt, steps } },
    requiredMeshNames: mappingTargets.map((m) => m.meshName),
    actor: arg("actor") || "cli:optimize",
  });
  if (!res.ok) fail(`${res.error}${res.problems?.length ? ` — ${res.problems.join(", ")}` : ""}`);
  for (const [k, d] of Object.entries(res.deltas as Record<string, { raw: number; optimized: number; ratio: number }>)) {
    line(`  ${k}: ${d.raw} → ${d.optimized}`, Number.isFinite(d.ratio) ? `${((d.ratio - 1) * 100).toFixed(1)}%` : "n/a");
  }
  if (res.warnings.length > 0) line("warnings:", res.warnings.join(", "));
  ok(`version ${versionId} → ${res.state}`);
}

async function cmdStage(): Promise<void> {
  assertWriteAllowed("stage");
  const [versionId] = positional();
  if (!versionId) fail("stage needs a versionId");
  const res = await stageVersion(versionId, { actor: arg("actor") || "cli:stage" });
  if (!res.ok) fail(`${res.error}${res.problems?.length ? ` — ${res.problems.join(", ")}` : ""}`);
  line("mapping:", JSON.stringify(res.mapping));
  ok(`version ${versionId} → ${res.state}`);
}

async function cmdVerify(): Promise<void> {
  assertWriteAllowed("verify");
  const [versionId] = positional();
  if (!versionId) fail("verify needs a versionId");
  const url = arg("url");
  if (!url) fail("verify needs --url <preview-url that was actually rendered>");
  const viewports = (arg("viewports") || "desktop 1280×800,mobile 390×844").split(",").map((s) => s.trim()).filter(Boolean);
  const observations = (arg("observations") || "").split(";").map((s) => s.trim()).filter(Boolean);
  if (observations.length === 0) fail("verify needs --observations \"…;…\" describing what was actually seen");
  const by = arg("by") || "cli:verify";
  const res = await recordRenderVerification(versionId, {
    source: url.includes("localhost") || url.includes("127.0.0.1") ? "local-dev" : url.includes("poom-jet.vercel.app") ? "staging" : "preview",
    url,
    checkedAt: new Date().toISOString(),
    by,
    viewports,
    observations,
    consoleErrors: arg("console-errors") === null ? undefined : num("console-errors", 0),
    networkFailures: arg("network-failures") === null ? undefined : num("network-failures", 0),
    webglErrors: arg("webgl-errors") === null ? undefined : num("webgl-errors", 0),
  }, { actor: by });
  if (!res.ok) fail(res.error);
  ok(`version ${versionId} → ${res.state} (verification evidence recorded)`);
}

async function cmdStatus(): Promise<void> {
  // `status` is the one command that is useful without an id: with no positional
  // version it reports the latest version of --asset (default: the canonical 206
  // asset), which is what an operator wants right after a pipeline step.
  const [given] = positional();
  const versionId = given ?? (await latestVersionId(arg("asset") || DEFAULT_ASSET_ID));
  const version = await loadVersionOrFail(versionId);
  const validation = storedAuditOf(version.validationJson);
  const rawValidation = storedAuditOf(version.rawValidationJson);
  const health = await mappingHealthRows(versionId);
  const summary = summarizeMappingHealth(health);
  const metadata = (version.metadataJson as Record<string, unknown> | null) ?? {};
  const previous = await prisma.assetVersion.findFirst({
    where: { assetId: version.assetId, state: "PRODUCTION", id: { not: version.id } },
    select: { version: true, filePath: true },
  });
  const evaluation = evaluatePromotion({
    assetKind: version.asset.kind as "SYNTHETIC" | "REAL",
    state: version.state as AssetState,
    validation,
    rawValidation,
    rights: {
      commercialUse: version.commercialUse,
      redistribution: version.redistributionAllowed === true,
      modification: version.modificationAllowed === true,
    },
    attribution: { text: version.attributionText, required: validation?.rights?.attributionRequired ?? false },
    mapping: summary,
    renderVerification: (metadata.renderVerification as never) ?? null,
    timestamps: {
      validatedAt: version.validatedAt, optimizedAt: version.optimizedAt,
      stagedAt: version.stagedAt, verifiedAt: version.verifiedAt,
    },
    previousProduction: {
      exists: previous !== null,
      hasImmutableObject: Boolean(previous?.filePath && !previous.filePath.startsWith("builtin:")),
    },
  });
  line("asset:", version.asset.assetId, `kind=${version.asset.kind}`, "version:", version.version, "state:", version.state);
  line("artifact:", version.filePath, version.fileSize, `${(version.checksumSha256 ?? "").slice(0, 16)}…`);
  line("raw:", version.rawFilePath ?? "—", version.rawFileSize ?? "", `${(version.rawChecksumSha256 ?? "").slice(0, 16)}…`);
  line("timestamps:", JSON.stringify({
    validatedAt: version.validatedAt, optimizedAt: version.optimizedAt,
    stagedAt: version.stagedAt, verifiedAt: version.verifiedAt, promotedAt: version.promotedAt,
  }));
  line("mapping:", JSON.stringify(summary));
  line("promotion gates:", evaluation.ok ? "ALL PASS" : `BLOCKED (${evaluation.blockers.join(", ")})`);
  for (const gate of evaluation.gates) line(`  ${gate.pass ? "✓" : "✘"} ${gate.id} — ${gate.label}`, gate.detail ?? "");
}

async function cmdPromote(): Promise<void> {
  assertWriteAllowed("promote");
  const [versionId] = positional();
  if (!versionId) fail("promote needs a versionId");
  const res = await promoteVersion(versionId, { actor: arg("actor") || "cli:promote", note: arg("note") || "cli promotion" });
  if (!res.ok) fail(`${res.error}${res.problems?.length ? ` — failing gates: ${res.problems.join(", ")}` : ""}`);
  if (res.retiredPrevious !== null) line("previous production version retired:", res.retiredPrevious);
  ok(`version ${versionId} → PRODUCTION`);
}

async function cmdRollback(): Promise<void> {
  assertWriteAllowed("rollback");
  const [versionId] = positional();
  if (!versionId) fail("rollback needs a versionId");
  const reason = arg("reason");
  if (!reason) fail("rollback needs --reason \"…\"");
  const res = await rollbackToVersion(versionId, { actor: arg("actor") || "cli:rollback", reason });
  if (!res.ok) fail(`${res.error}${res.problems?.length ? ` — failing gates: ${res.problems.join(", ")}` : ""}`);
  ok(`version ${versionId} → PRODUCTION (rollback)`);
}

async function cmdLifecycle(action: "retire" | "reject" | "health"): Promise<void> {
  assertWriteAllowed(action);
  const [versionId] = positional();
  if (!versionId) fail(`${action} needs a versionId`);
  if (action === "health") {
    const res = await refreshMappingHealth(versionId, { actor: arg("actor") || "cli:health" });
    if (!res.ok) fail(res.error);
    for (const row of res.rows) line(`• ${row.meshName}`, row.kind, row.status, row.detail ?? "");
    ok(`${res.rows.length} mapping(s) checked`);
    return;
  }
  const reason = arg("reason") || `${action} via CLI`;
  const res = action === "retire"
    ? await retireVersion(versionId, { actor: arg("actor") || "cli:retire", reason })
    : await rejectVersion(versionId, { actor: arg("actor") || "cli:reject", reason });
  if (!res.ok) fail(res.error);
  ok(`version ${versionId} → ${res.state}`);
}

/** §35 database integrity: the relationships the 3D layer depends on. */
async function cmdReconcile(): Promise<void> {
  assertWriteAllowed("reconcile");
  const report = await reconcileStorage();
  line("storage provider:", report.provider, report.bucket || "(local)");
  line("versions without storage object:", report.assetVersionsWithoutStorage.length || "none");
  line("raw artifacts missing from storage:", report.rawArtifactsWithoutStorage.length || "none");
  line("orphan storage objects:", report.storageObjectsWithoutAssetVersion.length || "none");
  line("PRODUCTION versions without object:", report.productionVersionsWithoutStorage.length || "none");
  line("REJECTED versions with an object:", report.rejectedVersionsWithStorage.length || "none");
  for (const key of report.storageObjectsWithoutAssetVersion.slice(0, 10)) line(`  orphan: ${key}`);
  for (const id of report.assetVersionsWithoutStorage.slice(0, 10)) line(`  missing: ${id}`);

  const mappings = await prisma.meshMapping.findMany({
    include: {
      version: { include: { asset: { select: { vehicleId: true, assetId: true } } } },
      zone: { select: { vehicleId: true, key: true } },
      part: { select: { slug: true, id: true } },
    },
  });
  const invalidTargets = mappings.filter((m) =>
    (m.kind === "zone" && !m.zoneId) || (m.kind === "part" && !m.partId) || (m.kind === "assembly" && !m.assemblyId));
  const crossVehicle = mappings.filter((m) =>
    m.zone && m.version.asset.vehicleId && m.zone.vehicleId !== m.version.asset.vehicleId);
  const duplicateTargets = await prisma.$queryRaw<{ versionId: string; partId: string; cnt: bigint }[]>`
    SELECT "versionId", "partId", COUNT(*) AS cnt FROM "MeshMapping"
    WHERE "partId" IS NOT NULL GROUP BY "versionId", "partId" HAVING COUNT(*) > 1 LIMIT 20`;
  const duplicateProduction = await prisma.$queryRaw<{ assetId: string; cnt: bigint }[]>`
    SELECT "assetId", COUNT(*) AS cnt FROM "AssetVersion" WHERE state = 'PRODUCTION'
    GROUP BY "assetId" HAVING COUNT(*) > 1 LIMIT 20`;
  const placeholderInProduction = await prisma.assetVersion.count({
    where: { state: "PRODUCTION", asset: { kind: "SYNTHETIC" } },
  });

  line("mappings with a missing target:", invalidTargets.length || "none");
  line("cross-vehicle mappings:", crossVehicle.length || "none");
  line("duplicate part mappings per version:", duplicateTargets.length || "none");
  line("assets with more than one PRODUCTION version:", duplicateProduction.length || "none");
  line("SYNTHETIC versions in PRODUCTION (must be 0):", placeholderInProduction);

  const clean = report.assetVersionsWithoutStorage.length === 0 &&
    report.rawArtifactsWithoutStorage.length === 0 &&
    report.productionVersionsWithoutStorage.length === 0 &&
    report.rejectedVersionsWithStorage.length === 0 &&
    invalidTargets.length === 0 && crossVehicle.length === 0 &&
    duplicateTargets.length === 0 && duplicateProduction.length === 0 &&
    placeholderInProduction === 0;
  if (clean) ok("reconciliation CLEAN");
  else fail("reconciliation found issues (listed above)");
}

/** §36 evidence: the machine-readable state of every asset/version. */
async function cmdReport(): Promise<void> {
  const assets = await prisma.asset.findMany({
    include: {
      vehicle: { select: { displayName: true } },
      versions: { orderBy: { version: "desc" }, include: { meshMappings: true } },
    },
  });
  const rows: Record<string, unknown>[] = [];
  for (const asset of assets) {
    for (const version of asset.versions) {
      const validation = storedAuditOf(version.validationJson);
      const health = await mappingHealthRows(version.id);
      const contract = await resolveVersionContract(version.id);
      rows.push({
        assetId: asset.assetId,
        vehicle: asset.vehicle?.displayName ?? null,
        kind: asset.kind,
        version: version.version,
        state: version.state,
        filePath: version.filePath,
        rawFilePath: version.rawFilePath,
        sha256: version.checksumSha256,
        rawSha256: version.rawChecksumSha256,
        license: {
          licenseType: version.licenseType, licenseUrl: version.licenseUrl,
          sourceUrl: version.sourceUrl, sourceProvider: version.sourceProvider,
          creator: version.creator, attributionText: version.attributionText,
          commercialUse: version.commercialUse,
          redistributionAllowed: version.redistributionAllowed,
          modificationAllowed: version.modificationAllowed,
        },
        validation: validation
          ? { verdict: validation.verdict, structure: validation.structure, security: validation.security, selfContained: validation.selfContained, provenance: validation.provenance }
          : null,
        metrics: validation?.metrics ?? null,
        inventoryHash: validation?.inventoryHash ?? null,
        meshNodes: validation?.inventory?.meshNodeCount ?? 0,
        mappingCount: version.meshMappings.length,
        mappingHealth: summarizeMappingHealth(health),
        zones: contract?.zones.map((z) => ({ meshName: z.meshName, zoneKey: z.zoneKey, health: z.health, trusted: z.trusted })) ?? [],
        parts: contract?.parts.map((p) => ({ meshName: p.meshName, partSlug: p.partSlug, health: p.health, trusted: p.trusted })) ?? [],
        availability: contract?.availability ?? null,
        timestamps: {
          createdAt: version.createdAt, validatedAt: version.validatedAt, optimizedAt: version.optimizedAt,
          stagedAt: version.stagedAt, verifiedAt: version.verifiedAt, promotedAt: version.promotedAt,
        },
      });
    }
  }
  await mkdir(REPORTS, { recursive: true });
  const out = path.join(REPORTS, `p2j-report-${new Date().toISOString().slice(0, 10)}.json`);
  await writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), db: dbHost(), rows }, null, 2));
  for (const row of rows) {
    line(`• ${row.assetId} v${row.version}`, `kind=${row.kind}`, `state=${row.state}`, `mappings=${row.mappingCount}`, `inventory=${row.inventoryHash ? String(row.inventoryHash).slice(0, 12) : "—"}`);
  }
  line("report:", path.relative(ROOT, out));
}

async function main(): Promise<void> {
  const command = positional()[0];
  // Remove the command token itself, so each sub-command reads only its own
  // arguments (`stage <versionId>` must not see "stage" as the versionId).
  const commandIndex = process.argv.findIndex((token, i) => i >= 2 && token === command);
  if (commandIndex !== -1) process.argv.splice(commandIndex, 1);
  const rest = positional();
  switch (command) {
    case "inbox": await cmdInbox(); break;
    case "ingest": await cmdIngest(); break;
    case "validate": await cmdValidate(); break;
    case "inventory": await cmdInventory(); break;
    case "optimize": await cmdOptimize(); break;
    case "stage": await cmdStage(); break;
    case "verify": await cmdVerify(); break;
    case "status": await cmdStatus(); break;
    case "promote": await cmdPromote(); break;
    case "rollback": await cmdRollback(); break;
    case "retire": await cmdLifecycle("retire"); break;
    case "reject": await cmdLifecycle("reject"); break;
    case "health": await cmdLifecycle("health"); break;
    case "reconcile": await cmdReconcile(); break;
    case "report": await cmdReport(); break;
    default:
      console.log(await readFile(new URL(import.meta.url), "utf8").then((s) => s.split("*/")[0]!.replace(/^\/\*\*?/, "")));
      line("commands:", "inbox ingest validate inventory optimize stage verify status promote rollback retire reject health reconcile report");
      if (rest.length > 0) fail(`unknown command: ${command}`);
  }
}

main()
  .catch((e) => fail(e instanceof Error ? e.message : String(e)))
  .finally(() => void prisma.$disconnect());
