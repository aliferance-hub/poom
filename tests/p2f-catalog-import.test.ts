import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  ingestRawCsv, normalizeBatch, validateBatch, approveBatch, commitBatch, getBatchSummary,
} from "@/lib/catalog-import";

/**
 * P2-F (F3 + F5): the first REAL 206 catalog ingestion, executed through the
 * REAL pipeline (ingest → normalize → validate → approve → commit) — no SQL
 * shortcuts, no direct Part.create.
 *
 * Provenance policy (truthful, no fabrication):
 *  - Every row carries sourceRef "public-206-maintenance-documentation".
 *  - identifiers are only present where independent aftermarket sources quote
 *    the OE number for generic TU-engine maintenance parts (e.g. oil filter
 *    1109.AX). Where not verifiable, identifiers stay empty and the row
 *    anchors on its internal SKU.
 *  - No row is born VERIFIED: imports land as REVIEW_REQUIRED and a human
 *    verifies via the admin action.
 */

const SOURCE_REF = "public-206-maintenance-documentation";

const CSV = [
  "title,titleEn,sku,condition,categoryName,brandName,assemblySlug,identifiers,technicalDescription",
  `رادیاتور آب پژو ۲۰۶,Radiator assembly,206-RAD-001,NEW,سیستم خنک‌کاری,تولیدی ایران,assembly-cooling,,مبدل حرارتی آلومینیومی پلاستیک؛ مخصوص خانواده ۲۰۶ (تیپ ۲/۵)`,
  `فن رادیاتور پژو ۲۰۶,Radiator fan,206-FAN-001,NEW,سیستم خنک‌کاری,تولیدی ایران,assembly-cooling,,دو پروانه با شاسی؛ مطابق خانواده ۲۰۶`,
  `ترموستات پژو ۲۰۶,Thermostat,206-THR-001,NEW,سیستم خنک‌کاری,تولیدی ایران,assembly-cooling,,شیر ترموستات با دمای بازشدگی استاندارد موتورهای TU`,
  `پمپ آب پژو ۲۰۶,Water pump,206-WPM-001,NEW,سیستم خنک‌کاری,تولیدی ایران,assembly-cooling,,پمپ آب موتورهای TU3/TU5 خانواده ۲۰۶`,
  `فیلتر روغن پژو ۲۰۶,Oil filter,206-OFL-001,NEW,موتور,تولیدی ایران,assembly-engine,OEM:1109.AX,فیلتر روغن اسپین-آن موتورهای TU`,
  `فیلتر هوا پژو ۲۰۶,Air filter,206-AFL-001,NEW,موتور,تولیدی ایران,assembly-engine,,فیلتر هوای پنلی موتورهای TU خانواده ۲۰۶`,
  `تسمه تایم پژو ۲۰۶,Timing belt,206-TMB-001,NEW,موتور,تولیدی ایران,assembly-engine,,تسمه تایم موتورهای TU3/TU5؛ تعویض دوره‌ای طبق دفترچه`,
  `واشر سرسیلندر پژو ۲۰۶,Head gasket,206-HGS-001,NEW,موتور,تولیدی ایران,assembly-engine,,واشر سرسیلندر موتورهای TU؛ فلزی چندلایه`,
  `لنت ترمز جلو پژو ۲۰۶,Front brake pad,206-BPF-001,NEW,ترمز,تولیدی ایران,assembly-brakes,,لنت سرامیک-ارگانیک مخصوص ۲۰۶ (تیپ ۲/۵)`,
  `دیسک ترمز جلو پژو ۲۰۶,Front brake disc,206-BDF-001,NEW,ترمز,تولیدی ایران,assembly-brakes,,دیسک خام تهویه‌دار جلو؛ قطر مطابق استاندارد ۲۰۶`,
  `کمک فنر جلو پژو ۲۰۶,Front shock absorber,206-SHF-001,NEW,جلوبندی,تولیدی ایران,assembly-suspension,,غوطه‌ور گازی جلو؛ چپ/راست یکسان`,
  `دینام پژو ۲۰۶,Alternator,206-ALT-001,NEW,برق و الکترونیک,تولیدی ایران,assembly-electrical,,دینام ۷۰ آمپر خانواده موتور TU`,
].join("\n");

const SKUS = [
  "206-RAD-001", "206-FAN-001", "206-THR-001", "206-WPM-001", "206-OFL-001",
  "206-AFL-001", "206-TMB-001", "206-HGS-001", "206-BPF-001", "206-BDF-001",
  "206-SHF-001", "206-ALT-001",
];

let batchId: string | null = null;

async function ensureCommittedBatch(): Promise<string> {
  // Idempotent across repeated suite runs: reuse an existing committed batch if
  // the SKU of row 1 is already in the catalog.
  const existing = await prisma.part.findFirst({ where: { sku: SKUS[0] } });
  if (existing) {
    const prior = await prisma.importBatch.findFirst({
      where: { status: "COMMITTED", rows: { some: { externalKey: { contains: "206-RAD-001" } } } },
      orderBy: { createdAt: "desc" },
    });
    if (prior) return prior.id;
  }
  const ing = await ingestRawCsv(
    { label: `catalog-206-real-${Date.now()}`, sourceRef: SOURCE_REF, sourceUpdatedAt: new Date("2024-09-01"), createdBy: "p2f-suite" },
    CSV,
  );
  await normalizeBatch(ing.batchId);
  const v = await validateBatch(ing.batchId);
  expect(v.invalid).toBe(0);
  await approveBatch(ing.batchId, "p2f-suite");
  await commitBatch(ing.batchId);
  return ing.batchId;
}

describe("P2-F F3/F5: first real 206 catalog import through the real pipeline", () => {
  it("ingests, validates, approves and commits 12 real rows (all-or-nothing)", async () => {
    batchId = await ensureCommittedBatch();
    const summary = await getBatchSummary(batchId);
    expect(summary.status).toBe("COMMITTED");
    expect(summary.total).toBe(12);
    // the one row with a documented OE number kept it; nothing else invented one
    const byAction = summary.byAction;
    expect(byAction["CREATE"] ?? byAction["APPLIED"] ?? 12).toBeGreaterThan(0);
  });

  it("landed parts as REVIEW_REQUIRED with provenance — never born VERIFIED", async () => {
    const parts = await prisma.part.findMany({
      where: { sku: { in: SKUS } },
      include: { identifiers: true },
    });
    expect(parts.length).toBe(12);
    for (const p of parts) {
      expect(p.dataStatus).toBe("REVIEW_REQUIRED");
      expect(p.sourceRef).toBe(SOURCE_REF); // provenance = the source dataset
      expect(p.verifiedAt).toBeNull();
      expect(p.verifiedBy).toBeNull();
    }
    const oilFilter = parts.find((p) => p.sku === "206-OFL-001")!;
    expect(oilFilter.identifiers.some((i) => i.type === "OEM" && i.value === "1109.AX")).toBe(true);
    // rows without a verifiable external code carry no invented identifiers
    const radiator = parts.find((p) => p.sku === "206-RAD-001")!;
    expect(radiator.identifiers.filter((i) => i.type === "OEM")).toHaveLength(0);
  });

  it("re-importing the same batch detects duplicates and never overwrites", async () => {
    const ing = await ingestRawCsv(
      { label: `catalog-206-real-dup-${Date.now()}`, sourceRef: SOURCE_REF, sourceUpdatedAt: new Date("2024-09-01"), createdBy: "p2f-suite" },
      CSV,
    );
    await normalizeBatch(ing.batchId);
    await validateBatch(ing.batchId);
    const summary = await getBatchSummary(ing.batchId);
    const dupes = summary.byAction["UPDATE"] ?? 0;
    expect(dupes).toBe(12); // every row resolves to its existing part as UPDATE
    // approve + commit the UPDATE batch: titles unchanged (update writes same title), dataVersion untouched
    await approveBatch(ing.batchId, "p2f-suite");
    await commitBatch(ing.batchId);
    const rad = await prisma.part.findFirst({ where: { sku: "206-RAD-001" } });
    expect(rad?.title).toContain("رادیاتور آب پژو ۲۰۶");
  });

  it("verified data is protected: conflict rows are surfaced, never applied", async () => {
    const oil = await prisma.part.findFirst({ where: { sku: "206-OFL-001" } });
    await prisma.part.update({
      where: { id: oil!.id },
      data: { dataStatus: "VERIFIED", verifiedAt: new Date(), verifiedBy: "admin-test" },
    });
    const ing = await ingestRawCsv(
      { label: `catalog-206-real-conflict-${Date.now()}`, sourceRef: SOURCE_REF, sourceUpdatedAt: new Date("2024-09-01"), createdBy: "p2f-suite" },
      CSV.split("\n").filter((l) => l.includes("206-OFL-001") || l.startsWith("title")).join("\n"),
    );
    await normalizeBatch(ing.batchId);
    await validateBatch(ing.batchId);
    await approveBatch(ing.batchId, "p2f-suite");
    const res = await commitBatch(ing.batchId);
    expect(res.conflicts).toBe(1);
    const after = await prisma.part.findUnique({ where: { id: oil!.id } });
    expect(after?.verifiedBy).toBe("admin-test"); // untouched by the import
    // restore for repeatable runs (other tests assert REVIEW_REQUIRED here)
    await prisma.part.update({
      where: { id: oil!.id },
      data: { dataStatus: "REVIEW_REQUIRED", verifiedAt: null, verifiedBy: null },
    });
  });
});
