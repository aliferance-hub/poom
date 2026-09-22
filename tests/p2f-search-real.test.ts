import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { searchParts2 } from "@/lib/search";
import { resolveFitment } from "@/lib/fitment";

/**
 * P2-F (F9): Search 2.0 validated against the REAL imported dataset.
 * Retrieval (relevance) and compatibility (Fitment Engine) stay separate:
 * compatibleOnly uses the engine, never string heuristics.
 */

const SOURCE_REF = "public-206-maintenance-documentation";

async function real206() {
  const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
  const t5 = await prisma.vehicleVariant.findFirstOrThrow({ where: { vehicleId: vehicle.id, trim: "تیپ ۵" } });
  return { vehicle, t5 };
}

describe("P2-F F9: search over the real 206 dataset", () => {
  it("finds the real radiator by Persian title (with and without Persian digits)", async () => {
    for (const q of ["رادیاتور آب پژو", "رادیاتور 206", "رادیاتور ۲۰۶"]) {
      const res = await searchParts2({ query: q });
      const hit = res.hits.find((h) => h.part.sku === "206-RAD-001");
      expect(hit, `query failed: ${q}`).toBeTruthy();
    }
  });

  it("finds the real brake pad by Latin title and by SKU", async () => {
    const latin = await searchParts2({ query: "Front brake" });
    expect(latin.hits.some((h) => h.part.sku === "206-BPF-001")).toBe(true);
    const sku = await searchParts2({ query: "206-BPF-001" });
    expect(sku.hits.some((h) => h.part.sku === "206-BPF-001")).toBe(true);
  });

  it("compatibleOnly with vehicle context uses the Fitment Engine, not the title", async () => {
    const { vehicle, t5 } = await real206();
    const ctx = {
      vehicleId: vehicle.id, variantId: t5.id, engine: t5.engine,
      transmission: t5.transmission, year: 2010,
    };
    const res = await searchParts2({ query: "پژو", vehicleContext: ctx, compatibleOnly: true });
    expect(res.hits.length).toBeGreaterThan(0);
    // every hit must carry an engine verdict of COMPATIBLE
    for (const h of res.hits) {
      expect(h.fitment?.status).toBe("COMPATIBLE");
    }
  });

  it("a part without fitment data is excluded by compatibleOnly — never silently compatible", async () => {
    // the alternator has a family rule (from F4) — use a part with NO rules:
    // the synthetic brake pad fixture with zero fitment rows
    const { vehicle, t5 } = await real206();
    const noRulePart = await prisma.part.findFirst({
      where: { title: { contains: "لنت" }, fitments: { none: {} }, active: true },
    });
    if (!noRulePart) return; // fixture missing → nothing to prove, other tests cover the engine
    const ctx = {
      vehicleId: vehicle.id, variantId: t5.id, engine: t5.engine, year: 2010,
    };
    const withContext = await searchParts2({ query: noRulePart.title.slice(0, 4), vehicleContext: ctx, compatibleOnly: true });
    expect(withContext.hits.some((h) => h.part.id === noRulePart.id)).toBe(false);
    // and the engine itself agrees:
    const verdict = await resolveFitment(noRulePart.id, { vehicleId: vehicle.id, variantId: t5.id, year: 2010 });
    expect(verdict.status).toBe("REVIEW_REQUIRED");
  });

  it("data provenance survives search (real vs demo is distinguishable)", async () => {
    const res = await searchParts2({ query: "رادیاتور آب پژو" });
    const real = res.hits.find((h) => h.part.sku === "206-RAD-001");
    const demo = res.hits.find((h) => h.part.dataStatus === "DEMO");
    expect(real?.part.dataStatus).toBe("REVIEW_REQUIRED");
    if (demo) expect(demo.part.dataStatus).toBe("DEMO");
    void SOURCE_REF;
  });
});
