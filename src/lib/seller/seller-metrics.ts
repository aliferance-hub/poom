import { prisma } from "@/lib/prisma";

/**
 * ───────────────────── Seller metrics (P2-D, §30–31) ─────────────────────
 * All values come from real DB rows. Where the demo dataset cannot support a
 * metric (e.g. response time — no data), it is reported as null and the UI
 * shows «—» instead of fabricating a number.
 */
export type SellerMetrics = {
  activeOffers: number;
  outOfStockOffers: number;
  lowStockOffers: number;
  openOrders: number; // PENDING/CONFIRMED (not yet shipped)
  completedOrders: number; // DELIVERED
  cancelledOrders: number; // CANCELLED + RETURNED
  totalOrders: number;
  cancellationRate: number | null; // completed denominator required
  rating: number; // admin-controlled input (Seller.rating)
  responseRate: number | null; // stored field, DEMO provenance
  responseTimeDays: null; // no data source yet — explicitly not fabricated
};

export async function getSellerMetrics(sellerId: string): Promise<SellerMetrics> {
  const [activeOffers, outOfStockOffers, lowStockOffers, byStatus, seller] = await Promise.all([
    prisma.offer.count({ where: { sellerId, active: true } }),
    prisma.offer.count({ where: { sellerId, stock: 0 } }),
    prisma.offer.count({ where: { sellerId, AND: [{ stock: { gt: 0 } }, { stock: { lte: prisma.offer.fields.lowStockThreshold } }] } }),
    prisma.sellerOrder.groupBy({ by: ["status"], where: { sellerId }, _count: { _all: true } }),
    prisma.seller.findUnique({ where: { id: sellerId }, select: { rating: true, responseRate: true } }),
  ]);

  const count = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
  const openOrders = count("PENDING") + count("CONFIRMED");
  const completedOrders = count("DELIVERED");
  const cancelledOrders = count("CANCELLED") + count("RETURNED");
  const totalOrders = byStatus.reduce((s, r) => s + r._count._all, 0);

  return {
    activeOffers,
    outOfStockOffers,
    lowStockOffers,
    openOrders,
    completedOrders,
    cancelledOrders,
    totalOrders,
    cancellationRate: totalOrders > 0 ? cancelledOrders / totalOrders : null,
    rating: seller?.rating ?? 0,
    responseRate: seller?.responseRate ?? null,
    responseTimeDays: null,
  };
}

/**
 * Deterministic, explainable demo score (§31) — explicitly labeled «نمایشی» in
 * the UI. Weights are documented here and in PHASE2-D-SELLER.md; no «AI» claim.
 *   score = 40% fulfillment (completed/total) + 30% low cancellation + 30% admin rating
 */
export function computeDemoScore(m: Pick<SellerMetrics, "completedOrders" | "totalOrders" | "cancellationRate" | "rating">): { score: number; parts: { fulfillment: number; reliability: number; rating: number } } {
  const fulfillment = m.totalOrders > 0 ? m.completedOrders / m.totalOrders : 0;
  const reliability = m.cancellationRate === null ? 0 : 1 - m.cancellationRate;
  const rating = Math.max(0, Math.min(1, m.rating / 5));
  const score = Math.round((0.4 * fulfillment + 0.3 * reliability + 0.3 * rating) * 100);
  return { score, parts: { fulfillment, reliability, rating } };
}
