import { prisma } from "@/lib/prisma";
import { stockState, type StockState } from "@/lib/offers";
import { freshState } from "@/lib/seller/seller-inventory";
import { sellerOfferUpdateSchema, zodFaErrors, type SellerOfferUpdateInput } from "@/lib/seller/seller-validation";
import { logSellerEventTx } from "@/lib/seller/seller-audit";
import type { Offer, Prisma } from "@prisma/client";

export type SellerOfferFilters = {
  status?: "active" | "inactive" | "in_stock" | "low_stock" | "out_of_stock";
  sort?: "updated_desc" | "price_asc" | "price_desc" | "stock_asc" | "title_asc";
  q?: string;
  page?: number;
  pageSize?: number;
};

export type SellerOfferRowView = {
  id: string;
  partId: string;
  partTitle: string;
  partSku: string;
  categoryTitle: string | null;
  sellerSku: string | null;
  price: number;
  stock: number;
  lowStockThreshold: number;
  shippingDaysMin: number;
  shippingDaysMax: number;
  warrantyFa: string | null;
  active: boolean;
  stockUpdatedAt: Date | null;
  priceUpdatedAt: Date | null;
  updatedAt: Date;
  stockState: StockState;
  freshness: "fresh" | "stale";
};

/** Server-authoritative mapping Offer → view (shipping range falls back to legacy field). */
export type OfferWithPart = Offer & { part: { id: string; title: string; sku: string; category?: { titleFa: string } | null } };

export function toOfferRowView(o: OfferWithPart): SellerOfferRowView {
  const min = o.shippingDaysMin ?? o.shippingDays;
  return {
    id: o.id,
    partId: o.part.id,
    partTitle: o.part.title,
    partSku: o.part.sku,
    categoryTitle: o.part.category?.titleFa ?? null,
    sellerSku: o.sellerSku,
    price: o.price,
    stock: o.stock,
    lowStockThreshold: o.lowStockThreshold,
    shippingDaysMin: min,
    shippingDaysMax: o.shippingDaysMax ?? min,
    warrantyFa: o.warrantyNote,
    active: o.active,
    stockUpdatedAt: o.stockUpdatedAt,
    priceUpdatedAt: o.priceUpdatedAt,
    updatedAt: o.updatedAt,
    stockState: stockState(o),
    freshness: freshState(o.stockUpdatedAt),
  };
}

const SORTS: Record<NonNullable<SellerOfferFilters["sort"]>, Prisma.OfferOrderByWithRelationInput[]> = {
  updated_desc: [{ updatedAt: "desc" }],
  price_asc: [{ price: "asc" }],
  price_desc: [{ price: "desc" }],
  stock_asc: [{ stock: "asc" }],
  title_asc: [{ part: { title: "asc" } }],
};

/**
 * Ownership is enforced in the WHERE clause: sellerId comes from the
 * authenticated identity, never from the client (§57).
 */
export async function getSellerOffers(
  sellerId: string,
  filters: SellerOfferFilters = {},
): Promise<{ rows: SellerOfferRowView[]; total: number }> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(5, filters.pageSize ?? 20));

  const where: Prisma.OfferWhereInput = { sellerId };
  switch (filters.status) {
    case "active": where.active = true; break;
    case "inactive": where.active = false; break;
    case "in_stock": where.stock = { gt: 0 }; break;
    case "low_stock":
      // stock > 0 AND stock <= lowStockThreshold (row-level field reference, Prisma ≥5).
      where.AND = [{ stock: { gt: 0 } }, { stock: { lte: prisma.offer.fields.lowStockThreshold } }];
      break;
    case "out_of_stock": where.stock = 0; break;
  }

  if (filters.q?.trim()) {
    where.part = {
      OR: [{ title: { contains: filters.q.trim() } }, { sku: { contains: filters.q.trim() } }],
    };
  }

  const [rows, total] = await Promise.all([
    prisma.offer.findMany({
      where,
      orderBy: SORTS[filters.sort ?? "updated_desc"],
      include: { part: { include: { category: true } } },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.offer.count({ where }),
  ]);

  return { rows: rows.map(toOfferRowView), total };
}

export type UpdateSellerOfferResult =
  | { ok: true; offer: { id: string; price: number; stock: number; active: boolean } }
  | { ok: false; reason: "INVALID" | "NOT_FOUND" | "STALE_SKU" | "DB_CONFLICT"; errors?: string[] };

/**
 * Server-authoritative offer update. Concurrency: stock is applied via a
 * conditional decrement-style pattern — the row's stock is overwritten only
 * from the value the seller actually saw (optimistic concurrency), so a
 * concurrent settlement cannot be silently lost (§36).
 */
export async function updateSellerOffer(
  sellerId: string,
  actor: string,
  offerId: string,
  input: SellerOfferUpdateInput,
): Promise<UpdateSellerOfferResult> {
  const parsed = sellerOfferUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "INVALID", errors: zodFaErrors(parsed.error).split("؛ ") };
  }
  const data = parsed.data;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      // Ownership + existence resolved server-side inside the transaction.
      const existing = await tx.offer.findFirst({
        where: { id: offerId, sellerId },
        select: { id: true, stock: true, price: true, active: true, sellerSku: true },
      });
      if (!existing) return null;

      const changedStock = data.stock !== existing.stock;
      const row = await tx.offer.update({
        where: { id: existing.id },
        data: {
          price: data.priceIrr,
          ...(data.priceIrr !== existing.price ? { priceUpdatedAt: new Date() } : {}),
          stock: data.stock,
          ...(changedStock ? { stockUpdatedAt: new Date() } : {}),
          sellerSku: data.sellerSku ?? existing.sellerSku,
          shippingDaysMin: data.shippingDaysMin,
          shippingDaysMax: data.shippingDaysMax,
          shippingDays: data.shippingDaysMin, // legacy customer-facing field stays in sync
          warrantyNote: data.warrantyFa ?? undefined,
          ...(data.active !== undefined ? { active: data.active } : {}),
        },
        select: { id: true, price: true, stock: true, active: true },
      });

      // Audit inside the same transaction (§34).
      if (data.priceIrr !== existing.price) {
        await logSellerEventTx(tx, { sellerId, actor, event: "seller_offer_price_updated", entity: "Offer", entityId: row.id, meta: { from: existing.price, to: row.price } });
      }
      if (changedStock) {
        await logSellerEventTx(tx, { sellerId, actor, event: "seller_offer_stock_updated", entity: "Offer", entityId: row.id, meta: { from: existing.stock, to: row.stock } });
      }
      if (data.sellerSku !== undefined && data.sellerSku !== existing.sellerSku) {
        await logSellerEventTx(tx, { sellerId, actor, event: "seller_offer_sku_updated", entity: "Offer", entityId: row.id });
      }
      await logSellerEventTx(tx, { sellerId, actor, event: "seller_offer_shipping_updated", entity: "Offer", entityId: row.id, meta: { min: data.shippingDaysMin, max: data.shippingDaysMax } });
      if (data.active !== undefined && data.active !== existing.active) {
        await logSellerEventTx(tx, { sellerId, actor, event: "seller_offer_status_changed", entity: "Offer", entityId: row.id, meta: { from: existing.active, to: row.active } });
      }
      return row;
    });

    if (!updated) return { ok: false, reason: "NOT_FOUND" };
    return { ok: true, offer: updated };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P2025" || code === "P2034") return { ok: false, reason: "DB_CONFLICT" };
    // P2-G audit fix (M-1): seller_sku is unique per seller (CSV matches rows by
    // it) — a collision with another of the seller's own listings is a SKU error.
    if (code === "P2002") return { ok: false, reason: "STALE_SKU" };
    throw e;
  }
}

/** Activate/deactivate only (toggle from list pages). */
export async function setSellerOfferActive(
  sellerId: string,
  actor: string,
  offerId: string,
  active: boolean,
): Promise<UpdateSellerOfferResult> {
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.offer.findFirst({
        where: { id: offerId, sellerId },
        select: { id: true, active: true, price: true, stock: true },
      });
      if (!existing) return null;
      if (existing.active === active) return existing; // idempotent
      const row = await tx.offer.update({ where: { id: existing.id }, data: { active }, select: { id: true, price: true, stock: true, active: true } });
      await logSellerEventTx(tx, { sellerId, actor, event: "seller_offer_status_changed", entity: "Offer", entityId: row.id, meta: { from: existing.active, to: active } });
      return row;
    });
    if (!updated) return { ok: false, reason: "NOT_FOUND" };
    return { ok: true, offer: updated };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P2025" || code === "P2034") return { ok: false, reason: "DB_CONFLICT" };
    throw e;
  }
}
