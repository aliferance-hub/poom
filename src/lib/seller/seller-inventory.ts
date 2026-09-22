import { prisma } from "@/lib/prisma";

/**
 * ───────────────────── Inventory freshness (P2-D, §15–16) ─────────────────────
 * Simple, documented, deterministic policy — NOT real-time monitoring.
 *   fresh : stockUpdatedAt within FRESH_HOURS (default 48h)
 *   stale : older / never updated
 * Threshold is a service constant surfaced in the UI, never hard-coded in React.
 */
export const FRESH_HOURS = 48;
export const STALE_LABEL_FA = "بیش از ۴۸ ساعت";

export function freshState(stockUpdatedAt: Date | null, now: Date = new Date()): "fresh" | "stale" {
  if (!stockUpdatedAt) return "stale";
  const ageMs = now.getTime() - stockUpdatedAt.getTime();
  return ageMs <= FRESH_HOURS * 3600_000 ? "fresh" : "stale";
}

export type InventoryBucket = "in_stock" | "low_stock" | "out_of_stock";

export function bucketOf(stock: number, lowStockThreshold: number): InventoryBucket {
  if (stock === 0) return "out_of_stock";
  if (stock <= lowStockThreshold) return "low_stock";
  return "in_stock";
}

export const BUCKET_FA: Record<InventoryBucket, string> = {
  in_stock: "موجود",
  low_stock: "کم‌موجود",
  out_of_stock: "ناموجود",
};

export type InventorySummary = {
  totalOffers: number;
  active: number;
  inactive: number;
  inStock: number;
  lowStock: number;
  outOfStock: number;
  stale: number;
};

/** One aggregation query set for the inventory page + dashboard cards. */
export async function getInventorySummary(sellerId: string): Promise<InventorySummary> {
  const freshCutoff = new Date(Date.now() - FRESH_HOURS * 3600_000);
  const [totalOffers, active, inactive, outOfStock, lowStock, stale] = await Promise.all([
    prisma.offer.count({ where: { sellerId } }),
    prisma.offer.count({ where: { sellerId, active: true } }),
    prisma.offer.count({ where: { sellerId, active: false } }),
    prisma.offer.count({ where: { sellerId, stock: 0 } }),
    prisma.offer.count({ where: { sellerId, AND: [{ stock: { gt: 0 } }, { stock: { lte: prisma.offer.fields.lowStockThreshold } }] } }),
    prisma.offer.count({ where: { sellerId, OR: [{ stockUpdatedAt: null }, { stockUpdatedAt: { lt: freshCutoff } }] } }),
  ]);
  return { totalOffers, active, inactive, inStock: totalOffers - outOfStock - lowStock, lowStock, outOfStock, stale };
}

/** Persian relative-ish timestamp for freshness display (no fake real-time claims). */
export function freshnessLabel(stockUpdatedAt: Date | null): string {
  if (!stockUpdatedAt) return `آخرین بروزرسانی: ${STALE_LABEL_FA} پیش`;
  const fresh = freshState(stockUpdatedAt);
  const d = stockUpdatedAt;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return fresh ? `موجودی اخیراً بروزرسانی شده (امروز، ${hh}:${mm})` : `آخرین بروزرسانی: ${STALE_LABEL_FA} پیش`;
}
