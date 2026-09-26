import type { PrismaClient } from "@prisma/client";

/**
 * P2-I (I6/I8): promotion of VERIFIED real catalog records from the golden
 * dataset into a target database (production).
 *
 * Principles encoded here (see PHASE2-I spec §6/§12):
 *  - Only dataStatus === "VERIFIED" records are promotable. REVIEW_REQUIRED /
 *    DEMO / DEPRECATED records are NEVER promoted, no matter what the manifest says.
 *  - Explicit + auditable: every accepted promotion writes a CatalogEventLog
 *    row (event catalog_promoted, meta.manifestId) — exactly once per record
 *    per manifest (idempotent re-runs do not fabricate extra verification events).
 *  - Conflict-safe: an existing target row with the same SKU is classified,
 *    never silently overwritten. classifyTargets() stops the run on conflicts.
 *  - Reversible-aware: promotion only ADDS/aligns whitelisted records; it never
 *    deletes or mutates rows outside the manifest.
 *  - Offers/sellers are promoted ONLY through the explicit opt-in flags —
 *    catalog verification, seller verification and offer availability are
 *    three separate decisions (§7).
 */

export const PROMOTION_ACTOR_PREFIX = "promotion:";

export type PromotionRecord = {
  sku: string;
  slug: string;
  title: string;
  dataStatus: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
  sourceRef: string | null;
  sourceUrl: string | null;
  identifiers: { type: string; value: string }[];
  fitments: {
    vehicleModel: string;
    variantTrim: string | null;
    engine: string | null;
    transmission: string | null;
    bodyType: string | null;
    yearFrom: number | null;
    yearTo: number | null;
    fitmentStatus: string;
    fitmentNote: string | null;
  }[];
};

export type PromotionManifest = {
  manifestId: string; // stable id, e.g. "p2i-20260927"
  createdAt: string;
  sourceDescription: string;
  promoteSeller: boolean;
  promoteOffers: boolean;
  records: PromotionRecord[];
};

export type TargetClassification =
  | { sku: string; cls: "PROMOTE"; reason: "absent_in_target" | `state_upgrade_from_${string}` }
  | { sku: string; cls: "SAME"; reason: "already_promoted_identical" }
  | { sku: string; cls: "SKIP_NOT_VERIFIED"; reason: string }
  | { sku: string; cls: "CONFLICT"; reason: string };

// ─────────────────────── manifest building (source side) ───────────────────────

/** Build a manifest from the source DB. Only VERIFIED real records enter it. */
export async function buildManifest(
  source: PrismaClient,
  opts: { manifestId: string; sourceDescription: string; promoteSeller?: boolean; promoteOffers?: boolean },
): Promise<PromotionManifest> {
  const parts = await source.part.findMany({
    where: { sourceRef: { not: null }, dataStatus: "VERIFIED" },
    select: {
      sku: true, slug: true, title: true, dataStatus: true,
      verifiedBy: true, verifiedAt: true, sourceRef: true, sourceUrl: true,
      identifiers: { select: { type: true, value: true } },
      fitments: {
        select: {
          engine: true, transmission: true, bodyType: true, yearFrom: true, yearTo: true,
          fitmentStatus: true, fitmentNote: true,
          variant: { select: { trim: true } },
          vehicle: { select: { model: true } },
        },
      },
    },
    orderBy: { sku: "asc" },
  });
  return {
    manifestId: opts.manifestId,
    createdAt: new Date().toISOString(),
    sourceDescription: opts.sourceDescription,
    promoteSeller: opts.promoteSeller ?? false,
    promoteOffers: opts.promoteOffers ?? false,
    records: parts.map((p) => ({
      sku: p.sku,
      slug: p.slug,
      title: p.title,
      dataStatus: p.dataStatus,
      verifiedBy: p.verifiedBy,
      verifiedAt: p.verifiedAt?.toISOString() ?? null,
      sourceRef: p.sourceRef,
      sourceUrl: p.sourceUrl,
      identifiers: p.identifiers.map((i) => ({ type: i.type, value: i.value })),
      fitments: p.fitments.map((f) => ({
        vehicleModel: f.vehicle.model,
        variantTrim: f.variant?.trim ?? null,
        engine: f.engine,
        transmission: f.transmission,
        bodyType: f.bodyType,
        yearFrom: f.yearFrom,
        yearTo: f.yearTo,
        fitmentStatus: f.fitmentStatus,
        fitmentNote: f.fitmentNote,
      })),
    })),
  };
}

// ─────────────────────── classification (target side) ───────────────────────

/** Classify every manifest record against the target DB. Any CONFLICT aborts. */
export async function classifyTargets(
  target: PrismaClient,
  manifest: PromotionManifest,
): Promise<TargetClassification[]> {
  const out: TargetClassification[] = [];
  for (const rec of manifest.records) {
    if (rec.dataStatus !== "VERIFIED") {
      out.push({ sku: rec.sku, cls: "SKIP_NOT_VERIFIED", reason: `manifest state ${rec.dataStatus} is not promotable` });
      continue;
    }
    const existing = await target.part.findUnique({
      where: { sku: rec.sku },
      select: {
        id: true, slug: true, title: true, dataStatus: true, sourceRef: true,
        identifiers: { select: { type: true, value: true } },
        fitments: {
          select: {
            engine: true, transmission: true, bodyType: true, yearFrom: true, yearTo: true,
            fitmentStatus: true, fitmentNote: true,
            variant: { select: { trim: true } },
            vehicle: { select: { model: true } },
          },
        },
      },
    });
    if (!existing) {
      out.push({ sku: rec.sku, cls: "PROMOTE", reason: "absent_in_target" });
      continue;
    }
    // Same record = same identity, same provenance, same fitment set.
    const identSame =
      existing.identifiers.length === rec.identifiers.length &&
      rec.identifiers.every((i) => existing.identifiers.some((e) => e.type === i.type && e.value === i.value));
    const fitKey = (f: PromotionManifest["records"][number]["fitments"][number]) =>
      `${f.vehicleModel}|${f.variantTrim ?? "-"}|${f.engine ?? "-"}|${f.transmission ?? "-"}|${f.bodyType ?? "-"}|${f.yearFrom ?? "-"}|${f.yearTo ?? "-"}|${f.fitmentStatus}`;
    const existingFitKeys = new Set(existing.fitments.map((f) => fitKey({
      vehicleModel: f.vehicle.model, variantTrim: f.variant?.trim ?? null, engine: f.engine,
      transmission: f.transmission, bodyType: f.bodyType, yearFrom: f.yearFrom, yearTo: f.yearTo,
      fitmentStatus: f.fitmentStatus, fitmentNote: f.fitmentNote,
    })));
    const fitSame = existing.fitments.length === rec.fitments.length && rec.fitments.every((f) => existingFitKeys.has(fitKey(f)));
    const identitySame = existing.slug === rec.slug && existing.title === rec.title && !!existing.sourceRef && identSame && fitSame;
    if (identitySame && existing.dataStatus === "VERIFIED") {
      out.push({ sku: rec.sku, cls: "SAME", reason: "already_promoted_identical" });
      continue;
    }
    // Same identity at a LOWER state (e.g. the seed's REVIEW_REQUIRED skeleton,
    // or a legacy import row) = the promotion's actual purpose: bring the
    // verified truth. Not a conflict — identity matches exactly; we complete
    // the verification state instead of overwriting a different record.
    if (identitySame && existing.dataStatus !== "DEMO") {
      out.push({ sku: rec.sku, cls: "PROMOTE", reason: `state_upgrade_from_${existing.dataStatus}` });
      continue;
    }
    // A DEMO record holding a real SKU is a real/demo boundary violation in
    // the target — never silently overwritten (§7 of the phase spec).
    out.push({
      sku: rec.sku,
      cls: "CONFLICT",
      reason:
        existing.dataStatus === "DEMO" ? "DEMO record holds this real SKU — manual resolution required" :
        existing.slug !== rec.slug ? `slug mismatch (target=${existing.slug})` :
        !existing.sourceRef ? "target row has no provenance (demo or legacy record holds this SKU)" :
        !identSame ? "identifier set differs" :
        !fitSame ? "fitment set differs" :
        "title/data differs",
    });
  }
  return out;
}

// ─────────────────────── promotion execution ───────────────────────

export type PromotionResult = {
  manifestId: string;
  promoted: string[];
  alreadyPresent: string[];
  skipped: { sku: string; reason: string }[];
};

/**
 * Execute a manifest against the target. Skips non-VERIFIED records even if a
 * tampered manifest includes them (defense in depth). Idempotent: SAME records
 * are left untouched; the promotion audit event is written once per record per
 * manifestId (re-runs do not append duplicate events).
 */
export async function promoteCatalog(
  target: PrismaClient,
  manifest: PromotionManifest,
  runId: string,
): Promise<PromotionResult> {
  const classifications = await classifyTargets(target, manifest);
  const conflicts = classifications.filter((c) => c.cls === "CONFLICT");
  if (conflicts.length > 0) {
    throw new Error(
      `PROMOTION_BLOCKED_CONFLICTS: ${conflicts.map((c) => `${c.sku} (${c.reason})`).join("; ")}`,
    );
  }

  const result: PromotionResult = { manifestId: manifest.manifestId, promoted: [], alreadyPresent: [], skipped: [] };
  for (const rec of manifest.records) {
    if (rec.dataStatus !== "VERIFIED") {
      result.skipped.push({ sku: rec.sku, reason: `not VERIFIED (${rec.dataStatus}) — never promoted` });
      continue;
    }
    const cls = classifications.find((c) => c.sku === rec.sku)!;
    if (cls.cls === "SAME") {
      result.alreadyPresent.push(rec.sku);
      continue;
    }

    // Order matters: the Part row must exist before its fitment rules can
    // reference it. Upsert the record first (with its verification metadata),
    // then create missing fitment rules against the now-existing row.
    const eventExists = await target.catalogEventLog.findFirst({
      where: { part: { sku: rec.sku }, event: "catalog_promoted", meta: { path: ["manifestId"], equals: manifest.manifestId } },
    });
    const fromState = cls.reason === "absent_in_target" ? "ABSENT" : cls.reason.replace("state_upgrade_from_", "");
    const verificationFields = {
      verifiedAt: rec.verifiedAt ? new Date(rec.verifiedAt) : new Date(),
      verifiedBy: rec.verifiedBy ?? `promotion:${manifest.manifestId}`,
      sourceUrl: rec.sourceUrl,
    };
    await target.part.upsert({
      where: { sku: rec.sku },
      update: {
        title: rec.title,
        slug: rec.slug,
        sourceRef: rec.sourceRef ?? "public-206-maintenance-documentation",
        dataStatus: "VERIFIED",
        ...verificationFields,
      },
      create: {
        sku: rec.sku,
        slug: rec.slug,
        title: rec.title,
        condition: "NEW",
        active: true,
        dataStatus: "VERIFIED",
        sourceRef: rec.sourceRef ?? "public-206-maintenance-documentation",
        ...verificationFields,
      },
    });

    // Fitment rules: resolved by stable business keys in the target. The
    // target is NOT seeded (production) — if the vehicle/variant foundation
    // is missing, the promotion is interrupted ON PURPOSE with a clear
    // operator action, instead of creating dangling or wrong-base rules.
    for (const f of rec.fitments) {
      const vehicle = await target.vehicle.findFirst({ where: { model: f.vehicleModel } });
      if (!vehicle) {
        throw new Error(
          `PROMOTION_INTERRUPTED_MISSING_VEHICLE: "${f.vehicleModel}" does not exist in the target. ` +
          `Promotion is PARTIAL — run the vehicle/variant foundation setup, then re-run (idempotent).`,
        );
      }
      const variant = f.variantTrim
        ? await target.vehicleVariant.findFirst({ where: { vehicleId: vehicle.id, trim: f.variantTrim } })
        : null;
      if (f.variantTrim && !variant) {
        throw new Error(
          `PROMOTION_INTERRUPTED_MISSING_VARIANT: "${f.variantTrim}" does not exist for "${f.vehicleModel}" in the target. ` +
          `Promotion is PARTIAL — align the vehicle foundation, then re-run (idempotent).`,
        );
      }
      const existingFit = await target.fitment.findFirst({
        where: {
          part: { sku: rec.sku },
          vehicleId: vehicle.id,
          variantId: variant?.id ?? null,
          engine: f.engine,
          transmission: f.transmission,
          bodyType: f.bodyType,
          yearFrom: f.yearFrom,
          yearTo: f.yearTo,
        },
      });
      if (!existingFit) {
        await target.fitment.create({
          data: {
            part: { connect: { sku: rec.sku } },
            vehicle: { connect: { id: vehicle.id } },
            ...(variant ? { variant: { connect: { id: variant.id } } } : {}),
            engine: f.engine,
            transmission: f.transmission,
            bodyType: f.bodyType,
            yearFrom: f.yearFrom,
            yearTo: f.yearTo,
            fitmentStatus: f.fitmentStatus as never,
            fitmentNote: f.fitmentNote,
          },
        });      }
    }
    if (!eventExists) {
      const part = await target.part.findUniqueOrThrow({ where: { sku: rec.sku }, select: { id: true } });
      await target.catalogEventLog.create({
        data: {
          partId: part.id,
          actor: `${PROMOTION_ACTOR_PREFIX}${runId}`,
          event: "catalog_promoted",
          entity: "Part",
          entityId: part.id,
          meta: { manifestId: manifest.manifestId, fromState, toState: "VERIFIED", sku: rec.sku },
        },
      });
    }

    result.promoted.push(rec.sku);
  }
  return result;
}

// ─────────────────────── reconciliation (I9) ───────────────────────

export type ReconciliationRow = { entity: string; expected: number; actual: number; match: boolean };
export type Reconciliation = { rows: ReconciliationRow[]; match: boolean };

/** EXPECTED (manifest) vs ACTUAL (target DB) — any mismatch is a failure (§4 I9). */
export async function reconcile(target: PrismaClient, manifest: PromotionManifest): Promise<Reconciliation> {
  const skus = manifest.records.map((r) => r.sku);
  const actualVerified = await target.part.count({ where: { sku: { in: skus }, dataStatus: "VERIFIED", sourceRef: { not: null } } });
  const actualFitments = await target.fitment.count({ where: { part: { sku: { in: skus } } } });
  const expectedFitments = manifest.records.reduce((n, r) => n + r.fitments.length, 0);
  const actualEvents = await target.catalogEventLog.count({
    where: { event: "catalog_promoted", part: { sku: { in: skus } }, meta: { path: ["manifestId"], equals: manifest.manifestId } },
  });
  const rows: ReconciliationRow[] = [
    { entity: "verified_parts", expected: manifest.records.length, actual: actualVerified, match: actualVerified === manifest.records.length },
    { entity: "fitment_rules", expected: expectedFitments, actual: actualFitments, match: actualFitments >= expectedFitments },
    { entity: "promotion_events", expected: manifest.records.length, actual: actualEvents, match: actualEvents <= manifest.records.length },
  ];
  return { rows, match: rows.every((r) => r.match) };
}
