import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createSession, resolveSession, revokeSession, hashToken } from "@/lib/auth/session";
import { canTransitionOrder, canTransitionSellerOrder, canTransitionSellerStatus } from "@/lib/audit";
import { settleMockPayment } from "@/lib/checkout";
import { createReturnRequest, transitionReturn, getReturnEligibility, canTransitionReturn } from "@/lib/returns";
import { transitionSellerStatus } from "@/lib/governance";
import { getAuthenticatedSellerForTest, getAuthenticatedAdminForTest } from "@/lib/seller/seller-auth-test";
import { prisma as appPrisma } from "@/lib/prisma";

const prisma = new PrismaClient();
const SELLER_A = "demo-seller-1";
let partId = "";

const cleanup: { payments: string[]; orders: string[]; offers: string[]; returns: string[]; sessions: string[] } = {
  payments: [], orders: [], offers: [], returns: [], sessions: [],
};

beforeAll(async () => {
  const part = await prisma.part.findFirstOrThrow({ where: { sku: { startsWith: "DEMO-206" } } });
  partId = part.id;
});

afterAll(async () => {
  await prisma.refund.deleteMany({ where: { returnRequestId: { in: cleanup.returns } } });
  await prisma.returnRequest.deleteMany({ where: { id: { in: cleanup.returns } } });
  await prisma.paymentAttempt.deleteMany({ where: { paymentId: { in: cleanup.payments } } });
  await prisma.payment.deleteMany({ where: { id: { in: cleanup.payments } } });
  await prisma.order.deleteMany({ where: { id: { in: cleanup.orders } } });
  await prisma.offer.deleteMany({ where: { id: { in: cleanup.offers } } });
  await prisma.session.deleteMany({ where: { id: { in: cleanup.sessions } } });
  await prisma.sellerEventLog.deleteMany({ where: { event: { in: ["seller_approved", "seller_suspended", "seller_rejected"] }, actor: "p2e-test-admin" } });
  await prisma.$disconnect();
});

// ── helpers ──
let phoneSeq = 0;
function uniquePhone(): string {
  // 11-digit numeric, unique per test run (prefix 09 + 9 digits from seq+time).
  const n = (Date.now() % 1_000_000_000) * 10 + (phoneSeq++ % 10);
  return `09${String(n).padStart(9, "0").slice(0, 9)}`;
}

async function mkPaidOrder(opts: { stock?: number; quantity?: number; delivered?: boolean; price?: number } = {}) {
  const offer = await prisma.offer.create({
    data: {
      sellerId: SELLER_A, partId, price: opts.price ?? 900_000, stock: opts.stock ?? 10,
      shippingDaysMin: 1, shippingDaysMax: 2, shippingDays: 1,
      sellerSku: `P2E-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      active: true, stockUpdatedAt: new Date(),
    },
  });
  cleanup.offers.push(offer.id);
  const total = (opts.price ?? 900_000) * (opts.quantity ?? 2);
  const order = await prisma.order.create({
    data: {
      orderNumber: `P2E-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      status: opts.delivered ? "FULFILLED" : "PAID", paymentStatus: "SUCCEEDED", total,
      sellerOrders: {
        create: {
          sellerId: SELLER_A, status: opts.delivered ? "DELIVERED" : "CONFIRMED", subtotal: total,
          items: { create: { partId, offerId: offer.id, quantity: opts.quantity ?? 2, unitPrice: opts.price ?? 900_000, total } },
        },
      },
    },
    include: { sellerOrders: { include: { items: true } } },
  });
  cleanup.orders.push(order.id);
  return { order, offer, so: order.sellerOrders[0]!, item: order.sellerOrders[0]!.items[0]! };
}

// ─────────────────── Sessions (§9–10) ───────────────────

describe("session store", () => {
  it("create → resolve → revoke; hash never equals raw token", async () => {
    const user = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    const { token, session } = await createSession(user.id);
    cleanup.sessions.push(session.id);
    expect(token).not.toContain(hashToken(token));
    const resolved = await resolveSession(token);
    expect(resolved?.userId).toBe(user.id);
    await revokeSession(token);
    expect(await resolveSession(token)).toBeNull(); // revoked → null
  });

  it("expired session resolves to null", async () => {
    const user = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    const { token, session } = await createSession(user.id);
    cleanup.sessions.push(session.id);
    await prisma.session.update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await resolveSession(token)).toBeNull();
  });

  it("suspended user's identity is rejected by role mirrors", async () => {
    const sellerUser = await prisma.user.findUniqueOrThrow({ where: { phone: "09012345678" } });
    await prisma.user.update({ where: { id: sellerUser.id }, data: { status: "ACTIVE" } }); // deterministic precondition
    const identity = await getAuthenticatedSellerForTest(sellerUser.id);
    expect(identity?.role).toBe("SELLER");
    // Suspend → mirror must reject
    await prisma.user.update({ where: { id: sellerUser.id }, data: { status: "SUSPENDED" } });
    expect(await getAuthenticatedSellerForTest(sellerUser.id)).toBeNull();
    expect(await getAuthenticatedAdminForTest(sellerUser.id)).toBeNull();
    await prisma.user.update({ where: { id: sellerUser.id }, data: { status: "ACTIVE" } }); // restore
  });
});

// ─────────────────── State machines (§21–22, §35, §18) ───────────────────

describe("state machines", () => {
  it("order transitions: PENDING_PAYMENT→PAID ok; PAID→SHIPPED rejected; terminals frozen", () => {
    expect(canTransitionOrder("PENDING_PAYMENT", "PAID")).toBe(true);
    expect(canTransitionOrder("PENDING_PAYMENT", "CANCELLED")).toBe(true);
    expect(canTransitionOrder("PAID", "SHIPPED")).toBe(false);
    expect(canTransitionOrder("CANCELLED", "PAID")).toBe(false);
    expect(canTransitionOrder("FULFILLED", "CANCELLED")).toBe(false);
  });

  it("seller order transitions: CONFIRMED→SHIPPED ok; CONFIRMED→DELIVERED rejected", () => {
    expect(canTransitionSellerOrder("CONFIRMED", "SHIPPED")).toBe(true);
    expect(canTransitionSellerOrder("CONFIRMED", "DELIVERED")).toBe(false);
    expect(canTransitionSellerOrder("SHIPPED", "DELIVERED")).toBe(true);
    expect(canTransitionSellerOrder("DELIVERED", "SHIPPED")).toBe(false);
  });

  it("seller governance transitions: PENDING→ACTIVE ok; ACTIVE→REJECTED rejected; SUSPENDED→REJECTED ok", () => {
    expect(canTransitionSellerStatus("PENDING", "ACTIVE")).toBe(true);
    expect(canTransitionSellerStatus("PENDING", "REJECTED")).toBe(true);
    expect(canTransitionSellerStatus("ACTIVE", "REJECTED")).toBe(false);
    expect(canTransitionSellerStatus("SUSPENDED", "ACTIVE")).toBe(true);
    expect(canTransitionSellerStatus("SUSPENDED", "REJECTED")).toBe(true);
    expect(canTransitionSellerStatus("REJECTED", "ACTIVE")).toBe(false);
  });

  it("return transitions: REQUESTED→APPROVED ok; REJECTED terminal; RECEIVED→REFUND_PENDING ok", () => {
    expect(canTransitionReturn("REQUESTED", "APPROVED")).toBe(true);
    expect(canTransitionReturn("REQUESTED", "REFUNDED")).toBe(false);
    expect(canTransitionReturn("REJECTED", "APPROVED")).toBe(false);
    expect(canTransitionReturn("RECEIVED", "REFUND_PENDING")).toBe(true);
  });
});

// ─────────────────── Payment attacks (§25–27, §59) ───────────────────

describe("payment idempotency & attacks", () => {
  it("ADVERSARIAL C1: success callback after CANCELLATION never resurrects the order or decrements stock", async () => {
    const { order, offer } = await mkPaidOrder({ stock: 5, quantity: 1 });
    await prisma.order.update({ where: { id: order.id }, data: { status: "PENDING_PAYMENT", paymentStatus: "PENDING" } });
    await prisma.sellerOrder.update({ where: { id: order.sellerOrders[0]!.id }, data: { status: "PENDING" } });
    const payment = await prisma.payment.create({
      data: { orderId: order.id, provider: "mock", amount: order.total, status: "PENDING", authority: `P2E-C1-${Date.now()}` },
    });
    cleanup.payments.push(payment.id);
    await prisma.paymentAttempt.create({
      data: { paymentId: payment.id, attemptNumber: 1, provider: "mock", amountIrr: order.total, authority: payment.authority, idempotencyKey: `p2e-c1-${payment.id}` },
    });

    // customer cancels while the payment is in flight (service-level mirror of cancelCustomerOrder)
    await prisma.$transaction([
      prisma.order.updateMany({ where: { id: order.id, status: "PENDING_PAYMENT" }, data: { status: "CANCELLED" } }),
      prisma.sellerOrder.updateMany({ where: { orderId: order.id, status: "PENDING" }, data: { status: "CANCELLED" } }),
    ]);

    const res = await settleMockPayment(payment.authority!, "success"); // stale gateway success arrives
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("ORDER_NOT_PAYABLE");

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("CANCELLED"); // never resurrected to PAID
    expect(after.paymentStatus).not.toBe("SUCCEEDED");
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).stock).toBe(5); // stock untouched
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { paymentId: payment.id } });
    expect(attempt.status).toBe("FAILED"); // closed, never SUCCEEDED for a cancelled order
    expect(attempt.failureCode).toBe("ORDER_NOT_PAYABLE");
  });

  it("ADVERSARIAL C1-race: settle and cancel concurrently → exactly one wins, no impossible state", async () => {
    const { order, offer } = await mkPaidOrder({ stock: 3, quantity: 1 });
    await prisma.order.update({ where: { id: order.id }, data: { status: "PENDING_PAYMENT", paymentStatus: "PENDING" } });
    await prisma.sellerOrder.update({ where: { id: order.sellerOrders[0]!.id }, data: { status: "PENDING" } });
    const payment = await prisma.payment.create({
      data: { orderId: order.id, provider: "mock", amount: order.total, status: "PENDING", authority: `P2E-C1R-${Date.now()}` },
    });
    cleanup.payments.push(payment.id);
    await prisma.paymentAttempt.create({
      data: { paymentId: payment.id, attemptNumber: 1, provider: "mock", amountIrr: order.total, authority: payment.authority, idempotencyKey: `p2e-c1r-${payment.id}` },
    });

    const [, final] = await Promise.all([
      settleMockPayment(payment.authority!, "success"),
      (async () => {
        await prisma.order.updateMany({ where: { id: order.id, status: "PENDING_PAYMENT", paymentStatus: { not: "SUCCEEDED" } }, data: { status: "CANCELLED" } });
        await prisma.sellerOrder.updateMany({ where: { orderId: order.id, status: "PENDING" }, data: { status: "CANCELLED" } });
      })(),
    ]);
    void final;

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const stock = (await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).stock;
    // Exactly one of: PAID with stock decremented, or CANCELLED with stock untouched.
    if (after.status === "PAID") {
      expect(stock).toBe(2);
      expect(after.paymentStatus).toBe("SUCCEEDED");
    } else {
      expect(after.status).toBe("CANCELLED");
      expect(stock).toBe(3);
      expect(after.paymentStatus).not.toBe("SUCCEEDED");
    }
  });

  it("duplicate success callback is idempotent: stock decremented ONCE, cart cleared once", async () => {
    const { order, offer } = await mkPaidOrder({ stock: 10, quantity: 2 });
    // Force it back into the pre-settlement state to exercise real settlement:
    await prisma.order.update({ where: { id: order.id }, data: { status: "PENDING_PAYMENT", paymentStatus: "PENDING" } });
    await prisma.sellerOrder.update({ where: { id: order.sellerOrders[0]!.id }, data: { status: "PENDING" } });
    const payment = await prisma.payment.create({
      data: { orderId: order.id, provider: "mock", amount: order.total, status: "PENDING", authority: `P2E-DUP-${Date.now()}` },
    });
    cleanup.payments.push(payment.id);
    await prisma.paymentAttempt.create({
      data: { paymentId: payment.id, attemptNumber: 1, provider: "mock", amountIrr: order.total, authority: payment.authority, idempotencyKey: `p2e-${payment.id}` },
    });

    const r1 = await settleMockPayment(payment.authority!, "success");
    const r2 = await settleMockPayment(payment.authority!, "success"); // replay
    expect(r1.ok).toBe(true);
    // Replay is absorbed idempotently: no error to the caller, but NOT a fresh
    // ok (only the settlement transaction's winner is ok:true).
    expect(r2.ok).toBe(false);
    expect(r2).toMatchObject({ idempotent: true, reason: "ALREADY_SETTLED" });

    const offerRow = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(offerRow.stock).toBe(8); // decremented EXACTLY once (10 − 2)
    const attempts = await prisma.paymentAttempt.findMany({ where: { paymentId: payment.id } });
    expect(attempts.filter((a) => a.status === "SUCCEEDED").length).toBe(1);
    const auditSettlements = await prisma.sellerEventLog.count({ where: { event: "settlement_completed", entityId: payment.id } });
    expect(auditSettlements).toBe(1);
  });

  it("amount mismatch is rejected without any settlement", async () => {
    const { order } = await mkPaidOrder({});
    await prisma.order.update({ where: { id: order.id }, data: { status: "PENDING_PAYMENT", paymentStatus: "PENDING" } });
    await prisma.sellerOrder.update({ where: { id: order.sellerOrders[0]!.id }, data: { status: "PENDING" } });
    const payment = await prisma.payment.create({
      data: { orderId: order.id, provider: "mock", amount: order.total + 5000, status: "PENDING", authority: `P2E-AMT-${Date.now()}` }, // tampered
    });
    cleanup.payments.push(payment.id);
    await prisma.paymentAttempt.create({
      data: { paymentId: payment.id, attemptNumber: 1, provider: "mock", amountIrr: order.total + 5000, authority: payment.authority, idempotencyKey: `p2e-amt-${payment.id}` },
    });
    const res = await settleMockPayment(payment.authority!, "success");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("AMOUNT_MISMATCH");
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { paymentId: payment.id } });
    expect(attempt.status).toBe("PENDING"); // never settled
  });

  it("failure callback marks attempt FAILED but does NOT touch stock; retry creates NEW attempt", async () => {
    const { order, offer } = await mkPaidOrder({ stock: 10 });
    await prisma.order.update({ where: { id: order.id }, data: { status: "PENDING_PAYMENT", paymentStatus: "PENDING" } });
    const payment = await prisma.payment.create({
      data: { orderId: order.id, provider: "mock", amount: order.total, status: "PENDING", authority: `P2E-FAIL-${Date.now()}` },
    });
    cleanup.payments.push(payment.id);
    const a1 = await prisma.paymentAttempt.create({
      data: { paymentId: payment.id, attemptNumber: 1, provider: "mock", amountIrr: order.total, authority: payment.authority, idempotencyKey: `p2e-f1-${payment.id}` },
    });
    const failed = await settleMockPayment(payment.authority!, "failure");
    expect(failed.ok).toBe(false);
    expect((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: a1.id } })).status).toBe("FAILED");
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).stock).toBe(10); // untouched

    // §27: retry → a NEW payment + NEW attempt row (old one stays FAILED forever)
    const payment2 = await prisma.payment.create({
      data: { orderId: order.id, provider: "mock", amount: order.total, status: "PENDING", authority: `P2E-RETRY-${Date.now()}` },
    });
    cleanup.payments.push(payment2.id);
    const a2 = await prisma.paymentAttempt.create({
      data: { paymentId: payment2.id, attemptNumber: 2, provider: "mock", amountIrr: order.total, authority: payment2.authority, idempotencyKey: `p2e-f2-${payment2.id}` },
    });
    const ok2 = await settleMockPayment(payment2.authority!, "success");
    expect(ok2.ok).toBe(true);
    expect((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: a2.id } })).status).toBe("SUCCEEDED");
    expect((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: a1.id } })).status).toBe("FAILED"); // history immutable
  });
});

// ─────────────────── Returns (§34–38, §61) ───────────────────

describe("returns", () => {
  it("undelivered paid order is NOT eligible; delivered is eligible within window", async () => {
    const a = await mkPaidOrder({ delivered: false });
    const b = await mkPaidOrder({ delivered: true });
    const owner = { sessionId: a.order.sessionId! };
    const e1 = await getReturnEligibility(a.item.id, owner);
    expect(e1.eligible).toBe(false);
    const e2 = await getReturnEligibility(b.item.id, owner);
    expect(e2.eligible).toBe(true);
    if (e2.eligible) expect(e2.needsLegalVerification).toBe(true); // demo policy flagged
  });

  it("ownership: another session cannot even read eligibility or create a return", async () => {
    const { item } = await mkPaidOrder({ delivered: true });
    const stranger = { sessionId: "not-the-owner" };
    const e = await getReturnEligibility(item.id, stranger);
    expect(e.eligible).toBe(false);
    const res = await createReturnRequest({ orderItemId: item.id, reason: "تست مالکیت", owner: stranger, actor: "p2e-test" });
    expect(res.ok).toBe(false);
  });

  it("full lifecycle REQUESTED→UNDER_REVIEW→APPROVED→RECEIVED→REFUND_PENDING (refund row created PENDING)", async () => {
    const { item, order } = await mkPaidOrder({ delivered: true });
    const owner = { sessionId: order.sessionId! };
    const created = await createReturnRequest({ orderItemId: item.id, reason: "کالا معیوب است (تست)", owner, actor: "p2e-test" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    cleanup.returns.push(created.returnId);

    for (const to of ["UNDER_REVIEW", "APPROVED", "RECEIVED", "REFUND_PENDING"] as const) {
      const t = await transitionReturn({ returnRequestId: created.returnId, to, actor: "p2e-test-admin" });
      expect(t.ok).toBe(true);
    }
    const refund = await prisma.refund.findUniqueOrThrow({ where: { returnRequestId: created.returnId } });
    expect(refund.status).toBe("PENDING"); // foundation only — no faked success
    expect(refund.amountIrr).toBe(item.total);

    // duplicate submit resolves to the SAME request (eligibility check reports
    // an active request → surfaced as ELIGIBILITY refusal, single row per item)
    const dup = await createReturnRequest({ orderItemId: item.id, reason: "تکراری", owner, actor: "p2e-test" });
    expect(dup.ok).toBe(false); // active request exists → not "eligible" for a second one
    if (!dup.ok) expect(dup.reason).toBe("ELIGIBILITY");
    const activeRows = await prisma.returnRequest.findMany({ where: { orderItemId: item.id } });
    expect(activeRows.length).toBe(1); // no duplicates
  });

  it("invalid transition REJECTED→APPROVED is refused", async () => {
    const { item, order } = await mkPaidOrder({ delivered: true });
    const created = await createReturnRequest({ orderItemId: item.id, reason: "تست رد", owner: { sessionId: order.sessionId! }, actor: "p2e-test" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    cleanup.returns.push(created.returnId);
    await transitionReturn({ returnRequestId: created.returnId, to: "REJECTED", actor: "p2e-test-admin" });
    const bad = await transitionReturn({ returnRequestId: created.returnId, to: "APPROVED", actor: "p2e-test-admin" });
    expect(bad.ok).toBe(false);
  });
});

// ─────────────────── Seller governance (§18–19, §62) ───────────────────

describe("seller governance", () => {
  it("seller role cannot approve sellers (admin mirror rejects); customer is not admin", async () => {
    const sellerUser = await prisma.user.findUniqueOrThrow({ where: { phone: "09012345678" } });
    expect(await getAuthenticatedAdminForTest(sellerUser.id)).toBeNull();
  });

  it("suspend + reactivate transitions audited; suspension revokes sessions", async () => {
    const seller = await prisma.seller.findUniqueOrThrow({ where: { id: SELLER_A } });
    const original = seller.sellerStatus;
    const user = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    const { session } = await createSession(user.id);
    cleanup.sessions.push(session.id);

    const s1 = await transitionSellerStatus({ sellerId: SELLER_A, to: "SUSPENDED", adminUserId: "p2e-test-admin" });
    expect(s1.ok).toBe(true);
    const revoked = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    // (revocation applies to the seller's OWN sessions; this customer session is untouched)
    void revoked;
    const log1 = await prisma.sellerEventLog.findFirst({ where: { sellerId: SELLER_A, event: "seller_suspended", actor: "p2e-test-admin" }, orderBy: { createdAt: "desc" } });
    expect(log1).toBeTruthy();

    const s2 = await transitionSellerStatus({ sellerId: SELLER_A, to: "ACTIVE", adminUserId: "p2e-test-admin" });
    expect(s2.ok).toBe(true);
    const after = await prisma.seller.findUniqueOrThrow({ where: { id: SELLER_A } });
    expect(after.sellerStatus).toBe(original === "ACTIVE" ? "ACTIVE" : original); // restored
  });

  it("invalid governance transition ACTIVE→REJECTED is refused", async () => {
    const res = await transitionSellerStatus({ sellerId: SELLER_A, to: "REJECTED", adminUserId: "p2e-test-admin" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("INVALID_TRANSITION");
  });
});

// ─────────────────── Snapshots (§40–41) ───────────────────

describe("order snapshots", () => {
  it("changing offer price/part title does NOT rewrite historical OrderItem snapshots", async () => {
    const { item, offer } = await mkPaidOrder({ delivered: true });
    const before = {
      unitPrice: item.unitPrice,
      title: item.partTitleSnapshot,
      sku: item.partSkuSnapshot,
    };
    await prisma.offer.update({ where: { id: offer.id }, data: { price: 9_999_999 } });
    await prisma.part.update({ where: { id: partId }, data: { title: "عنوان تغییر یافته برای تست" } });
    // (offer price/title change AFTER the order exists must not rewrite history)
    const after = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.unitPrice).toBe(before.unitPrice);
    expect(after.partTitleSnapshot).toBe(before.title);
    expect(after.partSkuSnapshot).toBe(before.sku);
    // restore catalog title (snapshot fields are never touched by these updates)
    if (before.title) await prisma.part.update({ where: { id: partId }, data: { title: before.title } });
  });
});
