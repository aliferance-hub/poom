import { prisma } from "@/lib/prisma";

export type OfferSort = "best" | "cheapest" | "fastest" | "rating";

export const OFFER_SORTS: { key: OfferSort; label: string }[] = [
  { key: "best", label: "بهترین پیشنهاد" },
  { key: "cheapest", label: "ارزان‌ترین" },
  { key: "fastest", label: "سریع‌ترین ارسال" },
  { key: "rating", label: "بالاترین امتیاز فروشنده" },
];

export type StockState = "in" | "low" | "out";

export function stockState(o: { stock: number; lowStockThreshold: number }): StockState {
  if (o.stock <= 0) return "out";
  if (o.stock <= o.lowStockThreshold) return "low";
  return "in";
}

export function stockLabel(state: StockState): string {
  return state === "in" ? "موجود" : state === "low" ? "کم‌موجود" : "ناموجود";
}

/**
 * Offers for a part with marketplace sorts; only active offers whose seller is
 * governance-ACTIVE are returned (P2-E §18: suspended/rejected sellers' offers
 * disappear from the customer marketplace immediately).
 */
export async function getOffersForPart(partId: string, sort: OfferSort = "best") {
  const offers = await prisma.offer.findMany({
    where: { partId, active: true, seller: { sellerStatus: "ACTIVE" } },
    include: { seller: true },
  });

  const rank: Record<StockState, number> = { in: 0, low: 1, out: 2 };
  const scoreBest = (o: (typeof offers)[number]) => {
    const s = stockState(o);
    return rank[s] * 10_000_000_000 + o.price + o.shippingDays * 100_000 - o.seller.rating * 1_000;
  };

  const sorted = [...offers].sort((a, b) => {
    switch (sort) {
      case "cheapest":
        return a.price - b.price;
      case "fastest":
        return a.shippingDays - b.shippingDays || a.price - b.price;
      case "rating":
        return b.seller.rating - a.seller.rating || a.price - b.price;
      case "best":
      default:
        return scoreBest(a) - scoreBest(b);
    }
  });
  return sorted;
}
