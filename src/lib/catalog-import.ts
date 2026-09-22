import { prisma } from "@/lib/prisma";
import { normalizeIdentifier } from "@/lib/catalog";

/**
 * ─────────────────── Catalog Import Pipeline (P2-F, F5) ───────────────────
 * SOURCE → RAW → NORMALIZED → VALIDATED → APPROVED → COMMITTED.
 * Raw external data NEVER silently becomes production catalog data:
 *  - rows land in ImportRow (rawJson immutable), never directly in Part;
 *  - validation resolves duplicates against existing identifiers;
 *  - an admin must approve before commit;
 *  - VERIFIED parts are never overwritten (→ CONFLICT), per the P2-F rule
 *    "the import process must not silently overwrite verified data".
 * Authorization is enforced by the calling admin actions layer, not here.
 */

export type RawBatchInput = {
  label: string;
  sourceRef: string;
  sourceUrl?: string;
  /** When the SOURCE dataset was last known-current (stated by the source). Carried onto every committed Part. */
  sourceUpdatedAt?: Date;
  format?: string;
  createdBy?: string;
};

export type NormalizedPartRow = {
  title: string;
  titleEn?: string;
  slugHint?: string;
  sku?: string;
  condition: "NEW" | "USED" | "REFURBISHED";
  categoryName?: string;
  brandName?: string;
  assemblySlug?: string;
  technicalDescription?: string;
  identifiers: { type: "OEM" | "MPN" | "CROSS_REFERENCE" | "GTIN" | "BARCODE" | "SELLER_SKU"; value: string }[];
};

// ─────────────────────────── CSV parsing (RFC4180-ish, no deps) ───────────────────────────

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

const HEADER = ["title", "titleEn", "sku", "condition", "categoryName", "brandName", "assemblySlug", "identifiers", "technicalDescription"] as const;

// ─────────────────────────── 1. ingest ───────────────────────────

export async function ingestRawCsv(batch: RawBatchInput, csvText: string) {
  const rows = parseCsv(csvText);
  if (rows.length < 2 || !rows[0] || !rows[1]) throw new Error("EMPTY_CSV: header + at least one data row required");
  const header = (rows[0] ?? []).map((h) => h.trim());
  const missing = HEADER.filter((h) => !header.includes(h) && (h === "title" || h === "identifiers"));
  if (missing.length > 0) throw new Error(`BAD_HEADER: missing ${missing.join(",")}`);
  // P2-F (F10): provenance completeness is enforced at the gate — a batch without
  // a source-refresh date would silently strip provenance from updated rows.
  if (!batch.sourceRef?.trim()) throw new Error("SOURCE_REF_REQUIRED");
  if (!batch.sourceUpdatedAt) throw new Error("SOURCE_UPDATED_AT_REQUIRED");

  return prisma.$transaction(async (tx) => {
    const b = await tx.importBatch.create({
      data: {
        label: batch.label,
        sourceRef: batch.sourceRef,
        sourceUrl: batch.sourceUrl,
        sourceUpdatedAt: batch.sourceUpdatedAt ?? null,
        format: batch.format ?? "csv",
        createdBy: batch.createdBy,
        status: "DRAFT",
      },
    });
    const dataRows = rows.slice(1).filter((cells) => cells.some((c) => c.trim() !== ""));
    await tx.importRow.createMany({
      data: dataRows.map((cells, idx) => ({
        batchId: b.id,
        rowNumber: idx + 1,
        rawJson: { header, cells },
        status: "RAW" as const,
      })),
    });
    return { batchId: b.id, rowCount: dataRows.length };
  });
}

// ─────────────────────────── 2. normalize ───────────────────────────

function parseIdentifiers(raw: string): NormalizedPartRow["identifiers"] {
  const out: NormalizedPartRow["identifiers"] = [];
  for (const part of raw.split(";")) {
    const seg = part.trim();
    if (!seg) continue;
    const sep = seg.indexOf(":");
    const type = (sep >= 0 ? seg.slice(0, sep) : "OEM").trim().toUpperCase();
    const value = (sep >= 0 ? seg.slice(sep + 1) : seg).trim();
    if (!value) continue;
    if (!["OEM", "MPN", "CROSS_REFERENCE", "GTIN", "BARCODE", "SELLER_SKU"].includes(type)) continue;
    out.push({ type: type as NormalizedPartRow["identifiers"][number]["type"], value });
  }
  return out;
}

export async function normalizeBatch(batchId: string) {
  const rows = await prisma.importRow.findMany({ where: { batchId, status: "RAW" } });
  let normalized = 0;
  for (const r of rows) {
    const raw = r.rawJson as { header: string[]; cells: string[] };
    const get = (name: string) => {
      const i = raw.header.indexOf(name);
      return i >= 0 ? (raw.cells[i] ?? "").trim() : "";
    };
    // Display text is stored as received (whitespace-collapsed only) — the
    // aggressive search normalization (normalizeFa) belongs to the SEARCH layer
    // and must never rewrite stored Persian titles (آب→اب، ۲۰۶→206 corruption).
    const norm: NormalizedPartRow = {
      title: get("title").replace(/\s+/g, " ").trim(),
      titleEn: get("titleEn").replace(/\s+/g, " ").trim() || undefined,
      slugHint: get("titleEn") || undefined,
      sku: get("sku") || undefined,
      condition: (["NEW", "USED", "REFURBISHED"].includes(get("condition")) ? get("condition") : "NEW") as NormalizedPartRow["condition"],
      categoryName: get("categoryName") || undefined,
      brandName: get("brandName") || undefined,
      assemblySlug: get("assemblySlug") || undefined,
      technicalDescription: get("technicalDescription") || undefined,
      identifiers: parseIdentifiers(get("identifiers")),
    };
    await prisma.importRow.update({
      where: { id: r.id },
      data: { normalizedJson: norm, status: "NORMALIZED" },
    });
    normalized++;
  }
  return { normalized };
}

// ─────────────────────────── 3. validate (+ duplicate detection) ───────────────────────────

export type RowDecision = "CREATE" | "UPDATE" | "DEPRECATE" | "UNCHANGED" | "CONFLICT";

export async function validateBatch(batchId: string) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new Error("BATCH_NOT_FOUND");
  if (batch.status !== "DRAFT") throw new Error(`BAD_STATE:${batch.status}`);

  const rows = await prisma.importRow.findMany({ where: { batchId, status: "NORMALIZED" }, orderBy: { rowNumber: "asc" } });
  const seenKeys = new Map<string, number>(); // normalized identifier → first rowNumber (in-batch dupes)
  let valid = 0, invalid = 0;

  for (const r of rows) {
    const norm = r.normalizedJson as NormalizedPartRow;
    const problems: string[] = [];

    if (!norm.title || norm.title.length < 2) problems.push("TITLE_REQUIRED");
    // A row needs an anchor: a real external identifier (OEM/MPN/…) or at least
    // an internal SKU. External codes are NEVER guessed — absence stays absence.
    if (norm.identifiers.length === 0 && !norm.sku) problems.push("IDENTIFIER_OR_SKU_REQUIRED");
    for (const id of norm.identifiers) {
      if (!id.value || id.value.length > 64) problems.push(`BAD_IDENTIFIER:${id.type}`);
    }

    // primary key for dedupe = first identifier (or SKU). The DB lookup key
    // carries the RAW value; a separately normalized key is used only for
    // in-batch duplicate comparison. (Bug fixed in P2-F: storing the normalized
    // value made lookups miss raw identifiers like "1109.AX" → silent duplicates.)
    let externalKey: string | null = null;
    let dupKey: string | null = null;
    const firstId = norm.identifiers[0];
    if (firstId) {
      externalKey = `${firstId.type}:${firstId.value}`;
      dupKey = `${firstId.type}:${normalizeIdentifier(firstId.value)}`;
    } else if (norm.sku) {
      externalKey = `SELLER_SKU:${norm.sku}`;
      dupKey = `SELLER_SKU:${normalizeIdentifier(norm.sku)}`;
    }
    if (dupKey) {
      const firstAt = seenKeys.get(dupKey);
      if (firstAt !== undefined) problems.push(`DUPLICATE_IN_BATCH:${firstAt}`);
      else seenKeys.set(dupKey, r.rowNumber);
    }

    // resolve against existing catalog (create/update/deprecate decision)
    let matchedPartId: string | null = null;
    let action: RowDecision = "CREATE";
    if (externalKey && !problems.some((p) => p.startsWith("DUPLICATE_IN_BATCH"))) {
      const [type, ...rest] = externalKey.split(":");
      const value = rest.join(":");
      const isSkuKey = type === "SELLER_SKU";
      const existing = isSkuKey
        ? await prisma.part.findFirst({
            where: { sku: value },
            select: { id: true, dataStatus: true, sku: true },
          }).then((p) => (p ? { partId: p.id, part: { dataStatus: p.dataStatus, sku: p.sku } } : null))
        : await prisma.partIdentifier.findFirst({
            where: { type: type as "OEM", value },
            select: { partId: true, part: { select: { dataStatus: true, sku: true } } },
          });
      if (existing) {
        matchedPartId = existing.partId;
        if (existing.part.dataStatus === "VERIFIED") {
          // verified data is immutable to imports — surfaced, never applied
          action = "CONFLICT";
          problems.push("TARGET_VERIFIED");
        } else if (existing.part.dataStatus === "DEPRECATED") {
          action = "UNCHANGED"; // already withdrawn; nothing to do
        } else {
          action = "UPDATE";
        }
      }
    }

    // assembly reference must resolve when provided
    if (norm.assemblySlug) {
      const asm = await prisma.assembly.findUnique({ where: { slug: norm.assemblySlug }, select: { id: true } });
      if (!asm) problems.push("ASSEMBLY_NOT_FOUND");
    }

    // A CONFLICT row (TARGET_VERIFIED) is a legitimate review outcome, not a
    // validation failure: it must stay VALID so it flows through approve/commit
    // and the conflict is recorded in the summary. Other problems ⇒ INVALID.
    const blocking = problems.filter((p) => !p.startsWith("TARGET_VERIFIED"));
    const status = blocking.length > 0 ? "INVALID" : "VALID";
    if (status === "VALID") valid++; else invalid++;
    await prisma.importRow.update({
      where: { id: r.id },
      data: { status, problems, externalKey, matchedPartId, action: blocking.length > 0 ? null : action },
    });
  }

  await prisma.importBatch.update({ where: { id: batchId }, data: { status: "VALIDATED" } });
  return { valid, invalid };
}

// ─────────────────────────── 4. approve (admin action) ───────────────────────────

export async function approveBatch(batchId: string, adminId: string) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId }, include: { rows: true } });
  if (!batch) throw new Error("BATCH_NOT_FOUND");
  if (batch.status !== "VALIDATED") throw new Error(`BAD_STATE:${batch.status}`);
  if (!batch.rows.some((r) => r.status === "VALID")) throw new Error("NOTHING_TO_APPROVE");

  await prisma.$transaction(async (tx) => {
    await tx.importRow.updateMany({ where: { batchId, status: "VALID" }, data: { status: "APPROVED" } });
    await tx.importRow.updateMany({ where: { batchId, status: "INVALID" }, data: { status: "REJECTED" } });
    await tx.importBatch.update({ where: { id: batchId }, data: { status: "APPROVED", createdBy: batch.createdBy ?? adminId } });
  });
  return { approved: batch.rows.filter((r) => r.status === "VALID").length };
}

// ─────────────────────────── 5. commit (all-or-nothing) ───────────────────────────

async function uniqueSlug(base: string, tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]): Promise<string> {
  const clean = (base || "part").toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "part";
  let candidate = clean;
  for (let i = 2; ; i++) {
    const clash = await tx.part.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!clash) return candidate;
    candidate = `${clean}-${i}`;
  }
}

export async function commitBatch(batchId: string) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId }, include: { rows: true } });
  if (!batch) throw new Error("BATCH_NOT_FOUND");
  if (batch.status !== "APPROVED") throw new Error(`BAD_STATE:${batch.status}`);
  const rows = batch.rows.filter((r) => r.status === "APPROVED");
  if (rows.length === 0) throw new Error("NOTHING_TO_COMMIT");

  try {
    const result = await prisma.$transaction(async (tx) => {
      let created = 0, updated = 0, deprecated = 0, unchanged = 0, conflicts = 0;
      for (const r of rows) {
        const norm = r.normalizedJson as NormalizedPartRow;
        if (r.action === "CONFLICT") { conflicts++; await tx.importRow.update({ where: { id: r.id }, data: { status: "APPLIED" } }); continue; }
        if (r.action === "UNCHANGED") { unchanged++; await tx.importRow.update({ where: { id: r.id }, data: { status: "APPLIED" } }); continue; }

        if (r.action === "DEPRECATE" && r.matchedPartId) {
          await tx.part.update({ where: { id: r.matchedPartId }, data: { dataStatus: "DEPRECATED" } });
          deprecated++;
        } else        if (r.action === "UPDATE" && r.matchedPartId) {
          const target = await tx.part.findUnique({ where: { id: r.matchedPartId }, select: { dataStatus: true } });
          if (target?.dataStatus === "VERIFIED") { conflicts++; }
          else {
            await tx.part.update({
              where: { id: r.matchedPartId },
              data: {
                title: norm.title,
                titleEn: norm.titleEn ?? null,
                technicalDescription: norm.technicalDescription ?? null,
              sourceRef: batch.sourceRef,
              sourceUrl: batch.sourceUrl,
              sourceUpdatedAt: batch.sourceUpdatedAt ?? null,
              dataStatus: "REVIEW_REQUIRED", // updated by import ⇒ needs review again
              },
            });
            updated++;
          }
        } else if (r.action === "CREATE") {
          // category / brand upsert by name (canonical taxonomy stays admin-owned)
          let categoryId: string | undefined;
          if (norm.categoryName) {
            const slug = norm.categoryName.toLowerCase().replace(/\s+/g, "-");
            const cat = await tx.category.upsert({
              where: { slug }, create: { slug, titleFa: norm.categoryName }, update: {},
            });
            categoryId = cat.id;
          }
          let brandId: string | undefined;
          if (norm.brandName) {
            const slug = norm.brandName.toLowerCase().replace(/\s+/g, "-");
            const brand = await tx.brand.upsert({ where: { slug }, create: { slug, name: norm.brandName }, update: {} });
            brandId = brand.id;
          }
          let assemblyId: string | undefined;
          if (norm.assemblySlug) {
            const asm = await tx.assembly.findUnique({ where: { slug: norm.assemblySlug }, select: { id: true } });
            if (asm) assemblyId = asm.id;
          }
          const firstId = norm.identifiers[0];
          const slug = await uniqueSlug(norm.slugHint ?? norm.sku ?? firstId?.value ?? norm.title, tx);
          const sku = norm.sku ?? `PI-${normalizeIdentifier(firstId?.value ?? slug)}`;            await tx.part.create({
              data: {
                slug,
                sku,
                title: norm.title,
                titleEn: norm.titleEn ?? null,
                technicalDescription: norm.technicalDescription ?? null,
              condition: norm.condition,
              categoryId, brandId, assemblyId,
              // imported rows are NEVER born VERIFIED — admin verification is a separate act
              dataStatus: "REVIEW_REQUIRED",
              // provenance = the SOURCE dataset (same as the UPDATE path); the
              // batch label is internal bookkeeping, recorded in dataNotes
              sourceRef: batch.sourceRef,
              sourceUrl: batch.sourceUrl,
              sourceUpdatedAt: batch.sourceUpdatedAt ?? null,
              dataNotes: `imported via batch ${batch.label}`,
              identifiers: { create: norm.identifiers.map((i) => ({ type: i.type, value: i.value })) },
            },
          });
          created++;
        }
        await tx.importRow.update({ where: { id: r.id }, data: { status: "APPLIED" } });
      }
      await tx.importBatch.update({ where: { id: batchId }, data: { status: "COMMITTED", committedAt: new Date() } });
      return { created, updated, deprecated, unchanged, conflicts };
    });
    return result;
  } catch (e) {
    // all-or-nothing: nothing was applied; the batch stays APPROVED for retry after fix
    await prisma.importBatch.update({ where: { id: batchId }, data: { status: "FAILED" } });
    throw new Error(`COMMIT_FAILED:${e instanceof Error ? e.message : "unknown"}`);
  }
}

// ─────────────────────────── summary ───────────────────────────

export async function getBatchSummary(batchId: string) {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: { rows: { orderBy: { rowNumber: "asc" } } },
  });
  if (!batch) throw new Error("BATCH_NOT_FOUND");
  const byStatus: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  const failedRows: { rowNumber: number; problems: string[] }[] = [];
  for (const r of batch.rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.action) byAction[r.action] = (byAction[r.action] ?? 0) + 1;
    if (r.problems.length > 0) failedRows.push({ rowNumber: r.rowNumber, problems: r.problems });
  }
  return {
    label: batch.label, sourceRef: batch.sourceRef, status: batch.status,
    total: batch.rows.length, byStatus, byAction, failedRows,
  };
}

// ─────────────────────── admin verification (P2-F.1 §4) ───────────────────────

export type VerificationOutcome =
  | { ok: true; slug: string; dataStatus: "VERIFIED" }
  | { ok: false; reason: "PART_NOT_FOUND" | "DEPRECATED" };

/**
 * Human verification of a real catalog record — the ONLY path to VERIFIED.
 * Records who/when, bumps dataVersion, and (optionally) records the evidence URL.
 * Verifying a DEPRECATED record is refused — deprecation and verification are
 * separate lifecycle states, and verification must not resurrect dead records.
 */
export async function verifyRealPart(partId: string, adminUserId: string, evidenceUrl?: string) {
  const part = await prisma.part.findUnique({
    where: { id: partId },
    select: { id: true, slug: true, dataStatus: true },
  });
  if (!part) return { ok: false as const, reason: "PART_NOT_FOUND" as const };
  if (part.dataStatus === "DEPRECATED") return { ok: false as const, reason: "DEPRECATED" as const };
  await prisma.part.update({
    where: { id: partId },
    data: {
      dataStatus: "VERIFIED",
      verifiedAt: new Date(),
      verifiedBy: adminUserId,
      dataVersion: { increment: 1 },
      ...(evidenceUrl ? { sourceUrl: evidenceUrl } : {}),
    },
  });
  return { ok: true as const, slug: part.slug, dataStatus: "VERIFIED" as const };
}

/** Re-open a verified record for review (verification is reversible, but auditable). */
export async function reopenVerification(partId: string, adminUserId: string) {
  const part = await prisma.part.findUnique({ where: { id: partId }, select: { dataStatus: true } });
  if (!part) return { ok: false as const, reason: "PART_NOT_FOUND" as const };
  await prisma.part.update({
    where: { id: partId },
    data: {
      dataStatus: "REVIEW_REQUIRED",
      verifiedAt: null,
      verifiedBy: null,
      dataVersion: { increment: 1 },
    },
  });
  return { ok: true as const, slug: partId, dataStatus: "REVIEW_REQUIRED" as const };
}
