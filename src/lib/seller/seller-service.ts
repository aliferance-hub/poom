import { prisma } from "@/lib/prisma";
import { sellerProfileUpdateSchema, zodFaErrors, type SellerProfileUpdateInput } from "@/lib/seller/seller-validation";
import { logSellerEventTx } from "@/lib/seller/seller-audit";
import { getInventorySummary, type InventorySummary } from "@/lib/seller/seller-inventory";
import { getSellerMetrics, type SellerMetrics } from "@/lib/seller/seller-metrics";
import type { SellerOrderStatus } from "@prisma/client";

/**
 * ───────────────────── Seller dashboard + profile (P2-D) ─────────────────────
 * Dashboard values are real DB data; demo provenance is labeled in the UI
 * («داده نمایشی»), never in the service — the service reports facts only.
 */
export type SellerDashboard = {
  seller: { id: string; businessName: string; status: string; verified: boolean; rating: number };
  todaySalesIrr: number;
  todayOrders: number;
  newOrders: number; // PENDING/CONFIRMED
  inventory: InventorySummary;
  metrics: SellerMetrics;
  recentOrders: { id: string; orderNumber: string; status: SellerOrderStatus | string; subtotal: number; itemCount: number }[];
};

export async function getSellerDashboard(identity: { sellerId: string }): Promise<SellerDashboard> {
  const { sellerId } = identity;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [seller, inventory, metrics, recent, paidToday] = await Promise.all([
    prisma.seller.findUniqueOrThrow({
      where: { id: sellerId },
      select: { id: true, businessName: true, status: true, verified: true, rating: true },
    }),
    getInventorySummary(sellerId),
    getSellerMetrics(sellerId),
    prisma.sellerOrder.findMany({
      where: { sellerId },
      orderBy: [{ id: "desc" }],
      take: 6,
      include: { order: { select: { orderNumber: true } }, items: { select: { quantity: true } } },
    }),
    // «فروش امروز»: sum of PAID seller suborders whose parent order was created
    // today. Demo dataset is usually 0 — the UI labels it «داده نمایشی».
    prisma.sellerOrder.aggregate({
      where: { sellerId, order: { paymentStatus: "SUCCEEDED", createdAt: { gte: startOfDay } } },
      _sum: { subtotal: true },
      _count: { _all: true },
    }),
  ]);

  return {
    seller,
    todaySalesIrr: paidToday._sum.subtotal ?? 0,
    todayOrders: paidToday._count._all,
    newOrders: metrics.openOrders,
    inventory,
    metrics,
    recentOrders: recent.map((so) => ({
      id: so.id,
      orderNumber: so.order.orderNumber,
      status: so.status,
      subtotal: so.subtotal,
      itemCount: so.items.reduce((s, i) => s + i.quantity, 0),
    })),
  };
}

export type UpdateProfileResult =
  | { ok: true; seller: { id: string; businessName: string } }
  | { ok: false; reason: "INVALID" | "NOT_FOUND"; errors?: string[] };

/**
 * Profile update: ONLY seller-owned display fields. verified/rating/status/
 * responseRate are admin- or system-controlled and are NOT accepted here —
 * the Zod schema is the whitelist (§32, §33).
 */
export async function updateSellerProfile(
  sellerId: string,
  actor: string,
  input: unknown,
): Promise<UpdateProfileResult> {
  const parsed = sellerProfileUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID", errors: zodFaErrors(parsed.error).split("؛ ") };
  const d = parsed.data;

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.seller.findUnique({ where: { id: sellerId }, select: { id: true } });
    if (!existing) return null;
    const seller = await tx.seller.update({
      where: { id: sellerId },
      data: {
        businessName: d.businessName,
        ownerName: d.ownerName || null,
        phone: d.phone || null,
        city: d.city || null,
        address: d.address || null,
      },
      select: { id: true, businessName: true },
    });
    await logSellerEventTx(tx, { sellerId, actor, event: "seller_profile_updated", entity: "Seller", entityId: seller.id });
    return seller;
  });

  if (!result) return { ok: false, reason: "NOT_FOUND" };
  return { ok: true, seller: result };
}
