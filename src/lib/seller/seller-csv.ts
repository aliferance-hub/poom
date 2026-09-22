import { prisma } from "@/lib/prisma";
import { csvRowSchema, type SellerInventoryRow } from "@/lib/seller/seller-validation";
import { logSellerEventTx, type SellerEvent } from "@/lib/seller/seller-audit";

/**
 * ───────────────────── CSV import/export (P2-D, §17–23, §37) ─────────────────────
 * Flow: Upload → Parse → Validate → Preview → Commit (all-or-nothing).
 * The commit transaction applies valid rows ONLY for the authenticated seller;
 * `sellerId` from the CSV is ignored — ownership is forced server-side.
 * Parsing happens in memory BEFORE any transaction is opened (§52).
 */

export const CSV_LIMITS = {
  maxFileBytes: 2 * 1024 * 1024, // 2 MB
  maxRows: 500,
  maxFieldChars: 4000,
} as const;

export type RowStatus = "VALID" | "INVALID" | "WARNING";

export type ParsedRow = {
  rowNumber: number;
  status: RowStatus;
  data?: SellerInventoryRow;
  error?: string;
  warning?: string;
};

export type CsvParseResult = {
  ok: boolean;
  fatal?: string;
  rows: ParsedRow[];
  validCount: number;
  invalidCount: number;
  warningCount: number;
};

/** Minimal RFC-4180-ish CSV parser (quotes, embedded commas/newlines, BOM). */
export function parseCsv(text: string): string[][] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && clean[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
    if (field.length > CSV_LIMITS.maxFieldChars) throw new Error("FIELD_TOO_LONG");
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const BOOL = new Set(["1", "true", "0", "false"]);

function num(v: string): number {
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Parse + validate rows. Validation is pure (no DB writes). Row-level problems
 * produce INVALID rows; a whole-file problem (limits, header) produces `fatal`.
 */
export function parseSellerInventoryCsv(text: string): CsvParseResult {
  if (text.length > CSV_LIMITS.maxFileBytes) {
    return { ok: false, fatal: "حجم فایل بیش از حد مجاز است (حداکثر ۲ مگابایت).", rows: [], validCount: 0, invalidCount: 0, warningCount: 0 };
  }
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch {
    return { ok: false, fatal: "فیلد خیلی بلند در فایل CSV.", rows: [], validCount: 0, invalidCount: 0, warningCount: 0 };
  }
  if (table.length === 0) return { ok: false, fatal: "فایل خالی است.", rows: [], validCount: 0, invalidCount: 0, warningCount: 0 };

  const header = (table[0] ?? []).map((h) => h.trim());
  const REQUIRED = ["seller_sku", "part_id", "price_irr", "stock", "shipping_days_min", "shipping_days_max", "active"];
  const missing = REQUIRED.filter((r) => !header.includes(r));
  if (missing.length > 0) {
    return { ok: false, fatal: `ستون‌های الزامی یافت نشدند: ${missing.join(", ")}`, rows: [], validCount: 0, invalidCount: 0, warningCount: 0 };
  }
  const idx = (name: string) => header.indexOf(name);
  const dataRows = table.slice(1);
  if (dataRows.length > CSV_LIMITS.maxRows) {
    return { ok: false, fatal: `تعداد ردیف‌ها بیش از حد مجاز است (حداکثر ${CSV_LIMITS.maxRows}).`, rows: [], validCount: 0, invalidCount: 0, warningCount: 0 };
  }

  const rows: ParsedRow[] = dataRows.map((cells, i) => {
    const rowNumber = i + 2; // 1-based incl. header
    const get = (name: string) => (idx(name) >= 0 ? (cells[idx(name)] ?? "").trim() : "");
    const raw = {
      seller_sku: get("seller_sku"),
      part_id: get("part_id"),
      price_irr: num(get("price_irr")),
      stock: num(get("stock")),
      shipping_days_min: num(get("shipping_days_min")),
      shipping_days_max: num(get("shipping_days_max")),
      active: get("active"),
      warranty_fa: get("warranty_fa") || undefined,
    };
    const activeOk = BOOL.has(raw.active.toLowerCase());
    const parsed = csvRowSchema.safeParse({
      ...raw,
      active: activeOk ? raw.active.toLowerCase() === "1" || raw.active.toLowerCase() === "true" : raw.active,
    });
    if (!activeOk) {
      return { rowNumber, status: "INVALID", error: "active باید 1/0 یا true/false باشد." };
    }
    if (!parsed.success) {
      return { rowNumber, status: "INVALID", error: parsed.error.issues.map((is) => is.message).join("؛ ") };
    }
    // Known-unknown part at parse time would need a DB read; preview resolves
    // part existence/ownership in previewSellerInventoryImport (async).
    return { rowNumber, status: "VALID", data: parsed.data };
  });

  // P2-G audit fix (L-3): rows are matched to listings by seller_sku, so two
  // rows carrying the same seller_sku would both target one listing (last row
  // silently wins). Reject the duplicate explicitly instead of guessing.
  const seenSku = new Set<string>();
  for (const r of rows) {
    if (r.status !== "VALID" || !r.data) continue;
    const sku = r.data.seller_sku;
    if (seenSku.has(sku)) {
      r.status = "INVALID";
      r.error = `seller_sku در فایل تکراری است: ${sku}`;
      delete r.data;
    } else {
      seenSku.add(sku);
    }
  }

  const validCount = rows.filter((r) => r.status === "VALID").length;
  const invalidCount = rows.filter((r) => r.status === "INVALID").length;
  return { ok: true, rows, validCount, invalidCount, warningCount: 0 };
}

export type PreviewRow = ParsedRow & {
  partTitle?: string;
  offerId?: string;
  sellerSkuMatch?: boolean;
};

/**
 * Async preview: enriches valid rows with DB truth — does the Offer exist for
 * THIS seller with this seller_sku/part_id? Unknown part / foreign offer →
 * INVALID with a Persian reason (no existence leak: message says «متعلق به شما
 * نیست یا یافت نشد»).
 */
export async function previewSellerInventoryImport(sellerId: string, parsed: CsvParseResult): Promise<{ preview: PreviewRow[]; validCount: number; invalidCount: number }> {
  if (!parsed.ok || parsed.fatal) return { preview: parsed.rows, validCount: 0, invalidCount: parsed.rows.length };

  const skuList = parsed.rows.filter((r) => r.data).map((r) => r.data!.seller_sku);
  const offers = await prisma.offer.findMany({
    where: { sellerId, OR: [{ sellerSku: { in: skuList } }] },
    select: { id: true, sellerSku: true, partId: true, part: { select: { title: true } } },
  });
  const bySku = new Map(offers.filter((o) => o.sellerSku).map((o) => [o.sellerSku as string, o]));

  const preview: PreviewRow[] = [];
  for (const r of parsed.rows) {
    if (!r.data) { preview.push(r); continue; }
    const offer = bySku.get(r.data.seller_sku);
    if (!offer) {
      preview.push({
        ...r, status: "INVALID",
        error: "آفر با این seller_sku برای فروشگاه شما یافت نشد (CSV فقط آفرهای موجود شما را بروزرسانی می‌کند).",
      });
      continue;
    }
    if (offer.partId !== r.data.part_id) {
      preview.push({
        ...r, status: "INVALID", offerId: offer.id, partTitle: offer.part.title,
        error: `part_id با آفر موجود هم‌خوان نیست (آفر متعلق به قطعه «${offer.part.title}» است).`,
      });
      continue;
    }
    preview.push({ ...r, status: "VALID", offerId: offer.id, partTitle: offer.part.title, sellerSkuMatch: true });
  }
  return {
    preview,
    validCount: preview.filter((r) => r.status === "VALID").length,
    invalidCount: preview.filter((r) => r.status === "INVALID").length,
  };
}

export type CommitResult =
  | { ok: true; updatedCount: number; bySku: number; skippedInvalid: number }
  | { ok: false; reason: "FATAL" | "HAS_INVALID" | "NOTHING_TO_COMMIT" | "DB_CONFLICT"; detail?: string };

/**
 * All-or-nothing commit (§21): any INVALID row aborts the whole import — a
 * seller must never receive a half-updated inventory from a mistaken file.
 * One bounded transaction (§52); per-row audit entries inside it.
 */
export async function commitSellerInventoryImport(
  sellerId: string,
  actor: string,
  preview: PreviewRow[],
): Promise<CommitResult> {
  if (preview.some((r) => r.status === "INVALID")) {
    return { ok: false, reason: "HAS_INVALID", detail: "یکی از ردیف‌ها معتبر نیست؛ هیچ تغییری اعمال نشد." };
  }
  const valid = preview.filter((r) => r.status === "VALID" && r.offerId && r.data);
  if (valid.length === 0) return { ok: false, reason: "NOTHING_TO_COMMIT" };

  try {
    const updatedCount = await prisma.$transaction(async (tx) => {
      let n = 0;
      for (const r of valid) {
        const d = r.data!;
        const res = await tx.offer.updateMany({
          where: { id: r.offerId!, sellerId }, // ownership enforced again at write time
          data: {
            price: d.price_irr,
            priceUpdatedAt: new Date(),
            stock: d.stock,
            stockUpdatedAt: new Date(),
            shippingDaysMin: d.shipping_days_min,
            shippingDaysMax: d.shipping_days_max,
            shippingDays: d.shipping_days_min,
            active: d.active,
            ...(d.warranty_fa !== undefined ? { warrantyNote: d.warranty_fa } : {}),
          },
        });
        n += res.count;
        if (res.count === 1) {
          await logSellerEventTx(tx, {
            sellerId, actor, event: "seller_offer_stock_updated" as SellerEvent, entity: "Offer", entityId: r.offerId!,
            meta: { source: "csv_import", row: r.rowNumber, to: { price: d.price_irr, stock: d.stock } },
          });
        }
      }
      await logSellerEventTx(tx, {
        sellerId, actor, event: "seller_inventory_csv_imported" as SellerEvent, entity: "CsvImport",
        meta: { rows: valid.length, updated: n },
      });
      return n;
    });
    return { ok: true, updatedCount, bySku: valid.length, skippedInvalid: 0 };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P2025" || code === "P2034") return { ok: false, reason: "DB_CONFLICT" };
    throw e;
  }
}

const CSV_ROW_HEADER = ["seller_sku", "part_id", "part_name", "price_irr", "stock", "shipping_days_min", "shipping_days_max", "active", "stock_updated_at", "price_updated_at"];

/** Guard against spreadsheet formula injection (§43): prefix dangerous openers. */
function csvSafe(v: string | null | undefined): string {
  const s = String(v ?? "");
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function iso(d: Date | null): string {
  return d ? d.toISOString() : "";
}

/** Export ONLY this seller's rows; includes freshness timestamps, excludes other sellers/customers/secrets. */
export async function exportSellerInventoryCsv(sellerId: string): Promise<string> {
  const offers = await prisma.offer.findMany({
    where: { sellerId },
    include: { part: { select: { title: true, sku: true } } },
    orderBy: { id: "asc" },
  });
  const lines = [CSV_ROW_HEADER.join(",")];
  for (const o of offers) {
    lines.push([
      csvSafe(o.sellerSku ?? ""),
      csvSafe(o.partId),
      csvSafe(o.part.title),
      String(o.price),
      String(o.stock),
      String(o.shippingDaysMin ?? o.shippingDays),
      String(o.shippingDaysMax ?? o.shippingDays),
      o.active ? "1" : "0",
      iso(o.stockUpdatedAt),
      iso(o.priceUpdatedAt),
    ].join(","));
  }
  return lines.join("\r\n");
}
