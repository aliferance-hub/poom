#!/usr/bin/env node
// P2-I (I6/I8/I9): controlled promotion of VERIFIED real catalog records.
//
// Usage (run with tsx, like the other probes):
//   npx tsx scripts/promote-real-catalog.mts build     <SOURCE_URL> <out.json> <manifestId>
//   npx tsx scripts/promote-real-catalog.mts classify   <manifest.json> <TARGET_URL>
//   npx tsx scripts/promote-real-catalog.mts execute    <manifest.json> <TARGET_URL>
//   npx tsx scripts/promote-real-catalog.mts reconcile  <manifest.json> <TARGET_URL>
//
// Safety:
//  - Non-local targets require ALLOW_PROD_PROMOTION=1 (explicit, per run).
//  - NEVER prints connection strings or secrets; only host classification.
//  - execute() blocks on conflicts (see lib), skips non-VERIFIED records,
//    and is idempotent (re-runs classify as SAME and append nothing).

import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { buildManifest, classifyTargets, promoteCatalog, reconcile } from "../src/lib/catalog-promotion";

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return "(unparseable)"; }
}
function isLocal(url: string): boolean {
  const h = hostOf(url);
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

const [, , mode, argA, argB, argC] = process.argv;

if (mode === "build") {
  // build <SOURCE_URL> <out.json> <manifestId> — snapshot the source's VERIFIED
  // real records into a promotion manifest. No target involved, no guard needed.
  if (!argA || !argB || !argC) {
    console.error("usage: build <SOURCE_URL> <out.json> <manifestId>");
    process.exit(2);
  }
  const source = new PrismaClient({ datasources: { db: { url: argA } } });
  try {
    const m = await buildManifest(source, {
      manifestId: argC,
      sourceDescription: `golden catalog snapshot ${new Date().toISOString()} (host=${hostOf(argA)})`,
      promoteSeller: false, // §7: seller promotion is a separate decision
      promoteOffers: false, // §7: offer availability is a separate decision
    });
    writeFileSync(argB, JSON.stringify(m, null, 2));
    console.log(`manifest ${m.manifestId}: ${m.records.length} VERIFIED record(s) → ${argB}`);
    for (const r of m.records) console.log(`  ${r.sku} — ${r.title} (verifiedBy=${r.verifiedBy}, fitments=${r.fitments.length})`);
  } finally {
    await source.$disconnect();
  }
  process.exit(0);
}

if (!mode || !argA || !argB) {
  console.error("usage: promote-real-catalog.mts <build|classify|execute|reconcile> …");
  process.exit(2);
}
const manifestPath = argA, targetUrl = argB;
if (!isLocal(targetUrl) && process.env.ALLOW_PROD_PROMOTION !== "1") {
  console.error(`✘ target ${hostOf(targetUrl)} is NOT local — set ALLOW_PROD_PROMOTION=1 to promote to a non-local database.`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const target = new PrismaClient({ datasources: { db: { url: targetUrl } } });

try {
  if (mode === "classify") {
    const rows = await classifyTargets(target, manifest);
    for (const r of rows) console.log(`${r.cls.padEnd(18)} ${r.sku} — ${r.reason}`);
    const conflicts = rows.filter((r) => r.cls === "CONFLICT").length;
    console.log(`\nsummary: ${rows.length} records, ${conflicts} conflict(s)`);
    process.exit(conflicts > 0 ? 3 : 0);
  }

  if (mode === "execute") {
    const runId = `${manifest.manifestId}-${Date.now()}`;
    const res = await promoteCatalog(target, manifest, runId);
    console.log(`manifest=${res.manifestId}`);
    console.log(`promoted(${res.promoted.length}): ${res.promoted.join(", ") || "-"}`);
    console.log(`alreadyPresent(${res.alreadyPresent.length}): ${res.alreadyPresent.join(", ") || "-"}`);
    if (res.skipped.length) console.log(`skipped: ${res.skipped.map((s) => `${s.sku} — ${s.reason}`).join("; ")}`);
    process.exit(0);
  }

  if (mode === "reconcile") {
    const rec = await reconcile(target, manifest);
    console.log("entity            expected  actual  match");
    for (const row of rec.rows) {
      console.log(`${row.entity.padEnd(17)} ${String(row.expected).padStart(8)} ${String(row.actual).padStart(7)}  ${row.match ? "YES" : "NO"}`);
    }
    console.log(`\nRECONCILIATION: ${rec.match ? "MATCH" : "MISMATCH"}`);
    process.exit(rec.match ? 0 : 4);
  }

  console.error(`unknown mode: ${mode}`);
  process.exit(2);
} finally {
  await target.$disconnect();
}
