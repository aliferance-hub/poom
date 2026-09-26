import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { verifyRealPart, reopenVerification } from "@/lib/catalog-import";
import {
  buildManifest, classifyTargets, promoteCatalog, reconcile,
} from "@/lib/catalog-promotion";

/**
 * P2-I gates:
 *  - I4 verification hardening: evidence mandatory, DEMO un-verifiable,
 *    no-provenance refused, audited attempts, reopen keeps history.
 *  - I6/I8 promotion: VERIFIED-only, conflict blocking, idempotent re-run,
 *    manifest tamper defense, reconciliation EXPECTED vs ACTUAL.
 * The promotion target is a plain PrismaClient against the same test DB —
 * promotion logic is DB-agnostic (manifest in → rows upserted), so pointing
 * it at a disjoint SKU space gives a clean "target" without a second database.
 */

const admin = "p2i-test-admin";

// ── fixtures (removed in afterAll) ──
let realPartId = "";      // real provenance, REVIEW_REQUIRED
let demoPartId = "";      // DEMO record
let noProvenancePartId = "";// REVIEW_REQUIRED but sourceRef NULL (legacy shape)
let deprecatedPartId = "";
const createdPartIds: string[] = [];

async function mkPart(sku: string, dataStatus: string, sourceRef: string | null): Promise<string> {
  const p = await prisma.part.create({
    data: {
      sku, slug: `p2i-${sku.toLowerCase()}`, title: `P2I ${sku}`,
      condition: "NEW", active: true, dataStatus: dataStatus as never,
      sourceRef, sourceUpdatedAt: sourceRef ? new Date("2024-09-01") : null,
    },
  });
  createdPartIds.push(p.id);
  return p.id;
}

beforeAll(async () => {
  const suffix = Date.now().toString(36);
  realPartId = await mkPart(`P2I-VP-${suffix}`, "REVIEW_REQUIRED", "public-206-maintenance-documentation");
  demoPartId = await mkPart(`P2I-DEMO-${suffix}`, "DEMO", null);
  noProvenancePartId = await mkPart(`P2I-NOPROV-${suffix}`, "REVIEW_REQUIRED", null);
  deprecatedPartId = await mkPart(`P2I-DEP-${suffix}`, "DEPRECATED", "public-206-maintenance-documentation");
});

afterAll(async () => {
  await prisma.catalogEventLog.deleteMany({ where: { partId: { in: createdPartIds } } });
  await prisma.fitment.deleteMany({ where: { part: { slug: { startsWith: "p2i-promo-" } } } });
  await prisma.part.deleteMany({ where: { id: { in: createdPartIds } } });
  await prisma.$disconnect();
});

// ─────────────────────── I4 verification hardening ───────────────────────

describe("P2-I I4: verification is evidence-based and audited", () => {
  it("refuses verification without evidence (EVIDENCE_REQUIRED)", async () => {
    const r = await verifyRealPart(realPartId, admin);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("EVIDENCE_REQUIRED");
    const row = await prisma.part.findUniqueOrThrow({ where: { id: realPartId } });
    expect(row.dataStatus).toBe("REVIEW_REQUIRED"); // unchanged
  });

  it("refuses a DEMO record (DEMO_PART) — demo/real boundary is not bypassable", async () => {
    const r = await verifyRealPart(demoPartId, admin, "https://real-source.example/part");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("DEMO_PART");
  });

  it("refuses a record without provenance (NO_SOURCE_REF)", async () => {
    const r = await verifyRealPart(noProvenancePartId, admin, "https://real-source.example/part");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("NO_SOURCE_REF");
  });

  it("refuses a DEPRECATED record (no resurrection)", async () => {
    const r = await verifyRealPart(deprecatedPartId, admin, "https://real-source.example/part");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("DEPRECATED");
  });

  it("verifies with evidence → audited; evidence URL is persisted; repeat appends another audited act", async () => {
    const url = "https://real-source.example/oil-filter";
    const r = await verifyRealPart(realPartId, admin, url);
    expect(r.ok).toBe(true);
    const row = await prisma.part.findUniqueOrThrow({ where: { id: realPartId } });
    expect(row.dataStatus).toBe("VERIFIED");
    expect(row.verifiedBy).toBe(admin);
    expect(row.sourceUrl).toBe(url);
    const events = await prisma.catalogEventLog.findMany({
      where: { partId: realPartId, event: "catalog_verified" },
      orderBy: { createdAt: "asc" },
    });
    expect(events.length).toBe(1);
    expect(events[0]!.actor).toBe(admin);
    expect((events[0]!.meta as { evidenceUrl?: string }).evidenceUrl).toBe(url);
    expect((events[0]!.meta as { fromState?: string }).fromState).toBe("REVIEW_REQUIRED");

    // re-verify: state unchanged, new audit act (auditable repeated action)
    const r2 = await verifyRealPart(realPartId, "second-admin", url);
    expect(r2.ok).toBe(true);
    const count = await prisma.catalogEventLog.count({ where: { partId: realPartId, event: "catalog_verified" } });
    expect(count).toBe(2);
  });

  it("reopen keeps the verification history in the log", async () => {
    const r = await reopenVerification(realPartId, admin, "evidence expired");
    expect(r.ok).toBe(true);
    const row = await prisma.part.findUniqueOrThrow({ where: { id: realPartId } });
    expect(row.dataStatus).toBe("REVIEW_REQUIRED");
    expect(row.verifiedBy).toBeNull();
    const reopened = await prisma.catalogEventLog.findFirst({
      where: { partId: realPartId, event: "catalog_verification_reopened" },
      orderBy: { createdAt: "desc" },
    });
    expect(reopened).toBeTruthy();
    expect((reopened!.meta as { note?: string }).note).toBe("evidence expired");
    const history = await prisma.catalogEventLog.count({ where: { partId: realPartId, event: "catalog_verified" } });
    expect(history).toBe(2); // untouched by the reopen
  });
});

// ─────────────────────── I6/I8 promotion engine ───────────────────────

describe("P2-I I6/I8: promotion engine", () => {
  const SKU = "PROMO-TEST-001";
  let verifiedId = "";
  let manifestSnapshot: Awaited<ReturnType<typeof buildManifest>> | null = null;

  beforeAll(async () => {
    verifiedId = await mkPart(SKU, "REVIEW_REQUIRED", "public-206-maintenance-documentation");
    await verifyRealPart(verifiedId, admin, "https://real-source.example/promo");
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
    await prisma.fitment.create({
      data: { partId: verifiedId, vehicleId: vehicle.id, fitmentStatus: "CONFIRMED", fitmentNote: "public-206-maintenance-documentation" },
    });
    // Snapshot the manifest BEFORE removing the row, so later "target absent"
    // scenarios have a truthful record payload to promote.
    manifestSnapshot = await buildManifest(prisma, { manifestId: "p2i-test-manifest", sourceDescription: "test" });
    manifestSnapshot.records = manifestSnapshot.records.filter((r) => r.sku === SKU);
  });

  it("buildManifest includes only VERIFIED real records, with verification metadata", async () => {
    const rec = manifestSnapshot!.records.find((r) => r.sku === SKU);
    expect(rec).toBeTruthy();
    expect(rec!.dataStatus).toBe("VERIFIED");
    expect(rec!.fitments.length).toBe(1);
    expect(rec!.verifiedBy).toBe(admin);
    expect(rec!.sourceRef).toBe("public-206-maintenance-documentation");
  });

  it("promotes an absent record with fitment + audit event, idempotently", async () => {
    // Make the record genuinely ABSENT from the "target" (same DB here), as if
    // promoting into an empty production: remove the row after the manifest snapshot.
    await prisma.fitment.deleteMany({ where: { part: { sku: SKU } } });
    await prisma.catalogEventLog.deleteMany({ where: { part: { sku: SKU } } });
    await prisma.part.delete({ where: { sku: SKU } });

    const m = manifestSnapshot!;
    const first = await promoteCatalog(prisma, m, "run-1");
    expect(first.promoted).toEqual([SKU]);

    const row = await prisma.part.findUniqueOrThrow({ where: { sku: SKU } });
    expect(row.dataStatus).toBe("VERIFIED");
    expect(row.sourceRef).toBeTruthy();
    expect(row.verifiedBy).toBe(admin); // verification metadata traveled with the record
    expect(row.verifiedAt).toBeTruthy();
    expect(row.sourceUrl).toBe("https://real-source.example/promo");
    const fits = await prisma.fitment.count({ where: { part: { sku: SKU } } });
    expect(fits).toBe(1); // not duplicated
    const events = await prisma.catalogEventLog.count({ where: { part: { sku: SKU }, event: "catalog_promoted" } });
    expect(events).toBe(1);

    // idempotent re-run: SAME, no new events, no duplicate fitment
    const second = await promoteCatalog(prisma, m, "run-2");
    expect(second.alreadyPresent).toEqual([SKU]);
    expect(second.promoted).toHaveLength(0);
    const eventsAfter = await prisma.catalogEventLog.count({ where: { part: { sku: SKU }, event: "catalog_promoted" } });
    expect(eventsAfter).toBe(1);
    const fitsAfter = await prisma.fitment.count({ where: { part: { sku: SKU } } });
    expect(fitsAfter).toBe(1);
  });

  it("classify flags CONFLICT when a non-promotable target row holds the SKU", async () => {
    const m = manifestSnapshot!;
    // simulate a drifted target: the promoted record's fitment set diverges from the manifest
    await prisma.fitment.deleteMany({ where: { part: { sku: SKU } } });
    const rows = await classifyTargets(prisma, m);
    const conflict = rows.find((r) => r.sku === SKU);
    expect(conflict?.cls).toBe("CONFLICT");
    // and promoteCatalog refuses to run on conflicts
    await expect(promoteCatalog(prisma, m, "run-3")).rejects.toThrow(/PROMOTION_BLOCKED_CONFLICTS/);
    // restore the fitment set for any later reads. The Part row was DELETED by
    // the previous test (absent-target scenario) and re-created by the blocked
    // promote attempt's classify? — classify does NOT write; promoteCatalog
    // throws BEFORE writing. So re-create the Part row here, then the fitment.
    const part = await prisma.part.upsert({
      where: { sku: SKU },
      update: { title: `P2I ${SKU}`, dataStatus: "VERIFIED", verifiedBy: admin, verifiedAt: new Date(), sourceRef: "public-206-maintenance-documentation", sourceUrl: "https://real-source.example/promo" },
      create: { sku: SKU, slug: `p2i-promo-${SKU.toLowerCase()}`, title: `P2I ${SKU}`, condition: "NEW", active: true, dataStatus: "VERIFIED", verifiedBy: admin, verifiedAt: new Date(), sourceRef: "public-206-maintenance-documentation", sourceUrl: "https://real-source.example/promo" },
    });
    verifiedId = part.id;
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
    await prisma.fitment.create({
      data: { partId: part.id, vehicleId: vehicle.id, fitmentStatus: "CONFIRMED", fitmentNote: "public-206-maintenance-documentation" },
    });
  });

  it("defense in depth: a tampered manifest cannot promote a non-VERIFIED record", async () => {
    const m = await buildManifest(prisma, { manifestId: "p2i-test-manifest", sourceDescription: "test" });
    const demoRecord = {
      sku: "TAMPER-SKU-1", slug: "p2i-tamper", title: "TAMPERED", dataStatus: "REVIEW_REQUIRED",
      verifiedBy: null, verifiedAt: null, sourceRef: null, sourceUrl: null,
      identifiers: [], fitments: [],
    };
    const tampered = { ...m, records: [demoRecord] };
    const res = await promoteCatalog(prisma, tampered, "run-tamper");
    expect(res.promoted).toHaveLength(0);
    expect(res.skipped[0]!.sku).toBe("TAMPER-SKU-1");
    const created = await prisma.part.findUnique({ where: { sku: "TAMPER-SKU-1" } });
    expect(created).toBeNull(); // nothing was written
  });

  it("classify treats an identical REVIEW_REQUIRED skeleton as a state upgrade, never a conflict (seed→promotion path)", async () => {
    const m = manifestSnapshot!;
    // Restore the exact pre-promotion state: record exists, verified fields NULL.
    await prisma.part.update({
      where: { sku: SKU },
      data: { dataStatus: "REVIEW_REQUIRED", verifiedAt: null, verifiedBy: null, sourceUrl: null },
    });
    const rows = await classifyTargets(prisma, m);
    const row = rows.find((r) => r.sku === SKU);
    expect(row?.cls).toBe("PROMOTE");
    expect(row && "reason" in row ? row.reason : "").toBe("state_upgrade_from_REVIEW_REQUIRED");
    // A DEMO record holding the same real SKU IS a conflict (demo/real boundary).
    await prisma.part.update({ where: { sku: SKU }, data: { dataStatus: "DEMO" } });
    const rows2 = await classifyTargets(prisma, m);
    expect(rows2.find((r) => r.sku === SKU)?.cls).toBe("CONFLICT");
    // restore VERIFIED state for the reconciliation test
    await prisma.part.update({
      where: { sku: SKU },
      data: { dataStatus: "VERIFIED", verifiedBy: admin, verifiedAt: new Date(), sourceUrl: "https://real-source.example/promo" },
    });
  });

  it("reconciliation reports MATCH on the promoted record", async () => {
    const m = await buildManifest(prisma, { manifestId: "p2i-test-manifest", sourceDescription: "test" });
    m.records = m.records.filter((r) => r.sku === SKU);
    const rec = await reconcile(prisma, m);
    expect(rec.match).toBe(true);
    expect(rec.rows.find((r) => r.entity === "verified_parts")!.actual).toBe(1);
    expect(rec.rows.find((r) => r.entity === "promotion_events")!.actual).toBe(1);
  });

  afterAll(async () => {
    await prisma.catalogEventLog.deleteMany({ where: { part: { sku: { startsWith: "PROMO-TEST" } } } });
    await prisma.part.deleteMany({ where: { sku: { startsWith: "PROMO-TEST" } } });
  });
});
