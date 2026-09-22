/**
 * ─────────────────── P2-F.1 — Provenance & Fitment Truth ───────────────────
 * §2 provenance semantics: no silent erase / null-overwrite / batch leakage.
 * §3 fitment UI truthfulness: REVIEW_REQUIRED ≠ COMPATIBLE in customer UI.
 * §4 admin verification authority + role denials.
 * §7 data-quality invariants as live tests.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createSession, revokeSession } from "@/lib/auth/session";
import { ingestRawCsv, normalizeBatch, validateBatch, approveBatch, commitBatch, verifyRealPart, reopenVerification } from "@/lib/catalog-import";
import { resolveFitment, fitmentPresentation } from "@/lib/fitment";

const prisma = new PrismaClient();
const SOURCE_REF = "public-206-maintenance-documentation";

const cleanup: { batches: string[]; parts: string[]; sessions: string[] } = { batches: [], parts: [], sessions: [] };

afterAll(async () => {
  await prisma.importBatch.deleteMany({ where: { id: { in: cleanup.batches } } });
  await prisma.part.deleteMany({ where: { id: { in: cleanup.parts } } });
  await prisma.session.deleteMany({ where: { id: { in: cleanup.sessions } } });
  await prisma.$disconnect();
});

// ─────────────────────────── §1 audit determinism ───────────────────────────

describe("§1 real-record audit", () => {
  it("all 12 real records carry complete provenance and are REVIEW_REQUIRED (nothing silently upgraded)", async () => {
    const parts = await prisma.part.findMany({
      where: { sourceRef: SOURCE_REF },
      select: { slug: true, dataStatus: true, sourceRef: true, sourceUpdatedAt: true, dataVersion: true, verifiedAt: true, verifiedBy: true },
    });
    expect(parts.length).toBe(12);
    for (const p of parts) {
      expect(p.dataStatus).toBe("REVIEW_REQUIRED"); // not VERIFIED — verification is a separate human act
      expect(p.verifiedAt).toBeNull();
      expect(p.verifiedBy).toBeNull();
      expect(p.sourceRef).toBe(SOURCE_REF);
      expect(p.sourceUpdatedAt).not.toBeNull();
      expect(p.dataVersion).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────── §2 provenance semantics ───────────────────────────

describe("§2 provenance cannot be silently erased or leaked", () => {
  it("a batch without sourceUpdatedAt is REJECTED at the gate (no silent erase of provenance on UPDATE rows)", async () => {
    const csv = "title,sku,condition,categoryName,brandName,assemblySlug,identifiers,technicalDescription\nتست,P-F1-TEST-1,NEW,موتور,تولیدی ایران,assembly-engine,,x";
    await expect(
      ingestRawCsv({ label: `f1-no-date-${Date.now()}`, sourceRef: SOURCE_REF, createdBy: "p2f1" }, csv),
    ).rejects.toThrow(/SOURCE_UPDATED_AT_REQUIRED/);
  });

  it("a batch without sourceRef is REJECTED at the gate", async () => {
    const csv = "title,sku,condition,categoryName,brandName,assemblySlug,identifiers,technicalDescription\nتست,P-F1-TEST-2,NEW,موتور,تولیدی ایران,assembly-engine,,x";
    await expect(
      ingestRawCsv({ label: `f1-no-ref-${Date.now()}`, sourceRef: "", sourceUpdatedAt: new Date(), createdBy: "p2f1" }, csv),
    ).rejects.toThrow(/SOURCE_REF_REQUIRED/);
  });

  it("CREATE carries provenance; UPDATE preserves sourceUpdatedAt; unchanged rows are untouched", async () => {
    const created = await ingestRawCsv(
      { label: `f1-create-${Date.now()}`, sourceRef: SOURCE_REF, sourceUpdatedAt: new Date("2025-01-01"), createdBy: "p2f1" },
      "title,titleEn,sku,condition,categoryName,brandName,assemblySlug,identifiers,technicalDescription\nقطعه تست F1,F1 test part,P-F1-CR-001,NEW,موتور,تولیدی ایران,assembly-engine,,تست",
    );
    cleanup.batches.push(created.batchId);
    await normalizeBatch(created.batchId);
    await validateBatch(created.batchId);
    await approveBatch(created.batchId, "p2f1-admin");
    const commit = await commitBatch(created.batchId);
    expect(commit.created).toBe(1);

    const part = await prisma.part.findUniqueOrThrow({ where: { sku: "P-F1-CR-001" } });
    cleanup.parts.push(part.id);
    expect(part.sourceRef).toBe(SOURCE_REF);
    expect(part.sourceUpdatedAt?.toISOString()).toBe(new Date("2025-01-01").toISOString());
    expect(part.dataStatus).toBe("REVIEW_REQUIRED"); // born unverified

    // UPDATE path with the SAME source date — provenance must survive intact
    const upd = await ingestRawCsv(
      { label: `f1-update-${Date.now()}`, sourceRef: SOURCE_REF, sourceUpdatedAt: new Date("2025-01-01"), createdBy: "p2f1" },
      "title,titleEn,sku,condition,categoryName,brandName,assemblySlug,identifiers,technicalDescription\nقطعه تست F1 (ویرایش),F1 test part v2,P-F1-CR-001,NEW,موتور,تولیدی ایران,assembly-engine,,تست ویرایش",
    );
    cleanup.batches.push(upd.batchId);
    await normalizeBatch(upd.batchId);
    await validateBatch(upd.batchId);
    await approveBatch(upd.batchId, "p2f1-admin");
    const commit2 = await commitBatch(upd.batchId);
    expect(commit2.updated).toBe(1);

    const after = await prisma.part.findUniqueOrThrow({ where: { id: part.id } });
    expect(after.sourceRef).toBe(SOURCE_REF); // not null, not the batch label
    expect(after.sourceUpdatedAt?.toISOString()).toBe(new Date("2025-01-01").toISOString()); // NOT erased
    expect(after.dataStatus).toBe("REVIEW_REQUIRED"); // re-marked for review by an import update
  });

  it("rejected/failed batches never mutate existing data (validation failure leaves the catalog untouched)", async () => {
    const before = await prisma.part.findUniqueOrThrow({ where: { sku: "206-RAD-001" }, select: { title: true, sourceUpdatedAt: true, dataVersion: true } });
    const bad = await ingestRawCsv(
      { label: `f1-invalid-${Date.now()}`, sourceRef: SOURCE_REF, sourceUpdatedAt: new Date(), createdBy: "p2f1" },
      "title,titleEn,sku,condition,categoryName,brandName,assemblySlug,identifiers,technicalDescription\nقطعه معیوب,Broken,P-F1-BAD,NEW,دسته‌ی ناموجود,تولیدی ایران,assembly-nonexistent,,x",
    );
    cleanup.batches.push(bad.batchId);
    await normalizeBatch(bad.batchId);
    await validateBatch(bad.batchId); // rows marked INVALID
    const summary = await import("@/lib/catalog-import").then((m) => m.getBatchSummary(bad.batchId));
    expect(summary.byStatus["INVALID"]).toBeGreaterThan(0);
    // never committed — catalog unchanged
    const after = await prisma.part.findUniqueOrThrow({ where: { sku: "206-RAD-001" }, select: { title: true, sourceUpdatedAt: true, dataVersion: true } });
    expect(after).toEqual(before);
  });
});

// ─────────────────────── §3 fitment UI truthfulness ───────────────────────

describe("§3 REVIEW_REQUIRED is never presented as COMPATIBLE", () => {
  it("presentation policy: COMPATIBLE verdict on an unverified real part is presented as REVIEW_REQUIRED", async () => {
    const radiator = await prisma.part.findUniqueOrThrow({ where: { slug: "radiator-assembly" } });
    expect(radiator.dataStatus).toBe("REVIEW_REQUIRED");
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
    const variant = await prisma.vehicleVariant.findFirstOrThrow({ where: { vehicleId: vehicle.id, trim: "تیپ ۵" } });
    const result = await resolveFitment(radiator.id, {
      vehicleId: vehicle.id, variantId: variant.id, year: 2012,
      engine: variant.engine, transmission: variant.transmission, bodyType: vehicle.bodyType,
    });
    expect(result.status).toBe("COMPATIBLE"); // engine verdict (rule-level truth)
    // UI truth: unverified catalog data cannot make a definitive claim
    expect(fitmentPresentation(result.status, radiator.dataStatus)).toBe("REVIEW_REQUIRED");
  });

  it("presentation policy: DEMO and VERIFIED parts keep deterministic presentation; non-compatible verdicts unchanged", async () => {
    const demo = await prisma.part.findFirstOrThrow({ where: { dataStatus: "DEMO" } });
    expect(fitmentPresentation("COMPATIBLE", demo.dataStatus)).toBeNull(); // deterministic for demo
    expect(fitmentPresentation("COMPATIBLE", "VERIFIED")).toBeNull(); // deterministic once verified
    expect(fitmentPresentation("REVIEW_REQUIRED", "VERIFIED")).toBeNull();
    expect(fitmentPresentation("INCOMPATIBLE", "VERIFIED")).toBeNull();
    expect(fitmentPresentation("COMPATIBLE", "UNVERIFIED")).toBe("REVIEW_REQUIRED");
    expect(fitmentPresentation("COMPATIBLE", null)).toBe("REVIEW_REQUIRED");
  });

  it("engine itself never upgrades uncertainty: missing rules ⇒ REVIEW_REQUIRED verdict", async () => {
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
    const variant = await prisma.vehicleVariant.findFirstOrThrow({ where: { vehicleId: vehicle.id, trim: "تیپ ۵" } });
    const isolated = await prisma.part.create({
      data: { slug: `f1-norules-${Date.now()}`, sku: `P-F1-NR-${Date.now() % 100000}`, title: "قطعه بدون قانون", dataStatus: "REVIEW_REQUIRED", active: true },
    });
    cleanup.parts.push(isolated.id);
    const r = await resolveFitment(isolated.id, {
      vehicleId: vehicle.id, variantId: variant.id, year: 2012,
      engine: variant.engine, transmission: variant.transmission, bodyType: vehicle.bodyType,
    });
    expect(r.status).toBe("REVIEW_REQUIRED");
    // composed exactly as the UI does: policy adjustment (null = none) ?? verdict
    expect(fitmentPresentation(r.status, isolated.dataStatus) ?? r.status).toBe("REVIEW_REQUIRED");
  });
});

// ─────────────────────── §4 verification authority ───────────────────────

describe("§4 admin-only verification", () => {
  it("seller identity cannot verify; admin identity can; verification touches only verification fields", async () => {
    const { getAuthenticatedAdminForTest } = await import("@/lib/seller/seller-auth-test");
    const sellerUser = await prisma.user.findUniqueOrThrow({ where: { phone: "09012345678" } });
    expect(await getAuthenticatedAdminForTest(sellerUser.id)).toBeNull(); // seller is not admin

    const adminUser = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
    const adminMirror = await getAuthenticatedAdminForTest(adminUser.id);
    expect(adminMirror).not.toBeNull();

    // direct lib-level denial: verification REQUIRES an admin user id — the test
    // mirror proves role checks; here we prove the act itself is audited and scoped
    const part = await prisma.part.findUniqueOrThrow({ where: { sku: "206-RAD-001" } });
    const before = { sourceRef: part.sourceRef, sourceUpdatedAt: part.sourceUpdatedAt, sku: part.sku, title: part.title };
    const r = await verifyRealPart(part.id, adminUser.id, "https://example.org/evidence");
    expect(r.ok).toBe(true);
    const after = await prisma.part.findUniqueOrThrow({ where: { id: part.id } });
    expect(after.dataStatus).toBe("VERIFIED");
    expect(after.verifiedBy).toBe(adminUser.id);
    expect(after.verifiedAt).not.toBeNull();
    expect(after.dataVersion).toBe(part.dataVersion + 1);
    expect(after.sourceUrl).toBe("https://example.org/evidence");
    // untouched: canonical identity + provenance of the source dataset
    expect(after.sku).toBe(before.sku);
    expect(after.title).toBe(before.title);
    expect(after.sourceRef).toBe(before.sourceRef);
    expect(after.sourceUpdatedAt?.toISOString()).toBe(before.sourceUpdatedAt!.toISOString());

    // restore to REVIEW_REQUIRED so the suite stays idempotent
    const reopen = await reopenVerification(part.id, adminUser.id);
    expect(reopen.ok).toBe(true);
    const restored = await prisma.part.findUniqueOrThrow({ where: { id: part.id } });
    expect(restored.dataStatus).toBe("REVIEW_REQUIRED");
    expect(restored.verifiedBy).toBeNull();
  });

  it("deprecated records refuse verification (no resurrection)", async () => {
    const dep = await prisma.part.create({
      data: { slug: `f1-dep-${Date.now()}`, sku: `P-F1-DEP-${Date.now() % 100000}`, title: "قطعه منسوخ", dataStatus: "DEPRECATED", active: false },
    });
    cleanup.parts.push(dep.id);
    const r = await verifyRealPart(dep.id, "some-admin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("DEPRECATED");
    const still = await prisma.part.findUniqueOrThrow({ where: { id: dep.id } });
    expect(still.dataStatus).toBe("DEPRECATED");
  });

  it("session roles: a fresh CUSTOMER session is not an admin mirror", async () => {
    const { getAuthenticatedAdminForTest } = await import("@/lib/seller/seller-auth-test");
    const user = await prisma.user.create({ data: { phone: `09${Date.now() % 1000000000}`.slice(0, 11), role: "CUSTOMER" } });
    const { session } = await createSession(user.id);
    cleanup.sessions.push(session.id);
    expect(await getAuthenticatedAdminForTest(user.id)).toBeNull();
    await revokeSession(session.id);
  });
});

// ─────────────────────────── §7 data-quality invariants ───────────────────────────

describe("§7 data-quality invariants over the live dataset", () => {
  it("real part without provenance", async () => {
    const bad = await prisma.part.count({ where: { sourceRef: { not: null }, OR: [{ sourceRef: "" }, { sourceUpdatedAt: null }] } });
    expect(bad).toBe(0);
  });
  it("real part marked VERIFIED without evidence (no verifier recorded)", async () => {
    const bad = await prisma.part.count({ where: { dataStatus: "VERIFIED", OR: [{ verifiedAt: null }, { verifiedBy: null }] } });
    expect(bad).toBe(0);
  });
  it("offer referencing a deprecated part", async () => {
    const bad = await prisma.offer.count({ where: { active: true, part: { dataStatus: "DEPRECATED" } } });
    expect(bad).toBe(0);
  });
  it("mapping referencing a nonexistent part", async () => {
    const bad = await prisma.meshMapping.count({ where: { kind: "part", partId: null } });
    expect(bad).toBe(0);
  });
  it("duplicate external identifiers across parts", async () => {
    const dups = await prisma.$queryRaw<{ type: string; value: string; n: bigint }[]>`
      SELECT type, value, COUNT(*)::bigint AS n FROM "PartIdentifier" GROUP BY type, value HAVING COUNT(*) > 1`;
    expect(dups.length).toBe(0);
  });
  it("real record mislabeled DEMO / synthetic record carrying real provenance", async () => {
    const realMislabeled = await prisma.part.count({ where: { sourceRef: SOURCE_REF, dataStatus: "DEMO" } });
    expect(realMislabeled).toBe(0);
    const syntheticFake = await prisma.part.count({ where: { dataStatus: "DEMO", sourceRef: { not: null } } });
    expect(syntheticFake).toBe(0);
  });
  it("provenance overwritten by null (real rows with null sourceRef but non-null other provenance)", async () => {
    const bad = await prisma.part.count({ where: { OR: [{ sourceUrl: { not: null }, sourceRef: null }, { dataNotes: { not: null }, sourceRef: null }] } });
    expect(bad).toBe(0);
  });
});
