import { prisma } from "@/lib/prisma";
import { logAudit, canTransitionSellerStatus } from "@/lib/audit";
import type { SellerStatus } from "@prisma/client";

/**
 * ───────────────────── Seller governance (P2-E §18–19) ─────────────────────
 * Admin-only transitions with an explicit map + audit. Sellers cannot touch
 * sellerStatus/verified/rating (whitelisted profile schema from P2-D).
 */

export type GovernanceResult =
  | { ok: true; sellerId: string; status: SellerStatus; idempotent: boolean }
  | { ok: false; reason: "NOT_FOUND" | "INVALID_TRANSITION" | "SELF_GOVERNANCE" | "DB_CONFLICT"; detail?: string };

export async function transitionSellerStatus(input: {
  sellerId: string;
  to: SellerStatus;
  adminUserId: string;
}): Promise<GovernanceResult> {
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Row lock (P2-C/D pattern): concurrent approve+suspend serialize here;
      // the loser re-reads the committed status → valid final state always.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Seller" WHERE id = ${input.sellerId} FOR UPDATE
      `;
      if (locked.length === 0) return { ok: false as const, reason: "NOT_FOUND" as const };
      const seller = await tx.seller.findUniqueOrThrow({
        where: { id: input.sellerId },
        select: { id: true, sellerStatus: true, userId: true },
      });
      // P2-G audit fix (L-2): no self-governance. An admin must never be able to
      // approve/suspend a seller they themselves own. The identity compared is the
      // session-derived adminUserId (never a form field); onboarding already blocks
      // admins from applying, so this is the defence-in-depth backstop for any
      // legacy/seeded seller row that happens to be owned by an admin user.
      if (seller.userId && seller.userId === input.adminUserId) {
        return {
          ok: false as const,
          reason: "SELF_GOVERNANCE" as const,
          detail: "ادمین نمی‌تواند وضعیت فروشگاه خودش را تغییر دهد.",
        };
      }
      if (seller.sellerStatus === input.to) return { ok: true as const, sellerId: seller.id, status: input.to, idempotent: true };
      if (!canTransitionSellerStatus(seller.sellerStatus, input.to)) {
        return { ok: false as const, reason: "INVALID_TRANSITION" as const, detail: `تغییر از ${seller.sellerStatus} به ${input.to} مجاز نیست.` };
      }
      await tx.seller.update({ where: { id: seller.id }, data: { sellerStatus: input.to } });
      // Suspension also revokes the owner's sessions (§53) — immediate effect.
      if (input.to === "SUSPENDED" || input.to === "REJECTED") {
        const owner = await tx.seller.findUnique({ where: { id: seller.id }, select: { userId: true } });
        if (owner?.userId) {
          await tx.session.updateMany({ where: { userId: owner.userId, revokedAt: null }, data: { revokedAt: new Date() } });
        }
      }
      const event = { ACTIVE: "seller_approved", SUSPENDED: "seller_suspended", REJECTED: "seller_rejected", PENDING: "seller_reactivated" }[input.to] ?? "seller_status_changed";
      await tx.sellerEventLog.create({
        data: {
          sellerId: seller.id, actor: input.adminUserId, event, entity: "Seller", entityId: seller.id,
          meta: { to: input.to, from: seller.sellerStatus },
        },
      });
      return { ok: true as const, sellerId: seller.id, status: input.to, idempotent: false };
    });
    return result;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P2025" || code === "P2034") return { ok: false, reason: "DB_CONFLICT" };
    throw e;
  }
}

export async function getGovernanceList(filter: { status?: SellerStatus; q?: string }) {
  const where = {
    ...(filter.status ? { sellerStatus: filter.status } : {}),
    ...(filter.q?.trim() ? { businessName: { contains: filter.q.trim() } } : {}),
  };
  return prisma.seller.findMany({
    where,
    orderBy: [{ businessName: "asc" }],
    select: {
      id: true, businessName: true, phone: true, city: true, status: true, sellerStatus: true,
      verified: true, rating: true, userId: true, isRealSeller: true, // P2-G audit fix (M-3): admin sees seller origin
      _count: { select: { offers: true, orders: true } },
    },
  });
}

// ───────────────────── Shipment (P2-E §32–33) ─────────────────────

export const SHIPMENT_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["READY_TO_SHIP"],
  READY_TO_SHIP: ["SHIPPED"],
  SHIPPED: ["DELIVERED", "RETURNED"],
  DELIVERED: [],
  RETURNED: [],
};

export type ShipmentActionResult =
  | { ok: true; status: string; idempotent: boolean }
  | { ok: false; reason: "NOT_FOUND" | "INVALID_TRANSITION" | "TRACKING_REQUIRED"; detail?: string };

/**
 * Seller marks READY_TO_SHIP / SHIPPED (with tracking code) / DELIVERED.
 * Ownership: the seller order must belong to the authenticated seller. SHIPPED
 * requires a tracking code (§33) and advances the SellerOrder in lockstep.
 */
export async function updateShipment(input: {
  sellerOrderId: string;
  sellerId: string;
  actor: string;
  to: "READY_TO_SHIP" | "SHIPPED" | "DELIVERED";
  trackingCode?: string;
}): Promise<ShipmentActionResult> {
  const tracking = input.trackingCode?.trim().slice(0, 60);
  if (input.to === "SHIPPED" && !tracking) {
    return { ok: false, reason: "TRACKING_REQUIRED", detail: "برای ثبت ارسال، کد رهگیری الزامی است." };
  }
  try {
    const result = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT so.id FROM "SellerOrder" so
        WHERE so.id = ${input.sellerOrderId} AND so."sellerId" = ${input.sellerId}
        FOR UPDATE
      `;
      if (locked.length === 0) return { ok: false as const, reason: "NOT_FOUND" as const };

      const so = await tx.sellerOrder.findUniqueOrThrow({
        where: { id: input.sellerOrderId },
        include: { shipment: true },
      });
      const shipment = so.shipment ?? await tx.shipment.create({ data: { sellerOrderId: so.id, status: "PENDING" } });
      if (shipment.status === input.to) return { ok: true as const, status: input.to, idempotent: true };
      if (!(SHIPMENT_TRANSITIONS[shipment.status] ?? []).includes(input.to)) {
        return { ok: false as const, reason: "INVALID_TRANSITION" as const, detail: `تغییر از ${shipment.status} به ${input.to} مجاز نیست.` };
      }

      const now = new Date();
      await tx.shipment.update({
        where: { id: shipment.id },
        data: {
          status: input.to,
          ...(tracking ? { trackingCode: tracking } : {}),
          ...(input.to === "SHIPPED" ? { shippedAt: now } : {}),
          ...(input.to === "DELIVERED" ? { deliveredAt: now } : {}),
        },
      });
      // SellerOrder mirrors shipment progress (single source per stage).
      if (input.to === "READY_TO_SHIP") {
        await tx.sellerOrder.update({ where: { id: so.id }, data: { status: "PENDING" } }); // stays PENDING (awaiting confirmation gate is settlement); no-op mirror
      }
      if (input.to === "SHIPPED") {
        await tx.sellerOrder.update({ where: { id: so.id }, data: { status: "SHIPPED" } });
      }
      if (input.to === "DELIVERED") {
        await tx.sellerOrder.update({ where: { id: so.id }, data: { status: "DELIVERED" } });
      }
      await tx.sellerEventLog.create({
        data: {
          sellerId: input.sellerId, actor: input.actor, event: "seller_order_status_changed",
          entity: "Shipment", entityId: shipment.id, meta: { to: input.to, tracking: tracking ?? null, sellerOrderId: so.id },
        },
      });
      return { ok: true as const, status: input.to, idempotent: false };
    });
    return result;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P2025" || code === "P2034") return { ok: false, reason: "NOT_FOUND" };
    throw e;
  }
}

/** Customer-facing order detail service (ownership-aware, §30, §40). */
export async function getCustomerOrder(owner: { userId?: string; sessionId?: string }, orderId: string) {
  return prisma.order.findFirst({
    where: { id: orderId, OR: [{ sessionId: owner.sessionId }, { userId: owner.userId }] },
    include: {
      sellerOrders: {
        include: {
          seller: { select: { businessName: true, verified: true, sellerStatus: true } },
          items: {
            include: {
              offer: { include: { part: { select: { title: true, sku: true } } } },
              returnRequests: { where: { status: { notIn: ["REJECTED", "CANCELLED", "REFUNDED"] } }, select: { id: true, status: true } },
            },
          },
          shipment: true,
        },
      },
      payments: { orderBy: { createdAt: "asc" } },
    },
  });
}
