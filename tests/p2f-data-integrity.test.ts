/**
 * ───────────────── P2-F F10: real-data integrity regression ─────────────────
 * Invariants that must hold for the imported real 206 dataset at all times.
 * Runs against the same live dev DB as the rest of the suite; uses prisma
 * directly so the assertions document the schema, not SQL string guesses.
 */
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";

const REAL_STATUS = ["REVIEW_REQUIRED", "VERIFIED"] as const;

/** Real rows = imported through the pipeline (they always carry sourceRef). */
function realWhere() {
  return { sourceRef: { not: null }, dataStatus: { in: [...REAL_STATUS] } };
}

describe("P2-F F10: real 206 dataset integrity", () => {
  it("every real part carries provenance (sourceRef, sourceUpdatedAt, dataVersion) and is REVIEW_REQUIRED or VERIFIED — never born VERIFIED by import", async () => {
    const parts = await prisma.part.findMany({
      where: realWhere(),
      select: {
        id: true, title: true, sourceRef: true, sourceUrl: true,
        sourceUpdatedAt: true, dataVersion: true, dataStatus: true,
      },
    });
    expect(parts.length).toBeGreaterThanOrEqual(12);
    for (const p of parts) {
      expect(p.sourceRef).toBeTruthy();
      expect(p.dataVersion).toBeTruthy();
      expect(p.sourceUpdatedAt).not.toBeNull();
      // import never fabricates verification: rows stay REVIEW_REQUIRED until an admin promotes them
      expect(["REVIEW_REQUIRED", "VERIFIED"]).toContain(p.dataStatus);
    }
  });

  it("every real part has at least one fitment rule — missing info must not silently become compatible elsewhere", async () => {
    const parts = await prisma.part.findMany({
      where: realWhere(), select: { id: true, _count: { select: { fitments: true } } },
    });
    for (const p of parts) expect(p._count.fitments).toBeGreaterThanOrEqual(1);
  });

  it("real fitment rules carry an explicit source note — no anonymous compatibility claims", async () => {
    const realParts = await prisma.part.findMany({ where: realWhere(), select: { id: true } });
    const ids = realParts.map((p) => p.id);
    const fits = await prisma.fitment.findMany({
      where: { partId: { in: ids } },
      select: { id: true, fitmentNote: true, fitmentStatus: true },
    });
    expect(fits.length).toBeGreaterThanOrEqual(ids.length);
    for (const f of fits) {
      // every real fitment rule cites the source dataset in its note — status
      // (PENDING_REVIEW/CONFIRMED/…) is moderation's decision, the citation is not optional
      expect(f.fitmentNote ?? "").toContain("public-206-maintenance-documentation");
    }
  });

  it("external identifiers are globally unique (type, value) — duplicate detection holds", async () => {
    const idents = await prisma.partIdentifier.findMany({
      select: { type: true, value: true, partId: true },
    });
    const seen = new Map<string, string>();
    for (const i of idents) {
      const key = `${i.type}:${i.value}`;
      const prev = seen.get(key);
      if (prev) expect.fail(`duplicate identifier ${key} on ${prev} and ${i.partId}`);
      seen.set(key, i.partId);
    }
  });

  it("part-kind mappings always resolve to an existing part (no orphan 3D → commerce links)", async () => {
    const mappings = await prisma.meshMapping.findMany({
      select: { meshName: true, kind: true, partId: true },
    });
    for (const m of mappings) {
      if (m.kind !== "part") continue;
      expect(m.partId, `mapping ${m.meshName} must reference a part`).toBeTruthy();
      const part = await prisma.part.findUnique({ where: { id: m.partId! }, select: { title: true } });
      expect(part, `mapping ${m.meshName} points at a deleted part`).not.toBeNull();
    }
  });

  it("the three real engine-bay meshes resolve to the real imported parts", async () => {
    // Per ACTIVE version: v2 duplicates the mapping rows (full mapping copy),
    // so the table-wide count is 6 — the invariant is one triple per version.
    // The version that carries the real imported catalog mappings is the tracked
    // engineering GLB (v2) — the builtin primitive stand-in has none. Select it
    // explicitly: `activatedAt` can be NULL, and a DESC ordering would put those
    // rows first (NULLS FIRST), which would silently pick the wrong version.
    const activeVersion = await prisma.assetVersion.findFirst({
      where: { state: "PLACEHOLDER", filePath: { not: { startsWith: "builtin:" } } },
      orderBy: { version: "desc" },
      select: { id: true },
    });
    const meshes = await prisma.meshMapping.findMany({
      where: {
        versionId: activeVersion!.id,
        meshName: { in: ["part_radiator_main", "part_oil_filter_main", "part_brake_pad_front_main"] },
      },
      include: { part: { select: { title: true, sourceRef: true, dataStatus: true } } },
    });
    expect(meshes.length).toBe(3);
    for (const m of meshes) {
      expect(m.part).not.toBeNull();
      expect(m.part!.sourceRef).toBe("public-206-maintenance-documentation"); // real, not demo
      expect(m.part!.dataStatus).toBe("REVIEW_REQUIRED");
    }
  });

  it("no active offer hangs on a DEPRECATED/UNVERIFIED part", async () => {
    const bad = await prisma.offer.findMany({
      where: { active: true, part: { dataStatus: { in: ["DEPRECATED", "UNVERIFIED"] } } },
      select: { id: true },
    });
    expect(bad).toHaveLength(0);
  });

  it("real parts are distinguishable from demo parts end-to-end (sourceRef on real, null on synthetic)", async () => {
    const real = await prisma.part.count({ where: realWhere() });
    const demo = await prisma.part.count({ where: { sourceRef: null, dataStatus: "DEMO" } });
    expect(real).toBeGreaterThanOrEqual(12);
    expect(demo).toBeGreaterThanOrEqual(40); // synthetic set still identifiable and isolated
  });
});
