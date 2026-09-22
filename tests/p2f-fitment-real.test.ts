import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { resolveFitment, type VehicleContext } from "@/lib/fitment";

/**
 * P2-F (F4): fitment for the first REAL catalog rows — resolved exclusively
 * through the central Fitment Engine (P2-B), no second algorithm.
 *
 * Provenance policy: rules encode ONLY documented compatibility.
 *  - Family-wide maintenance parts (radiator, filters, pads, …) get ONE
 *    vehicle-level CONFIRMED rule, note = source reference.
 *  - Head gasket is engine-specific in public documentation (TU3 1.4 vs
 *    TU5 1.6 use different gaskets): variant-scoped CONFIRMED for تیپ ۲ (TU3)
 *    and an explicit REJECTED rule for تیپ ۵ (TU5) — a real negative fitment.
 *  - No year or transmission constraints are invented (not verifiable here).
 */

const SRC = "public-206-maintenance-documentation";

let ready = false;
async function ensureRules() {
  if (ready) return;
  const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
  const variants = await prisma.vehicleVariant.findMany({ where: { vehicleId: vehicle.id } });
  const t2 = variants.find((v) => v.trim === "تیپ ۲");
  const t5 = variants.find((v) => v.trim === "تیپ ۵");
  if (!t2 || !t5) throw new Error("206 variants missing — seed first");

  const skus = [
    "206-RAD-001", "206-FAN-001", "206-THR-001", "206-WPM-001", "206-OFL-001",
    "206-AFL-001", "206-TMB-001", "206-BPF-001", "206-BDF-001", "206-SHF-001",
    "206-ALT-001",
  ];
  const familyParts = await prisma.part.findMany({ where: { sku: { in: skus } } });
  for (const p of familyParts) {
    const exists = await prisma.fitment.findFirst({
      where: { partId: p.id, vehicleId: vehicle.id, variantId: null, yearFrom: null, yearTo: null, engine: null, transmission: null, bodyType: null },
    });
    if (!exists) {
      await prisma.fitment.create({
        data: { partId: p.id, vehicleId: vehicle.id, fitmentStatus: "CONFIRMED", fitmentNote: SRC },
      });
    }
  }

  // Head gasket: TU3 (تیپ ۲) yes, TU5 (تیپ ۵) explicitly no.
  const hg = await prisma.part.findFirstOrThrow({ where: { sku: "206-HGS-001" } });
  const hgRules = await prisma.fitment.findMany({ where: { partId: hg.id } });
  const hasT2 = hgRules.some((r) => r.variantId === t2.id);
  const hasT5 = hgRules.some((r) => r.variantId === t5.id);
  if (!hasT2) {
    await prisma.fitment.create({
      data: { partId: hg.id, vehicleId: vehicle.id, variantId: t2.id, engine: t2.engine, fitmentStatus: "CONFIRMED", fitmentNote: `${SRC}: TU3 1.4 gasket` },
    });
  }
  if (!hasT5) {
    await prisma.fitment.create({
      data: { partId: hg.id, vehicleId: vehicle.id, variantId: t5.id, engine: t5.engine, fitmentStatus: "REJECTED", fitmentNote: `${SRC}: TU5 1.6 uses a different gasket` },
    });
  }
  ready = true;
}

function ctxOf(vehicleId: string, variantId: string, engine: string | null, year?: number | null): VehicleContext {
  return { vehicleId, variantId, engine, year: year ?? null, transmission: null, bodyType: null };
}

describe("P2-F F4: real-206 fitment through the central engine", () => {
  it("family-wide part is COMPATIBLE for both variants (vehicle-level rule)", async () => {
    await ensureRules();
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
    const variants = await prisma.vehicleVariant.findMany({ where: { vehicleId: vehicle.id } });
    const rad = await prisma.part.findFirstOrThrow({ where: { sku: "206-RAD-001" } });

    for (const v of variants) {
      const res = await resolveFitment(rad.id, ctxOf(vehicle.id, v.id, v.engine, 2010));
      expect(res.status).toBe("COMPATIBLE");
      expect(res.matchedRules.length).toBeGreaterThan(0);
    }
  });

  it("head gasket: CONFIRMED for تیپ ۲ (TU3), explicit INCOMPATIBLE for تیپ ۵ (TU5)", async () => {
    await ensureRules();
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
    const variants = await prisma.vehicleVariant.findMany({ where: { vehicleId: vehicle.id } });
    const t2 = variants.find((v) => v.trim === "تیپ ۲")!;
    const t5 = variants.find((v) => v.trim === "تیپ ۵")!;
    const hg = await prisma.part.findFirstOrThrow({ where: { sku: "206-HGS-001" } });

    const ok = await resolveFitment(hg.id, ctxOf(vehicle.id, t2.id, t2.engine, 2008));
    expect(ok.status).toBe("COMPATIBLE");

    const no = await resolveFitment(hg.id, ctxOf(vehicle.id, t5.id, t5.engine, 2010));
    expect(no.status).toBe("INCOMPATIBLE");
    expect(no.bestRule?.fitmentStatus).toBe("REJECTED");
  });

  it("oil filter (documented OE 1109.AX) resolves COMPATIBLE with engine context", async () => {
    await ensureRules();
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
    const t5 = await prisma.vehicleVariant.findFirstOrThrow({ where: { vehicleId: vehicle.id, trim: "تیپ ۵" } });
    const oil = await prisma.part.findFirstOrThrow({ where: { sku: "206-OFL-001" } });

    const res = await resolveFitment(oil.id, ctxOf(vehicle.id, t5.id, t5.engine, 2012));
    expect(res.status).toBe("COMPATIBLE");
  });

  it("a variant outside every rule stays REVIEW_REQUIRED — missing data never silently fits", async () => {
    // Head gasket + a synthetic third configuration that no rule covers:
    // rules only exist for تیپ ۲/تیپ ۵ of vehicle 206; ask with variant=null
    // and a year — vehicle-level rule for head gasket does not exist, so no
    // rule applies → REVIEW_REQUIRED (never COMPATIBLE).
    await ensureRules();
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
    const hg = await prisma.part.findFirstOrThrow({ where: { sku: "206-HGS-001" } });

    const res = await resolveFitment(hg.id, { vehicleId: vehicle.id, variantId: null, year: null });
    expect(res.status).toBe("REVIEW_REQUIRED");
    expect(res.reason).toBe("NO_FITMENT_DATA");
  });
});
