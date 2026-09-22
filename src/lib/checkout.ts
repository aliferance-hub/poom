import { prisma } from "@/lib/prisma";
import { getCartView } from "@/lib/cart";
import { paymentService, nextAttemptNumber, newIdempotencyKey } from "@/lib/payments";
import { logAudit, logAuditTx } from "@/lib/audit";
import { rateLimiter, RATE_LIMITS } from "@/lib/auth/rate-limit";

export type CheckoutValidation = {
  ok: boolean;
  problems: string[];
  fitmentWarnings: string[];
};

/**
 * State machine (explicit):
 *   CART → (validate) → ORDER:PENDING_PAYMENT + PAYMENT:PENDING
 *        → gateway outcome → on SUCCESS: tx{ stock--, PAYMENT:SUCCEEDED, ORDER:PAID, SellerOrders:CONFIRMED }
 *                          → on FAILURE: PAYMENT:FAILED (stock untouched, order retryable)
 * Stock is NEVER decremented before payment success. No blind decrements.
 */
export async function validateCartForCheckout(sessionId: string, variantId?: string): Promise<CheckoutValidation> {
  const view = await getCartView(sessionId);
  const problems: string[] = [...view.errors];
  const fitmentWarnings: string[] = [];

  for (const line of view.lines) {
    if (line.offer.stock < line.quantity) {
      problems.push(`موجودی کافی نیست: «${line.offer.part.title}» (${line.offer.stock} عدد).`);
    }
    if (variantId) {
      const fitment = await prisma.fitment.findFirst({
        where: { partId: line.offer.partId, variantId, fitmentStatus: { in: ["CONFIRMED", "PARTIAL"] } },
      });
      if (!fitment) {
        const rejected = await prisma.fitment.findFirst({
          where: { partId: line.offer.partId, variantId, fitmentStatus: "REJECTED" },
        });
        if (rejected) problems.push(`«${line.offer.part.title}» با خودروی انتخابی شما سازگار نیست.`);
        else fitmentWarnings.push(`سازگاری «${line.offer.part.title}» برای خودروی شما تأیید نشده است.`);
      }
    }
  }
  if (view.lines.length === 0) problems.push("سبد خرید خالی است.");
  return { ok: problems.length === 0, problems, fitmentWarnings };
}

export async function createCheckout(sessionId: string, variantId?: string) {
  // §44 abuse damping: initiating a payment is rate-limited per session.
  const rl = await rateLimiter.check(`pay:${sessionId}`, RATE_LIMITS.paymentInitiate.limit, RATE_LIMITS.paymentInitiate.windowMs);
  if (!rl.allowed) return { ok: false as const, validation: { ok: false, problems: ["تعداد تلاش‌های پرداخت بیش از حد مجاز است؛ چند لحظه بعد دوباره تلاش کنید."], fitmentWarnings: [] } };

  const validation = await validateCartForCheckout(sessionId, variantId);
  if (!validation.ok) return { ok: false as const, validation };

  const view = await getCartView(sessionId);
  const orderNumber = `POOM-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const order = await prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        orderNumber,
        sessionId,
        status: "PENDING_PAYMENT",
        paymentStatus: "PENDING",
        total: view.subtotal,
        shippingTotal: 0,
      },
    });

    // Group lines per seller → SellerOrder + OrderItem (multi-seller baskets).
    const bySeller = new Map<string, typeof view.lines>();
    for (const line of view.lines) {
      const list = bySeller.get(line.offer.sellerId) ?? [];
      list.push(line);
      bySeller.set(line.offer.sellerId, list);
    }
    for (const [sellerId, lines] of bySeller) {
      const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
      const sellerOrder = await tx.sellerOrder.create({
        data: { orderId: order.id, sellerId, status: "PENDING", subtotal, shipping: 0 },
      });
      for (const l of lines) {
        await tx.orderItem.create({
          data: {
            sellerOrderId: sellerOrder.id,
            partId: l.offer.partId,
            offerId: l.offerId,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            total: l.lineTotal,
          },
        });
      }
    }
    return order;
  });

  // §24: the amount is authoritative from DB state (view.subtotal was computed
  // server-side from server prices); the browser never supplies it.
  const ps = paymentService();
  const payment = await ps.createPayment({ orderId: order.id, orderNumber, amountIRR: view.subtotal });
  // §23: record the immutable attempt ledger entry alongside the legacy row.
  const paymentRow = await prisma.payment.findUniqueOrThrow({ where: { authority: payment.authority }, select: { id: true } });
  await prisma.paymentAttempt.create({
    data: {
      paymentId: paymentRow.id,
      attemptNumber: 1,
      provider: ps.provider,
      amountIrr: view.subtotal,
      authority: payment.authority,
      idempotencyKey: newIdempotencyKey(`order:${order.id}`),
    },
  });
  await logAudit({ actor: `guest:${sessionId}`, event: "order_created", entity: "Order", entityId: order.id, meta: { orderNumber, total: view.subtotal } });
  await logAudit({ actor: `guest:${sessionId}`, event: "payment_attempt_created", entity: "Payment", entityId: paymentRow.id, meta: { attempt: 1, amount: view.subtotal } });
  return { ok: true as const, order, redirectUrl: payment.redirectUrl, authority: payment.authority, validation };
}

/**
 * Retry (§27): create a NEW payment attempt for a PENDING_PAYMENT order
 * (mirrors real gateways — each attempt gets its own authority/token/ledger
 * row). Old FAILED attempts are never mutated into success.
 */
export async function retryPayment(orderNumber: string) {
  const order = await prisma.order.findUnique({ where: { orderNumber } });
  if (!order) return { ok: false as const, reason: "ORDER_NOT_FOUND" };
  if (order.status !== "PENDING_PAYMENT") return { ok: false as const, reason: `ORDER_${order.status}` };
  const ps = paymentService();
  const payment = await ps.createPayment({ orderId: order.id, orderNumber, amountIRR: order.total });
  const paymentRow = await prisma.payment.findUniqueOrThrow({ where: { authority: payment.authority }, select: { id: true } });
  const attemptNumber = await nextAttemptNumber(prisma, paymentRow.id);
  await prisma.paymentAttempt.create({
    data: {
      paymentId: paymentRow.id,
      attemptNumber,
      provider: ps.provider,
      amountIrr: order.total,
      authority: payment.authority,
      idempotencyKey: newIdempotencyKey(`order:${order.id}:retry`),
    },
  });
  await logAudit({ actor: "system", event: "payment_attempt_created", entity: "Payment", entityId: paymentRow.id, meta: { attempt: attemptNumber, orderNumber } });
  return { ok: true as const, redirectUrl: payment.redirectUrl, authority: payment.authority };
}

/**
 * Mock gateway callback → settlement (P2-E §25–26, §29).
 * Verification checklist: attempt exists, order payable, amount matches,
 * attempt not already settled, callback replay is idempotent (attempt status
 * guard inside the settlement transaction). The gateway verification happens
 * OUTSIDE the DB transaction (§64); only settlement is transactional.
 */
export async function settleMockPayment(authority: string, outcome: "success" | "failure") {
  const ps = paymentService();
  const verify = await ps.verifyPayment({ authority, outcome });
  const payment = await prisma.payment.findUnique({
    where: { authority },
    include: { order: true, attempts: true },
  });
  if (!payment) return { ok: false as const, reason: "PAYMENT_NOT_FOUND" };
  const attempt = payment.attempts.find((a) => a.authority === authority);
  if (!attempt) return { ok: false as const, reason: "ATTEMPT_NOT_FOUND" };

  if (!verify.ok) {
    // Only a PENDING attempt may be marked FAILED — never overwrite a settled one.
    if (attempt.status === "PENDING") {
      await prisma.$transaction([
        prisma.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: "FAILED", failureCode: verify.reason ?? "PAYMENT_FAILED", failureMessage: verify.reason ?? "پرداخت ناموفق", completedAt: new Date() },
        }),
        ...(payment.status === "PENDING"
          ? [prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } })]
          : []),
      ]);
      await logAudit({ actor: "system", event: "payment_verification_failed", entity: "Payment", entityId: payment.id, meta: { authority, reason: verify.reason } });
    }
    // §26 idempotency: a replayed failure for an already-FAILED attempt is a no-op
    return { ok: false as const, reason: verify.reason ?? "PAYMENT_FAILED", orderNumber: payment.order.orderNumber };
  }

  // §25 verification: only a FAILED attempt is hard-rejected here (a success
  // callback after failure needs a NEW attempt via retryPayment — never a
  // resurrected old one). Any non-PENDING outcome is absorbed idempotently by
  // the claim below, so replays can NEVER re-run settlement.
  if (attempt.status === "FAILED") {
    return { ok: false as const, reason: "ATTEMPT_FAILED", orderNumber: payment.order.orderNumber };
  }
  if (attempt.status !== "PENDING") {
    return { ok: false as const, idempotent: true as const, reason: "ALREADY_SETTLED", orderNumber: payment.order.orderNumber };
  }

  // Amount integrity (audit M-1): the settled amount must equal the order total
  // recorded at checkout. Real gateways must additionally verify the signature
  // inside the adapter — this assert makes a tampered Payment row inert.
  if (payment.amount !== payment.order.total) {
    await logAudit({ actor: "system", event: "payment_verification_failed", entity: "Payment", entityId: payment.id, meta: { reason: "AMOUNT_MISMATCH", attemptAmount: payment.amount, orderTotal: payment.order.total } });
    return { ok: false as const, reason: "AMOUNT_MISMATCH", orderNumber: payment.order.orderNumber };
  }

  // §29: settlement-failure representation. The attempt row is the truth: while
  // settlement is running/failed, the attempt carries failureCode SETTLEMENT_*,
  // so "payment succeeded" can never be silently presented as a complete order.
  await logAudit({ actor: "system", event: "settlement_started", entity: "Payment", entityId: payment.id, meta: { authority } });
  try {
    const result = await prisma.$transaction(async (tx) => {
      // AUDIT FIX C1 (adversarial review): a success callback for an order that
      // is no longer payable (customer/merchant CANCELLED it before the
      // callback arrived) must NEVER resurrect it to PAID. Checked before the
      // claim so a rejected callback leaves ZERO side effects.
      const ord = await tx.order.findUnique({ where: { id: payment.orderId }, select: { status: true } });
      if (!ord || ord.status !== "PENDING_PAYMENT") return { notPayable: true as const };

      // Idempotency guard INSIDE the transaction (§26): claim the attempt first.
      const claimed = await tx.paymentAttempt.updateMany({
        where: { id: attempt.id, status: "PENDING" },
        data: { status: "SUCCEEDED", referenceId: verify.providerRef ?? null, completedAt: new Date() },
      });
      if (claimed.count !== 1) return { alreadySettled: true as const };

      // C1 second half (TOCTOU): a cancel can commit between the read above and
      // the write below. The conditional update makes the order flip to PAID
      // only from PENDING_PAYMENT; otherwise the whole tx rolls back.
      const paid = await tx.order.updateMany({
        where: { id: payment.orderId, status: "PENDING_PAYMENT" },
        data: { paymentStatus: "SUCCEEDED", status: "PAID" },
      });
      if (paid.count !== 1) throw new Error("ORDER_NOT_PAYABLE");

      const items = await tx.orderItem.findMany({
        where: { sellerOrder: { orderId: payment.orderId } },
        include: { offer: true },
      });
      for (const it of items) {
        const updated = await tx.offer.updateMany({
          where: { id: it.offerId, stock: { gte: it.quantity } },
          data: { stock: { decrement: it.quantity } },
        });
        if (updated.count !== 1) throw new Error(`STOCK_CONFLICT:${it.offerId}`);
      }
      await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCEEDED" } });
      await tx.sellerOrder.updateMany({ where: { orderId: payment.orderId }, data: { status: "CONFIRMED" } });
      // Empty the buyer's cart exactly once (claimed attempt guarantees this).
      if (payment.order.sessionId) {
        const cart = await tx.cart.findUnique({ where: { sessionId: payment.order.sessionId } });
        if (cart) await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      }
      await logAuditTx(tx, {
        actor: "system", event: "settlement_completed", entity: "Payment", entityId: payment.id, meta: { authority, orderNumber: payment.order.orderNumber },
      });
      return { alreadySettled: false as const, notPayable: false as const, orderNumber: payment.order.orderNumber };
    });

    if (result.notPayable) {
      // C1: gateway accepted the money for an order that was cancelled
      // meanwhile — never settle, never fake success. The attempt is closed as
      // FAILED (it can never settle for a terminal order) and the event is
      // auditable for manual refund/review in the real-adapter phase.
      await prisma.paymentAttempt.updateMany({
        where: { id: attempt.id, status: "PENDING" },
        data: { status: "FAILED", failureCode: "ORDER_NOT_PAYABLE", failureMessage: "سفارش پیش از تسویه لغو شده است", completedAt: new Date() },
      });
      await logAudit({ actor: "system", event: "settlement_failed", entity: "Payment", entityId: payment.id, meta: { authority, reason: "ORDER_NOT_PAYABLE" } });
      return { ok: false as const, idempotent: true as const, reason: "ORDER_NOT_PAYABLE", orderNumber: payment.order.orderNumber };
    }
    if (result.alreadySettled) {
      // Concurrent loser (Phase-1 contract: exactly 1 ok per race). The
      // callback is absorbed harmlessly; the caller renders the AUTHORITATIVE
      // order state (see /checkout/result) instead of inventing an outcome.
      return { ok: false as const, idempotent: true as const, reason: "ALREADY_SETTLED", orderNumber: payment.order.orderNumber };
    }
    return { ok: true as const, orderNumber: result.orderNumber };
  } catch (e) {
    // §29: record the failure on the ATTEMPT (never fake success); the order
    // stays PENDING_PAYMENT with a SUCCEEDED-provider-outcome — reviewable.
    // ORDER_NOT_PAYABLE = lost the cancel/settle TOCTOU race → tx rolled back.
    const message = e instanceof Error ? e.message : "UNKNOWN";
    await prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        failureCode: message.startsWith("ORDER_NOT_PAYABLE") ? "ORDER_NOT_PAYABLE" : "SETTLEMENT_FAILED",
        failureMessage: message.slice(0, 200),
      },
    });
    await logAudit({ actor: "system", event: "settlement_failed", entity: "Payment", entityId: payment.id, meta: { authority, error: message.slice(0, 200) } });
    return { ok: false as const, reason: "SETTLEMENT_FAILED", orderNumber: payment.order.orderNumber };
  }
}
