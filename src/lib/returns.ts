import { prisma } from "@/lib/prisma";
import { logAudit, logAuditTx } from "@/lib/audit";
import type { Prisma, ReturnStatus } from "@prisma/client";

/**
 * ───────────────────── Returns (P2-E §34–38) ─────────────────────
 * Eligibility is CALCULATED from authoritative state (order paid, seller order
 * delivered, policy window vs delivered-at/deliveredAt timestamp) — never from
 * hard-coded prose. Policy values are DB-configurable and carry a
 * needsLegalVerification flag (§36, §69): the demo 7-day window is a placeholder
 * until policy/legal review.
 */

export const RETURN_TRANSITIONS: Record<ReturnStatus, ReturnStatus[]> = {
  REQUESTED: ["UNDER_REVIEW", "APPROVED", "REJECTED", "CANCELLED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["RECEIVED", "CANCELLED"],
  REJECTED: [],
  RECEIVED: ["REFUND_PENDING"],
  REFUND_PENDING: ["REFUNDED", "REFUND_FAILED" as ReturnStatus].filter((s): s is ReturnStatus => s !== "REFUND_FAILED"),
  REFUNDED: [],
  CANCELLED: [],
};

export function canTransitionReturn(from: ReturnStatus, to: ReturnStatus): boolean {
  return (RETURN_TRANSITIONS[from] ?? []).includes(to);
}

async function activePolicy() {
  return prisma.returnPolicy.findFirst({ where: { active: true }, orderBy: { returnWindowDays: "asc" } });
}

export type ReturnEligibility =
  | { eligible: true; windowDays: number; needsLegalVerification: boolean; noteFa: string | null }
  | { eligible: false; reason: string };

/** Ownership-aware eligibility: the caller supplies the resolved owner context. */
export async function getReturnEligibility(
  orderItemId: string,
  owner: { userId?: string; sessionId?: string },
): Promise<ReturnEligibility> {
  const item = await prisma.orderItem.findFirst({
    where: { id: orderItemId, sellerOrder: { order: { OR: [{ sessionId: owner.sessionId }, { userId: owner.userId }] } } },
    include: { sellerOrder: { include: { shipment: true, order: true } }, returnRequests: true },
  });
  if (!item) return { eligible: false, reason: "این قلم متعلق به سفارش شما نیست یا یافت نشد." };
  if (item.returnRequests.some((r) => !["REJECTED", "CANCELLED", "REFUNDED"].includes(r.status))) {
    return { eligible: false, reason: "برای این قلم قبلاً درخواست مرجوعی فعالی ثبت شده است." };
  }
  const so = item.sellerOrder;
  if (so.order.paymentStatus !== "SUCCEEDED") return { eligible: false, reason: "سفارش پرداخت نشده است." };
  if (so.status === "CANCELLED") return { eligible: false, reason: "سفارش لغو شده است." };

  const policy = await activePolicy();
  if (!policy) return { eligible: false, reason: "سیاست مرجوعی پیکربندی نشده است." };
  if (policy.requiresDelivered && so.status !== "DELIVERED" && so.shipment?.status !== "DELIVERED") {
    return { eligible: false, reason: "درخواست مرجوعی پس از تحویل سفارش امکان‌پذیر است." };
  }

  const deliveredAt = so.shipment?.deliveredAt ?? so.shipment?.shippedAt ?? so.order.createdAt;
  const windowEnd = deliveredAt.getTime() + policy.returnWindowDays * 86_400_000;
  if (Date.now() > windowEnd) {
    return { eligible: false, reason: `مهلت مرجوعی (${policy.returnWindowDays} روز) گذشته است.` };
  }
  return {
    eligible: true,
    windowDays: policy.returnWindowDays,
    needsLegalVerification: policy.needsLegalVerification,
    noteFa: policy.noteFa,
  };
}

export type CreateReturnResult =
  | { ok: true; returnId: string; status: ReturnStatus }
  | { ok: false; reason: "ELIGIBILITY" | "RATE_LIMITED" | "INVALID"; detail?: string };

/**
 * Create a return request. Duplicate concurrent requests are safe: the partial
 * unique index (one active request per OrderItem) makes the second insert fail;
 * the loser re-reads and returns the existing request (idempotent UX, §61).
 */
export async function createReturnRequest(input: {
  orderItemId: string;
  reason: string;
  notes?: string;
  owner: { userId?: string; sessionId?: string };
  actor: string;
}): Promise<CreateReturnResult> {
  const reason = input.reason.trim().slice(0, 500);
  if (reason.length < 3) return { ok: false, reason: "INVALID", detail: "دلیل مرجوعی الزامی است." };

  const eligibility = await getReturnEligibility(input.orderItemId, input.owner);
  if (!eligibility.eligible) return { ok: false, reason: "ELIGIBILITY", detail: eligibility.reason };

  try {
    const created = await prisma.$transaction(async (tx) => {
      const item = await tx.orderItem.findFirstOrThrow({ where: { id: input.orderItemId }, select: { sellerOrderId: true } });
      const so = await tx.sellerOrder.findUniqueOrThrow({ where: { id: item.sellerOrderId }, select: { sellerId: true } });
      const rr = await tx.returnRequest.create({
        data: {
          orderItemId: input.orderItemId,
          userId: input.owner.userId ?? null,
          sessionId: input.owner.sessionId ?? null,
          reason,
          notes: input.notes?.trim().slice(0, 500) || null,
          status: "REQUESTED",
        },
      });
      await logAuditTx(tx, {
        actor: input.actor, event: "return_created", entity: "ReturnRequest", entityId: rr.id,
        sellerId: so.sellerId, meta: { orderItemId: input.orderItemId },
      });
      return rr;
    });
    return { ok: true, returnId: created.id, status: created.status };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P2002") {
      // concurrent duplicate → resolve to the existing active request
      const existing = await prisma.returnRequest.findFirst({
        where: { orderItemId: input.orderItemId, status: { notIn: ["REJECTED", "CANCELLED", "REFUNDED"] } },
        select: { id: true, status: true },
      });
      if (existing) return { ok: true, returnId: existing.id, status: existing.status };
      return { ok: false, reason: "INVALID", detail: "درخواست تکراری است." };
    }
    if (code === "P2025" || code === "P2034") return { ok: false, reason: "INVALID", detail: "قلم سفارش یافت نشد." };
    throw e;
  }
}

export type TransitionReturnResult =
  | { ok: true; status: ReturnStatus; idempotent: boolean }
  | { ok: false; reason: "NOT_FOUND" | "INVALID_TRANSITION" | "REFUND_BLOCKED"; detail?: string };

/** Return state transition with audit; refund rows are created at APPROVED→RECEIVED→REFUND_PENDING (§38). */
export async function transitionReturn(input: {
  returnRequestId: string;
  to: ReturnStatus;
  actor: string;
  sellerId?: string; // when set, ownership of the return's seller order is verified
  decisionNote?: string;
}): Promise<TransitionReturnResult> {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const rr = await tx.returnRequest.findFirst({
        where: {
          id: input.returnRequestId,
          ...(input.sellerId ? { orderItem: { sellerOrder: { sellerId: input.sellerId } } } : {}),
        },
        include: { orderItem: { include: { sellerOrder: { include: { shipment: true } } } } },
      });
      if (!rr) return { ok: false as const, reason: "NOT_FOUND" as const };
      if (rr.status === input.to) return { ok: true as const, status: rr.status, idempotent: true };
      if (!canTransitionReturn(rr.status, input.to)) {
        return { ok: false as const, reason: "INVALID_TRANSITION" as const, detail: `تغییر از ${rr.status} به ${input.to} مجاز نیست.` };
      }
      if (input.to === "REFUND_PENDING" && !["RECEIVED"].includes(rr.status)) {
        return { ok: false as const, reason: "REFUND_BLOCKED" as const };
      }
      await tx.returnRequest.update({
        where: { id: rr.id },
        data: { status: input.to, decisionNote: input.decisionNote?.slice(0, 300) ?? undefined },
      });
      // Refund foundation: PENDING refund row when entering REFUND_PENDING; the
      // actual money movement is a later-phase integration — never faked here.
      let refundCreated = false;
      if (input.to === "REFUND_PENDING") {
        const existing = await tx.refund.findUnique({ where: { returnRequestId: rr.id } });
        if (!existing) {
          await tx.refund.create({ data: { returnRequestId: rr.id, amountIrr: rr.orderItem.total, status: "PENDING" } });
          refundCreated = true;
        }
      }
      await logAuditTx(tx, {
        actor: input.actor, event: "return_state_changed", entity: "ReturnRequest", entityId: rr.id,
        sellerId: rr.orderItem.sellerOrder.sellerId,
        meta: { from: rr.status, to: input.to, ...(refundCreated ? { refund: "PENDING_CREATED" } : {}) },
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

export type ReturnView = {
  id: string;
  orderItemId: string;
  partTitle: string;
  quantity: number;
  amountIrr: number;
  reason: string;
  status: ReturnStatus;
  createdAt: Date;
};

/** Ownership-scoped list for the customer account. */
export async function getMyReturns(owner: { userId?: string; sessionId?: string }): Promise<ReturnView[]> {
  const rows = await prisma.returnRequest.findMany({
    where: { OR: [{ userId: owner.userId }, ...(owner.sessionId ? [{ sessionId: owner.sessionId }] : [])] },
    orderBy: { createdAt: "desc" },
    include: { orderItem: { include: { offer: { include: { part: { select: { title: true } } } } } } },
    take: 50,
  });
  return rows.map((r) => ({
    id: r.id,
    orderItemId: r.orderItemId,
    partTitle: r.orderItem.offer.part.title,
    quantity: r.orderItem.quantity,
    amountIrr: r.orderItem.total,
    reason: r.reason,
    status: r.status,
    createdAt: r.createdAt,
  }));
}

export type { Prisma };
