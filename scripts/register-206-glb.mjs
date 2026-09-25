/**
 * Register the in-house Peugeot 206 engineering GLB as AssetVersion v2 through
 * the official asset pipeline, copy mappings from the active v1 (preserving
 * every camera/hotspot/label), validate, and activate it.
 *
 *   node scripts/register-206-glb.mjs            # full: create → mappings → validate → activate
 *   node scripts/register-206-glb.mjs --rollback # restore v1 as ACTIVE (data-only rollback)
 *
 * License: POOM_IN_HOUSE — geometry generated in-repo by scripts/build-206-model.mjs
 * (dimension-informed procedural model). No third-party asset, no fabricated license.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssetVersion, markProcessing, validateVersion, activateVersion, getActiveVersion } from "../src/lib/asset-registry.ts";

const prisma = new PrismaClient();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GLB_PATH = join(ROOT, "public", "uploads", "assets", "peugeot-206-main-v1", "v2", "peugeot-206-engineering-v1.glb");

async function rollback() {
  const asset = await prisma.asset.findUniqueOrThrow({ where: { assetId: "peugeot-206-main-v1" } });
  const v1 = await prisma.assetVersion.findUniqueOrThrow({ where: { assetId_version: { assetId: asset.id, version: 1 } } });
  if (v1.status === "ACTIVE") { console.log("v1 already ACTIVE"); return; }
  await activateVersion(v1.id);
  console.log("rolled back → v1 ACTIVE (in-repo placeholder)");
}

async function main() {
  if (process.argv.includes("--rollback")) return rollback();

  const asset = await prisma.asset.findUniqueOrThrow({ where: { assetId: "peugeot-206-main-v1" } });
  const currentActive = await getActiveVersion("peugeot-206-main-v1");
  if (!currentActive) throw new Error("no ACTIVE version — refusing to proceed");
  console.log(`current ACTIVE: v${currentActive.version}`);

  const buffer = readFileSync(GLB_PATH);
  if (buffer.length < 100 || buffer[0] !== 0x67) throw new Error("GLB missing/invalid — run scripts/build-206-model.mjs first");

  // 1) DRAFT version with complete provenance (validator requires every field)
  const v2 = await createAssetVersion({
    assetId: "peugeot-206-main-v1",
    fileBuffer: buffer,
    fileName: "peugeot-206-engineering-v1.glb",
    mimeType: "model/gltf-binary",
    license: {
      licenseType: "POOM_IN_HOUSE",
      licenseUrl: null,
      sourceUrl: "scripts/build-206-model.mjs (in-repo generator)",
      creator: "POOM team (procedural, dimension-informed)",
      attributionText: "مدل مهندسی ۲۰۶ ساخته‌شده در همین مخزن — بدون دارایی شخص ثالث",
      commercialUse: true,
      acquiredAt: new Date(),
      modifications: "initial build",
      intendedUsage: "product viewer (3D part discovery)",
    },
  });
  console.log(`created version ${v2.version} (${v2.status}, ${(buffer.length / 1024).toFixed(0)} KB)`);

  // 2) copy every v1 mapping 1:1 (cameras, hotspots, labels, sortOrder)
  const v1Mappings = await prisma.meshMapping.findMany({ where: { versionId: currentActive.id } });
  for (const m of v1Mappings) {
    await prisma.meshMapping.create({
      data: {
        versionId: v2.id, meshName: m.meshName, kind: m.kind,
        zoneId: m.zoneId, assemblyId: m.assemblyId, partId: m.partId,
        label: m.label, sortOrder: m.sortOrder,
        cameraPositionJson: m.cameraPositionJson, cameraTargetJson: m.cameraTargetJson,
        hotspotJson: m.hotspotJson,
      },
    });
  }
  console.log(`copied ${v1Mappings.length} mappings (expected 13)`);

  // 3) validate → READY, 4) activate → v1 archived
  await markProcessing(v2.id);
  const verdict = await validateVersion(v2.id, buffer);
  if (!verdict.ok) { console.error("VALIDATION FAILED:", verdict.problems); process.exit(1); }
  await activateVersion(v2.id);
  const active = await getActiveVersion("peugeot-206-main-v1");
  console.log(`ACTIVE now: v${active.version} · fileUrl=${active.fileUrl}`);
  console.log(`license: ${active.licenseType} · attribution: ${active.attributionText}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
