import { prisma } from "@/lib/prisma";
import { logSellerEventTx } from "@/lib/seller/seller-audit";
import type { Prisma, SellerOrderStatus } from "@prisma/client";

// PROCESSING / READY_TO_SHIP extend the Phase-1 DB enum at the service layer
// (see state-machine note below); DB migration deferred by design.
export const SELLER_WORKFLOW_STATUSES = [
  "PENDING", "CONFIRMED", "PROCESSING", "READY_TO_SHIP", "SHIPPED", "DELIVERED", "CANCELLED", "RETURNED",
] as const;
export type WorkflowStatus = (typeof SELLER_WORKFLOW_STATUSES)[number];

/**
 * ───────────────────── Seller order state machine (P2-D, §26) ─────────────────────
 * Explicit transitions only; arbitrary jumps are rejected. CONFIRMED is the
 * post-payment entry state written by settlement (Phase 1). Duplicate delivery
 * of the same mutation is idempotent: DELIVERED→DELIVERED returns ok without a
 * second audit row; CANCELLED/RETURNED are terminal.
 *
 * PROCESSING / READY_TO_SHIP extend the Phase-1 DB enum at the service layer
 * for seller workflow; the DB column keeps storing Phase-1 values for PENDING,
 * CONFIRMED, SHIPPED, DELIVERED, CANCELLED, RETURNED — the two workflow-only
 * values require a DB enum migration, deferred until the phase proves the
 * flow (documented in PHASE2-D-ORDERS.md). Until then the service accepts
 * them only as *targets* when the DB enum allows: see WORKFLOW_TARGETS below.
 */

const TRANSITIONS: Record<string, WorkflowStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["SHIPPED", "CANCELLED"], // PROCESSING/READY_TO_SHIP need a DB enum migration (see above)
  SHIPPED: ["DELIVERED", "RETURNED"],
  DELIVERED: [],
  CANCELLED: [],
  RETURNED: [],
};

export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export type SellerOrderListRow = {
  id: string;
  orderNumber: string;
  status: string;
  subtotal: number;
  shipping: number;
  itemCount: number;
  createdAt: Date;
  orderStatus: string;
  paymentStatus: string;
};

export async function getSellerOrders(
  sellerId: string,
  filters: { status?: string; page?: number; pageSize?: number } = {},
): Promise<{ rows: SellerOrderListRow[]; total: number }> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(5, filters.pageSize ?? 20));
  const where: Prisma.SellerOrderWhereInput = { sellerId };
  if (filters.status) where.status = filters.status as SellerOrderStatus;

  const [rows, total] = await Promise.all([
    prisma.sellerOrder.findMany({
      where,
      orderBy: [{ id: "desc" }],
      include: { order: { select: { orderNumber: true, status: true, paymentStatus: true, createdAt: true } }, items: { select: { quantity: true } } },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.sellerOrder.count({ where }),
  ]);

  return {
    rows: rows.map((so) => ({
      id: so.id,
      orderNumber: so.order.orderNumber,
      status: so.status,
      subtotal: so.subtotal,
      shipping: so.shipping,
      itemCount: so.items.reduce((s, i) => s + i.quantity, 0),
      createdAt: so.order.createdAt,
      orderStatus: so.order.status,
      paymentStatus: so.order.paymentStatus,
    })),
    total,
  };
}

export type SellerOrderDetail = {
  id: string;
  orderNumber: string;
  status: WorkflowStatus;
  subtotal: number;
  shipping: number;
  orderStatus: string;
  paymentStatus: string;
  createdAt: Date;
  items: {
    id: string;
    partTitle: string;
    partSku: string;
    quantity: number;
    unitPrice: number; // SNAPSHOT — never the current Offer.price (§25, §28)
    total: number;
  }[];
  allowedNext: WorkflowStatus[];
};

export async function getSellerOrder(sellerId: string, sellerOrderId: string): Promise<SellerOrderDetail | null> {
  const so = await prisma.sellerOrder.findFirst({
    where: { id: sellerOrderId, sellerId }, // ownership in the WHERE — no existence leak
    include: {
      order: { select: { orderNumber: true, status: true, paymentStatus: true, createdAt: true } },
      items: { include: { offer: { include: { part: { select: { title: true, sku: true } } } } } },
    },
  });
  if (!so) return null;
  return {
    id: so.id,
    orderNumber: so.order.orderNumber,
    status: so.status as WorkflowStatus,
    subtotal: so.subtotal,
    shipping: so.shipping,
    orderStatus: so.order.status,
    paymentStatus: so.order.paymentStatus,
    createdAt: so.order.createdAt,
    items: so.items.map((it) => ({
      id: it.id,
      partTitle: it.offer.part.title,
      partSku: it.offer.part.sku,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      total: it.total,
    })),
    allowedNext: TRANSITIONS[so.status as WorkflowStatus] ?? [],
  };
}

export type UpdateOrderStatusResult =
  | { ok: true; status: WorkflowStatus; idempotent: boolean }
  | { ok: false; reason: "NOT_FOUND" | "INVALID_TRANSITION" | "ORDER_NOT_PAID" | "DB_CONFLICT"; detail?: string };

/**
 * Seller order status mutation. Authorization + transition validation happen
 * server-side inside one transaction; a PENDING/UNPAID parent order can only
 * move to CANCELLED (seller may cancel an unpaid suborder).
 */
export async function updateSellerOrderStatus(
  sellerId: string,
  actor: string,
  sellerOrderId: string,
  next: WorkflowStatus,
): Promise<UpdateOrderStatusResult> {
  if (!(SELLER_WORKFLOW_STATUSES as readonly string[]).includes(next)) {
    return { ok: false, reason: "INVALID_TRANSITION", detail: "وضعیت نامعتبر است." };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Row lock FIRST (§38): concurrent duplicate transitions serialize on the
      // SellerOrder row, so the second caller re-reads the committed status
      // (READ COMMITTED) and becomes an idempotent no-op or an invalid
      // transition — never a second side effect. Scope: one row of one seller.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "SellerOrder"
        WHERE id = ${sellerOrderId} AND "sellerId" = ${sellerId}
        FOR UPDATE
      `;
      if (locked.length === 0) return { ok: false as const, reason: "NOT_FOUND" as const };

      const so = await tx.sellerOrder.findUniqueOrThrow({
        where: { id: sellerOrderId },
        select: { id: true, status: true, order: { select: { paymentStatus: true } } },
      });

      const current = so.status as WorkflowStatus;
      if (current === next) return { ok: true as const, status: current, idempotent: true }; // duplicate submit = no-op, no dup audit
      if (!canTransition(current, next)) {
        return { ok: false as const, reason: "INVALID_TRANSITION" as const, detail: `تغییر از ${current} به ${next} مجاز نیست.` };
      }
      // Cancel of a suborder whose payment already succeeded must not happen
      // behind the customer's back — that flow is RETURNED (post-delivery).
      if (next === "CANCELLED" && so.order.paymentStatus === "SUCCEEDED") {
        return { ok: false as const, reason: "ORDER_NOT_PAID" as const, detail: "سفارش پرداخت‌شده قابل لغو نیست؛ از RETURNED استفاده کنید." };
      }

      await tx.sellerOrder.update({ where: { id: so.id }, data: { status: next as SellerOrderStatus } });
      await logSellerEventTx(tx, {
        sellerId, actor, event: "seller_order_status_changed", entity: "SellerOrder", entityId: so.id,
        meta: { from: current, to: next },
      });
      return { ok: true as const, status: next, idempotent: false };
    });
    return result;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P2025" || code === "P2034") return { ok: false, reason: "DB_CONFLICT" };
    throw e;
  }
}
