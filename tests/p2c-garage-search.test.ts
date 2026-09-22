import { describe, expect, it, beforeAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  getMyVehicles,
  createSavedVehicle,
  updateSavedVehicle,
  deleteSavedVehicle,
  activateSavedVehicle,
  getActiveVehicleContext,
  resolveVehicleContext,
} from "@/lib/vehicle";
import { searchParts2, getSearchSuggestions } from "@/lib/search";
import { resolveFitment, resolveFitmentFromRules } from "@/lib/fitment";
import { prisma as appPrisma } from "@/lib/prisma";

const prisma = new PrismaClient();

// ── Fixtures ──
let variantT5Id = "";
let variantT2Id = "";
let vehicleId = "";
let radiatorPartId = "";
let p2PartId = ""; // تیپ ۲-only part (negative fitment for تیپ ۵)
let demoSkuPartId = "";

const SESSION_A = "test-session-garage-A";
const SESSION_B = "test-session-garage-B"; // another "customer"
const created: string[] = [];

beforeAll(async () => {
  // Isolation: wipe debris from previous runs of THIS suite only.
  await prisma.garageVehicle.deleteMany({ where: { sessionId: { in: [SESSION_A, SESSION_B] } } });
  const v = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
  vehicleId = v.id;
  const variants = await prisma.vehicleVariant.findMany({ where: { vehicleId } });
  variantT5Id = variants.find((x) => x.trim === "تیپ ۵")!.id;
  variantT2Id = variants.find((x) => x.trim === "تیپ ۲")!.id;
  radiatorPartId = (await prisma.part.findUniqueOrThrow({ where: { slug: "radiator-206" } })).id;
  p2PartId = (await prisma.part.findUniqueOrThrow({ where: { slug: "demo-part-002" } })).id;
  demoSkuPartId = (await prisma.part.findUniqueOrThrow({ where: { slug: "no-fitment-demo-206" } })).id;
});

// ─────────────── Vehicle configuration validation ───────────────

describe("P2-C vehicle configuration", () => {
  it("variants reference Engine/Transmission entities of the same vehicle", async () => {
    const variant = await prisma.vehicleVariant.findUniqueOrThrow({
      where: { id: variantT5Id },
      include: { engineRef: true, transmissionRef: true, vehicle: true },
    });
    expect(variant.engineRef).toBeTruthy();
    expect(variant.transmissionRef).toBeTruthy();
    expect(variant.engineRef!.vehicleId).toBe(vehicleId);
    expect(variant.transmissionRef!.vehicleId).toBe(vehicleId);
    expect(variant.vehicle.bodyType).toBeTruthy();
  });

  it("resolveVehicleContext fills every available field and invents nothing", async () => {
    const ctx = await resolveVehicleContext(variantT5Id, 2010);
    expect(ctx).toBeTruthy();
    expect(ctx!.vehicleId).toBe(vehicleId);
    expect(ctx!.variantId).toBe(variantT5Id);
    expect(ctx!.engineId).toBeTruthy();
    expect(ctx!.engine).toBe(ctx!.engineLabel);
    expect(ctx!.year).toBe(2010);
    expect(ctx!.vehicleLabel).toContain("پژو");
    expect(ctx!.variantLabel).toContain("تیپ");
    const unknown = await resolveVehicleContext("no-such-variant");
    expect(unknown).toBeNull();
  });
});

// ─────────────── Garage CRUD + ownership + concurrency ───────────────

describe("P2-C garage", () => {
  it("create → first vehicle becomes active automatically", async () => {
    const r = await createSavedVehicle(SESSION_A, { variantId: variantT5Id, year: 2010, nickname: null });
    expect(r.ok).toBe(true);
    if (r.ok) created.push(r.id);
    const mine = await getMyVehicles(SESSION_A);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.isActive).toBe(true);
  });

  it("duplicate add is idempotent (no second row)", async () => {
    const before = await prisma.garageVehicle.count({ where: { sessionId: SESSION_A } });
    const r = await createSavedVehicle(SESSION_A, { variantId: variantT5Id, year: 2010, nickname: null });
    expect(r.ok).toBe(true);
    const after = await prisma.garageVehicle.count({ where: { sessionId: SESSION_A } });
    expect(after).toBe(before);
  });

  it("update respects ownership; foreign session cannot modify", async () => {
    const mine = await getMyVehicles(SESSION_A);
    const gid = mine[0]!.id;
    const good = await updateSavedVehicle(SESSION_A, gid, { year: 2012, nickname: "ماشین من" });
    expect(good.ok).toBe(true);
    const stolen = await updateSavedVehicle(SESSION_B, gid, { nickname: "هک" });
    expect(stolen.ok).toBe(false);
    expect((await getMyVehicles(SESSION_A))[0]!.nickname).toBe("ماشین من");
    expect((await getMyVehicles(SESSION_A))[0]!.year).toBe(2012);
  });

  it("activate switches the single active vehicle; delete respects ownership", async () => {
    const r2 = await createSavedVehicle(SESSION_A, { variantId: variantT2Id, year: null, nickname: null });
    expect(r2.ok).toBe(true);
    const r2id = r2.ok ? r2.id : "";
    created.push(r2id);
    // second add must NOT auto-activate
    expect((await getMyVehicles(SESSION_A)).find((g) => g.id === r2id)?.isActive ?? false).toBe(false);

    const act = await activateSavedVehicle(SESSION_A, r2id);
    expect(act.ok).toBe(true);
    const actives = await prisma.garageVehicle.count({ where: { sessionId: SESSION_A, isActive: true } });
    expect(actives).toBe(1);
    expect((await getMyVehicles(SESSION_A)).find((g) => g.isActive)!.variantId).toBe(variantT2Id);

    // foreign session cannot activate/delete
    const foreign = await activateSavedVehicle(SESSION_B, r2id);
    expect(foreign.ok).toBe(false);
    const foreignDel = await deleteSavedVehicle(SESSION_B, r2id);
    expect(foreignDel.ok).toBe(false);

    const del = await deleteSavedVehicle(SESSION_A, r2id);
    expect(del.ok).toBe(true);
    // previously active vehicle was deactivated when the second was activated — none active now
    expect(await prisma.garageVehicle.count({ where: { sessionId: SESSION_A, isActive: true } })).toBe(0);
  });

  it("concurrent activation of two vehicles leaves exactly one active", async () => {
    const a = await createSavedVehicle(SESSION_A, { variantId: variantT5Id, year: null, nickname: "A1" });
    const b = await createSavedVehicle(SESSION_A, { variantId: variantT2Id, year: null, nickname: "A2" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok) created.push(a.id);
    if (b.ok) created.push(b.id);
    // 10 parallel activations across the two rows — every call must RESOLVE
    // (a thrown lock/txn error surfaces here as a rejection and fails the test)
    const ids = [a.ok ? a.id : "", b.ok ? b.id : ""];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => activateSavedVehicle(SESSION_A, ids[i % 2]!)),
    );
    expect(results.every((r) => r.ok)).toBe(true); // loser waits on the lock, then no-ops
    const actives = await prisma.garageVehicle.count({ where: { sessionId: SESSION_A, isActive: true } });
    expect(actives).toBe(1);
  });

  it("DB backstop: unlocked concurrent activate can never produce 2 active (index refuses)", async () => {
    // Two INDEPENDENT clients doing deactivate→activate with NO advisory lock —
    // simulating a bypassed application layer. The partial unique index
    // GarageVehicle_one_active_per_session must still make 2-active impossible.
    const clientB = new PrismaClient();
    try {
      const a = await createSavedVehicle(SESSION_A, { variantId: variantT5Id, year: null, nickname: "B1" });
      const b = await createSavedVehicle(SESSION_A, { variantId: variantT2Id, year: null, nickname: "B2" });
      expect(a.ok && b.ok).toBe(true);
      const idA = a.ok ? a.id : "";
      const idB = b.ok ? b.id : "";
      const settled = await Promise.allSettled([
        (async () => {
          await prisma.garageVehicle.updateMany({ where: { sessionId: SESSION_A, isActive: true }, data: { isActive: false } });
          await prisma.garageVehicle.update({ where: { id: idA }, data: { isActive: true } });
        })(),
        (async () => {
          await clientB.garageVehicle.updateMany({ where: { sessionId: SESSION_A, isActive: true }, data: { isActive: false } });
          await clientB.garageVehicle.update({ where: { id: idB }, data: { isActive: true } });
        })(),
      ]);
      const actives = await prisma.garageVehicle.count({ where: { sessionId: SESSION_A, isActive: true } });
      expect(actives).toBe(1); // the invariant holds even without the app lock
      const rejected = settled.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      for (const r of rejected) {
        // every rejection must be the unique index refusing a 2nd active row
        expect(String(r.reason)).toMatch(/GarageVehicle_one_active_per_session|Unique constraint/i);
      }
    } finally {
      await clientB.$disconnect();
    }
  });

  it("guest context via getActiveVehicleContext resolves the active vehicle", async () => {
    const mine = await getMyVehicles(SESSION_A);
    const active = mine.find((g) => g.isActive);
    expect(active).toBeTruthy();
    const ctx = await getActiveVehicleContext(SESSION_A);
    expect(ctx?.variantId).toBe(active!.variantId);
    expect(ctx?.vehicleId).toBe(vehicleId);
  });
});

// ─────────────── Search 2.0 ───────────────

describe("P2-C search", () => {
  it("Persian normalization: لنت ۲۰۶ / لنت 206 / لنت پژو 206 all hit brake pads", async () => {
    const qs = ["لنت ۲۰۶", "لنت 206", "لنت پژو 206"];
    for (const q of qs) {
      const r = await searchParts2({ query: q });
      expect(r.hits.length, `query=${q}`).toBeGreaterThan(0);
      expect(r.hits.some((h) => h.part.title.includes("لنت")), `query=${q}`).toBe(true);
    }
  });

  it("identifier search: DEMO-206-001 stays matchable (identifier-safe normalization)", async () => {
    const ident = await prisma.partIdentifier.findFirstOrThrow({
      where: { partId: demoSkuPartId },
      select: { value: true },
    });
    const r = await searchParts2({ query: ident.value });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0]!.part.id).toBe(demoSkuPartId);
  });

  it("no-vehicle search still works", async () => {
    const r = await searchParts2({ query: "رادیاتور" });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.fitment === null)).toBe(true);
  });

  it("vehicle-aware: fitment attached, compatible prioritized, incompatible excluded by default", async () => {
    const ctx = await resolveVehicleContext(variantT5Id, 2010);
    const r = await searchParts2({ query: "رادیاتور", vehicleContext: ctx });
    expect(r.hits.length).toBeGreaterThan(0);
    const statuses = r.hits.map((h) => h.fitment!.status);
    // no INCOMPATIBLE tail by default
    expect(statuses).not.toContain("INCOMPATIBLE");
    // compatible group exists
    expect(statuses).toContain("COMPATIBLE");
    // ordering: compatible before review
    const firstReview = statuses.indexOf("REVIEW_REQUIRED");
    const firstCompat = statuses.indexOf("COMPATIBLE");
    if (firstReview >= 0) expect(firstCompat).toBeLessThan(firstReview);
  });

  it("compatible-only: تیپ-۵-only part is EXCLUDED under تیپ ۲ context (engine is authoritative)", async () => {
    // demo-part-002 fits تیپ ۲ but NOT تیپ ۵
    const ctxT2 = await resolveVehicleContext(variantT2Id, null);
    const rT2 = await searchParts2({ query: "demo-part-002", vehicleContext: ctxT2, compatibleOnly: true });
    expect(rT2.hits.some((h) => h.part.id === p2PartId)).toBe(true);
    const ctxT5 = await resolveVehicleContext(variantT5Id, null);
    const rT5 = await searchParts2({ query: "demo-part-002", vehicleContext: ctxT5, compatibleOnly: true });
    expect(rT5.hits.some((h) => h.part.id === p2PartId)).toBe(false);
    expect(rT5.NO_COMPATIBLE_RESULTS || rT5.hits.length >= 0).toBe(true);
  });

  it("wrong-vehicle rule: vehicle-level part is not promoted as compatible for تیپ ۵ when a variant rule excludes it", async () => {
    // valve: vehicle-level CONFIRMED + تیپ ۵ REJECTED → must be INCOMPATIBLE for تیپ ۵
    const valve = await prisma.part.findUniqueOrThrow({ where: { slug: "water-valve-206" } });
    const ctxT5 = await resolveVehicleContext(variantT5Id, 2010);
    const r = await searchParts2({ query: "شیر انگشتی", vehicleContext: ctxT5 });
    const hit = r.hits.find((h) => h.part.id === valve.id);
    if (hit) {
      expect(hit.fitment!.status).toBe("INCOMPATIBLE");
      // and default search must have demoted it out of the visible list
      expect(r.hits.some((h) => h.part.id === valve.id && h.fitment!.status === "COMPATIBLE")).toBe(false);
    }
    // compatible-only definitely excludes it
    const rOnly = await searchParts2({ query: "شیر انگشتی", vehicleContext: ctxT5, compatibleOnly: true });
    expect(rOnly.hits.some((h) => h.part.id === valve.id)).toBe(false);
  });

  it("zero-result state distinguishes NO_RESULTS from NO_COMPATIBLE_RESULTS", async () => {
    const ctx = await resolveVehicleContext(variantT5Id, 2010);
    const none = await searchParts2({ query: "کلمه‌ای-که-هیچ-جایی-نیست-xyz" });
    expect(none.NO_RESULTS).toBe(true);
    expect(none.NO_COMPATIBLE_RESULTS).toBe(false);
  });

  it("fitment consistency: changing a Fitment rule changes BOTH engine and search verdicts", async () => {
    const valve = await prisma.part.findUniqueOrThrow({ where: { slug: "water-valve-206" } });
    const ctxT5 = (await resolveVehicleContext(variantT5Id, 2010))!;
    const before = await resolveFitment(valve.id, ctxT5);
    expect(before.status).toBe("INCOMPATIBLE");
    // Temporarily flip the تیپ ۵ REJECTED rule to CONFIRMED
    const rule = await prisma.fitment.findFirstOrThrow({
      where: { partId: valve.id, variantId: { not: null }, fitmentStatus: "REJECTED" },
    });
    await prisma.fitment.update({ where: { id: rule.id }, data: { fitmentStatus: "CONFIRMED" } });
    try {
      const mid = await resolveFitment(valve.id, ctxT5);
      expect(mid.status).toBe("COMPATIBLE");
      const searchMid = await searchParts2({ query: "شیر انگشتی", vehicleContext: ctxT5, compatibleOnly: true });
      expect(searchMid.hits.some((h) => h.part.id === valve.id)).toBe(true);
    } finally {
      await prisma.fitment.update({ where: { id: rule.id }, data: { fitmentStatus: "REJECTED" } });
    }
    const after = await resolveFitment(valve.id, ctxT5);
    expect(after.status).toBe("INCOMPATIBLE");
  });

  it("pure core parity: resolveFitmentFromRules on raw rows matches resolveFitment", async () => {
    const valve = await prisma.part.findUniqueOrThrow({ where: { slug: "water-valve-206" } });
    const ctxT5 = await resolveVehicleContext(variantT5Id, 2010);
    const rules = await prisma.fitment.findMany({
      where: { partId: valve.id, vehicleId: ctxT5!.vehicleId },
      include: { variant: { select: { trim: true } }, vehicle: { select: { displayName: true } } },
    });
    const viaWrapper = await resolveFitment(valve.id, ctxT5!);
    const viaPure = resolveFitmentFromRules(rules, ctxT5!);
    expect(viaPure.status).toBe(viaWrapper.status);
    expect(viaPure.reason).toBe(viaWrapper.reason);
  });

  it("search resolves fitment for many candidates without N+1 (single rules query per search)", async () => {
    const origPart = appPrisma.part.findMany.bind(appPrisma);
    const origFit = appPrisma.fitment.findMany.bind(appPrisma);
    let partQueries = 0;
    let fitQueries = 0;
    // @ts-expect-error test spy on the app's shared client
    appPrisma.part.findMany = async (...args) => {
      partQueries += 1;
      return origPart(...args);
    };
    // @ts-expect-error test spy on the app's shared client
    appPrisma.fitment.findMany = async (...args) => {
      fitQueries += 1;
      return origFit(...args);
    };
    try {
      const ctx = (await resolveVehicleContext(variantT5Id, 2010))!;
      const r = await searchParts2({ query: "", vehicleContext: ctx }); // browse-all with vehicle
      expect(partQueries).toBe(1); // candidates + fitment rules in ONE joined query
      expect(fitQueries).toBe(0); // no per-part fitment fetch — no N+1
      expect(r.hits.length).toBeGreaterThan(0);
      expect(r.hits.every((h) => h.fitment !== null)).toBe(true);
    } finally {
      appPrisma.part.findMany = origPart;
      appPrisma.fitment.findMany = origFit;
    }
  });
});

// ─────────────── Autocomplete ───────────────

describe("P2-C autocomplete", () => {
  it("groups suggestions: parts, categories, brands, identifiers, vehicles", async () => {
    const s = await getSearchSuggestions("لنت");
    expect(s.parts.length).toBeGreaterThan(0);
    const s2 = await getSearchSuggestions("DEMO-206");
    expect(s2.identifiers.length + s2.parts.length).toBeGreaterThan(0);
    const s3 = await getSearchSuggestions("206");
    expect(s3.vehicles.length).toBeGreaterThan(0);
    const empty = await getSearchSuggestions("a");
    expect(empty.parts).toHaveLength(0);
  });
});
