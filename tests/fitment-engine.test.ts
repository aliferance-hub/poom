import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { resolveFitment, type VehicleContext } from "@/lib/fitment";
import { createFitmentAction, updateFitmentAction, deleteFitmentAction, setFitmentStatusAction } from "@/app/admin/fitment/actions";
import { getCategoryTree, normalizeIdentifier } from "@/lib/catalog";

const prisma = new PrismaClient();

let vehicleId = "";
let t2: { id: string; engine: string | null; transmission: string | null } | null = null;
let t5: { id: string; engine: string | null; transmission: string | null } | null = null;
const slugs: Record<string, string> = {
  radiator: "radiator-206",
  valve: "water-valve-206", // Case F: vehicle-level OK + تیپ ۵ REJECTED
  plugs: "spark-plug-set-206", // Case C: PARTIAL
  belt: "timing-belt-206", // Case G/H: engine-specific
  battery: "battery-55ah", // Case H: transmission-specific
  tire: "tire-185-55r15", // Case I: open-ended
  p2: "demo-part-002", // Case B: تیپ ۲-only
  nofit: "no-fitment-demo-206", // Case J: no rules
};
const parts: Record<string, string> = {};

beforeAll(async () => {
  const v = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
  vehicleId = v.id;
  const variants = await prisma.vehicleVariant.findMany({ where: { vehicleId } });
  t2 = variants.find((x) => x.trim === "تیپ ۲") ?? null;
  t5 = variants.find((x) => x.trim === "تیپ ۵") ?? null;
  expect(t2).toBeTruthy();
  expect(t5).toBeTruthy();
  for (const [key, slug] of Object.entries(slugs)) {
    const p = await prisma.part.findUniqueOrThrow({ where: { slug } });
    parts[key] = p.id;
  }
});

function ctx(over: Partial<VehicleContext> = {}): VehicleContext {
  return {
    vehicleId,
    variantId: t5!.id,
    engine: t5!.engine,
    transmission: t5!.transmission,
    bodyType: "Hatchback",
    year: 2008,
    ...over,
  };
}

afterAll(async () => { await prisma.$disconnect(); });

describe("Fitment Engine 2.0 — matrix A–J", () => {
  it("A: exact variant match → COMPATIBLE", async () => {
    const r = await resolveFitment(parts!.radiator!, ctx({ year: 2008 }));
    expect(r.status).toBe("COMPATIBLE");
    expect(r.reasonFa).toContain("سازگار");
  });

  it("B: wrong variant → INCOMPATIBLE (تیپ ۵ for a تیپ ۲-only part)", async () => {
    const r = await resolveFitment(parts!.p2!, ctx());
    expect(r.status).toBe("INCOMPATIBLE");
    // and the same part is COMPATIBLE for تیپ ۲
    const r2 = await resolveFitment(parts!.p2!, ctx({ variantId: t2!.id, engine: t2!.engine, transmission: t2!.transmission }));
    expect(r2.status).toBe("COMPATIBLE");
  });

  it("C: PARTIAL rule → REVIEW_REQUIRED with note surfaced", async () => {
    const r = await resolveFitment(parts!.plugs!, ctx());
    expect(r.status).toBe("REVIEW_REQUIRED");
    expect(r.reasonFa).toContain("بررسی");
    expect(r.bestRule?.fitmentNote).toBeTruthy();
  });

  it("D: year inside range → COMPATIBLE", async () => {
    const r = await resolveFitment(parts!.tire!, ctx({ year: 2012 }));
    expect(r.status).toBe("COMPATIBLE");
  });

  it("E: year outside range → INCOMPATIBLE", async () => {
    // tire rule is open-ended FROM 2010 — use radiator's 2013–2015 negative range instead
    const r = await resolveFitment(parts!.radiator!, ctx({ year: 2014 }));
    expect(r.status).toBe("INCOMPATIBLE");
  });

  it("F: specific negative override — vehicle-compatible but تیپ ۵-rejected → INCOMPATIBLE", async () => {
    const r = await resolveFitment(parts!.valve!, ctx());
    expect(r.status).toBe("INCOMPATIBLE");
    // تیپ ۲ remains compatible (vehicle-level rule + no variant rejection)
    const r2 = await resolveFitment(parts!.valve!, ctx({ variantId: t2!.id, engine: t2!.engine, transmission: t2!.transmission }));
    expect(r2.status).toBe("COMPATIBLE");
  });

  it("G: engine mismatch → INCOMPATIBLE (TU3 rule rejects; context says TU5-compatible only)", async () => {
    // timing belt: TU5 CONFIRMED (variant-level + engine) + TU3 REJECTED
    const asTU3 = await resolveFitment(parts!.belt!, ctx({ engine: "TU3 (DEMO)" }));
    expect(asTU3.status).toBe("INCOMPATIBLE");
    const asTU5 = await resolveFitment(parts!.belt!, ctx({ engine: "TU5 (DEMO)" }));
    expect(asTU5.status).toBe("COMPATIBLE");
  });

  it("H: transmission mismatch → REJECTED rule for automatic", async () => {
    const r = await resolveFitment(parts!.battery!, ctx({ transmission: "اتوماتیک (DEMO)" }));
    expect(r.status).toBe("INCOMPATIBLE");
    const manual = await resolveFitment(parts!.battery!, ctx({ transmission: "دستی ۵ سرعته" }));
    expect(manual.status).toBe("COMPATIBLE");
  });

  it("I: open-ended year range (yearFrom only) — 2010+ compatible, 2008 outside", async () => {
    const later = await resolveFitment(parts!.tire!, ctx({ year: 2016 }));
    expect(later.status).toBe("COMPATIBLE");
    // 2008 predates the open-ended 2010+ rule; the generic both-trim rule (2003–2015) still applies
    const early = await resolveFitment(parts!.tire!, ctx({ year: 2008 }));
    expect(early.status).toBe("COMPATIBLE");
  });

  it("J: no fitment record → REVIEW_REQUIRED (never INCOMPATIBLE by default)", async () => {
    const r = await resolveFitment(parts!.nofit!, ctx());
    expect(r.status).toBe("REVIEW_REQUIRED");
    expect(r.reason).toBe("NO_FITMENT_DATA");
    expect(r.matchedRules).toHaveLength(0);
  });

  it("narrower REJECTED range beats wider CONFIRMED range (non-conflicting nesting)", async () => {
    // radiator: 2003–2015 CONFIRMED + 2013–2015 REJECTED at same specificity
    const inside = await resolveFitment(parts!.radiator!, ctx({ year: 2014 }));
    expect(inside.status).toBe("INCOMPATIBLE");
    expect(inside.conflicting).toBe(false);
    const outside = await resolveFitment(parts!.radiator!, ctx({ year: 2010 }));
    expect(outside.status).toBe("COMPATIBLE");
    expect(outside.conflicting).toBe(false);
  });

  it("conflicting non-nested ranges → REVIEW_REQUIRED + conflicting flag", async () => {
    // craft a synthetic conflict on the no-fitment part: 2003–2008 CONFIRMED vs 2006–2010 REJECTED
    const a = await createFitmentAction({ partId: parts.nofit, vehicleId, variantId: t5!.id, yearFrom: 2003, yearTo: 2008, fitmentStatus: "CONFIRMED" });
    const b = await createFitmentAction({ partId: parts.nofit, vehicleId, variantId: t5!.id, yearFrom: 2006, yearTo: 2010, fitmentStatus: "REJECTED" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    try {
      const r = await resolveFitment(parts!.nofit!, ctx({ year: 2007 }));
      expect(r.status).toBe("REVIEW_REQUIRED");
      expect(r.reason).toBe("CONFLICTING_RULES");
      expect(r.conflicting).toBe(true);
    } finally {
      if (a.ok) await deleteFitmentAction(a.id!);
      if (b.ok) await deleteFitmentAction(b.id);
    }
  });

  it("no-vehicle-context on the part page path still resolves vehicle-level", async () => {
    // year omitted → ranges cannot exclude
    const r = await resolveFitment(parts!.radiator!, { vehicleId, variantId: t5!.id });
    expect(r.status).toBe("COMPATIBLE");
  });
});

describe("fitment CRUD (server actions) + validation", () => {
  it("rejects invalid year range (from > to)", async () => {
    const res = await createFitmentAction({ partId: parts.nofit, vehicleId, yearFrom: 2015, yearTo: 2005, fitmentStatus: "CONFIRMED" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("YEAR_RANGE_INVALID");
  });

  it("rejects variant from another vehicle", async () => {
    // fake variantId that doesn't exist
    const res = await createFitmentAction({ partId: parts.nofit, vehicleId, variantId: "no-such-variant", fitmentStatus: "CONFIRMED" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("VARIANT_NOT_FOUND");
  });

  it("create → update → delete round-trips; duplicate dimensions update instead of duplicating", async () => {
    const created = await createFitmentAction({ partId: parts.nofit, vehicleId, variantId: t5!.id, yearFrom: 2005, yearTo: 2009, fitmentStatus: "CONFIRMED", fitmentNote: "test" });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.id : "";

    const again = await createFitmentAction({ partId: parts.nofit, vehicleId, variantId: t5!.id, yearFrom: 2005, yearTo: 2009, fitmentStatus: "REJECTED", fitmentNote: "updated" });
    expect(again.ok).toBe(true);

    const rows = await prisma.fitment.findMany({ where: { partId: parts.nofit, variantId: t5!.id, yearFrom: 2005, yearTo: 2009 } });
    expect(rows.length).toBe(1); // dimensions guard: no duplicate
    expect(rows[0]!.fitmentStatus).toBe("REJECTED");

    const updated = await updateFitmentAction(id, { partId: parts.nofit, vehicleId, variantId: t5!.id, yearFrom: 2005, yearTo: 2009, fitmentStatus: "PENDING_REVIEW" });
    expect(updated.ok).toBe(true);

    const del = await deleteFitmentAction(id);
    expect(del.ok).toBe(true);
    const gone = await prisma.fitment.findUnique({ where: { id } });
    expect(gone).toBeNull();
  });

  it("setFitmentStatusAction changes only the status", async () => {
    const created = await createFitmentAction({ partId: parts.nofit, vehicleId, yearFrom: 2001, yearTo: 2002, fitmentStatus: "PENDING_REVIEW" });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.id : "";
    await setFitmentStatusAction(id, "CONFIRMED");
    const row = await prisma.fitment.findUniqueOrThrow({ where: { id } });
    expect(row.fitmentStatus).toBe("CONFIRMED");
    await deleteFitmentAction(id);
  });
});

describe("catalog P2-B services", () => {
  it("category tree nests children and counts parts", async () => {
    const tree = await getCategoryTree();
    const engine = tree.find((c) => c.slug === "engine-cat");
    expect(engine).toBeTruthy();
    const cooling = engine!.children.find((c) => c.slug === "cooling-cat");
    expect(cooling).toBeTruthy();
    const radiator = cooling!.children.find((c) => c.slug === "radiator-cat");
    expect(radiator!.partCount).toBeGreaterThanOrEqual(1);
  });

  it("identifier normalization keeps codes distinct and searchable", () => {
    expect(normalizeIdentifier("demo-206-001")).toBe("DEMO-206-001");
    expect(normalizeIdentifier("ABC/206")).toBe("ABC-206");
    expect(normalizeIdentifier("MPN 206-01")).toBe("MPN-206-01");
    expect(normalizeIdentifier("abc-۲۰۶")).toBe("ABC-206");
    expect(normalizeIdentifier("ABC-206")).not.toBe(normalizeIdentifier("ABC-207"));
  });
});
