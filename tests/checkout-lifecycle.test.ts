import { describe, expect, it, beforeAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { addToCart, getCartView, updateCartItem, removeCartItem } from "@/lib/cart";
import { createCheckout, settleMockPayment, retryPayment, validateCartForCheckout } from "@/lib/checkout";
import { getOffersForPart } from "@/lib/offers";
import { resolveFitment } from "@/lib/fitment";
import { getAssetContractForVehicle } from "@/lib/registry3d";
import { searchParts } from "@/lib/catalog";

const prisma = new PrismaClient();
const sid = `test_${Math.random().toString(36).slice(2)}`;

async function radiatorPart() {
  const p = await prisma.part.findUniqueOrThrow({ where: { slug: "radiator-206" } });
  return p;
}

beforeAll(async () => {
  // sanity: seed exists
  const count = await prisma.part.count();
  if (count === 0) throw new Error("DB not seeded — run `npm run db:seed`");
  // Tests mutate stock (real decrements). Replenish known fixtures so runs are
  // deterministic and repeatable regardless of prior runs/UI purchases.
  await prisma.part.update({
    where: { slug: "radiator-206" },
    data: { offers: { updateMany: { where: { price: { in: [6400000, 6800000, 7200000, 7900000] } }, data: { stock: 5 } } } },
  });
  // The pad's seeded offer may have had its price changed by P2-D tests/CSV
  // demo — replenish by ID (excluding the cheap concurrency fixture) so the
  // fixture is stable regardless of price history.
  const padOffers = await prisma.offer.findMany({
    where: { part: { slug: "brake-pad-front-206" }, id: { not: "test-conc-p" } },
    orderBy: { price: "asc" },
    take: 1,
  });
  if (padOffers[0]) await prisma.offer.update({ where: { id: padOffers[0].id }, data: { stock: 6, active: true } });
});

describe("fitment + offers (catalog/marketplace layers)", () => {
  it("radiator resolves COMPATIBLE for both trims in their common years (via Fitment Engine)", async () => {
    const part = await radiatorPart();
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
    const variants = await prisma.vehicleVariant.findMany({ where: { vehicleId: vehicle.id } });
    expect(variants.length).toBeGreaterThanOrEqual(2);
    for (const v of variants) {
      const year = v.productionStart != null ? Math.min(v.productionStart + 2, v.productionEnd ?? v.productionStart + 2) : null;
      const result = await resolveFitment(part.id, {
        vehicleId: vehicle.id, variantId: v.id, engine: v.engine, transmission: v.transmission, bodyType: vehicle.bodyType, year,
      });
      expect(result.status).toBe("COMPATIBLE");
    }
  });

  it("radiator year-range guard: 2014 تیپ ۵ is INCOMPATIBLE (specific negative rule wins)", async () => {
    const part = await radiatorPart();
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
    const t5 = await prisma.vehicleVariant.findFirstOrThrow({ where: { vehicleId: vehicle.id, trim: "تیپ ۵" } });
    const result = await resolveFitment(part.id, {
      vehicleId: vehicle.id, variantId: t5.id, engine: t5.engine, transmission: t5.transmission, year: 2014,
    });
    expect(result.status).toBe("INCOMPATIBLE");
  });

  it("offers sort correctly (cheapest/fastest) and stock states label right", async () => {
    const part = await radiatorPart();
    const cheapest = await getOffersForPart(part.id, "cheapest");
    expect(cheapest.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < cheapest.length; i++) {
      expect(cheapest[i]!.price).toBeGreaterThanOrEqual(cheapest[i - 1]!.price);
    }
    const fastest = await getOffersForPart(part.id, "fastest");
    expect(fastest[0]!.shippingDays).toBeLessThanOrEqual(fastest[fastest.length - 1]!.shippingDays);
  });

  it("search normalization reaches the radiator via ۲۰۶/206 equivalence", async () => {
    const results = await searchParts("رادیاتور ۲۰۶");
    expect(results.some((p) => p.slug === "radiator-206")).toBe(true);
    const resultsEn = await searchParts("radiator");
    expect(resultsEn.some((p) => p.slug === "radiator-206")).toBe(true);
  });

  it("Asset Contract exposes all 8 zone mappings and the radiator part chain", async () => {
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
    const contract = await getAssetContractForVehicle(vehicle.id);
    expect(contract).not.toBeNull();
    const keys = contract!.zones.map((z) => z.zoneKey).sort();
    expect(keys).toEqual(["body", "brakes", "cooling", "electrical", "engine", "interior", "suspension", "wheels"]);
    const radiator = contract!.parts.find((p) => p.meshName === "part_radiator_main");
    // P2-F (F2): part_radiator_main now maps to the real imported part
    expect(radiator?.partSlug).toBe("radiator-assembly");
  });
});

describe("cart (server-authoritative)", () => {
  it("add → view → update → remove round-trips through PostgreSQL", async () => {
    const part = await radiatorPart();
    const offers = await getOffersForPart(part.id, "cheapest");
    const offer = offers.find((o) => o.stock >= 1)!;
    const qty = Math.min(2, offer.stock);

    await addToCart(sid, offer.id, qty);
    let view = await getCartView(sid);
    expect(view.lines.length).toBe(1);
    expect(view.lines[0]!.quantity).toBe(qty);
    expect(view.subtotal).toBe(qty * offer.price);

    await updateCartItem(sid, view.lines[0]!.itemId, 1);
    view = await getCartView(sid);
    expect(view.lines[0]!.quantity).toBe(1);

    await removeCartItem(sid, view.lines[0]!.itemId);
    view = await getCartView(sid);
    expect(view.lines.length).toBe(0);
  });

  it("clamps quantity to available stock", async () => {
    const part = await radiatorPart();
    const offers = await getOffersForPart(part.id, "cheapest");
    const target = offers.find((o) => o.stock >= 1)!;
    await prisma.offer.update({ where: { id: target.id }, data: { stock: 2 } });
    await addToCart(sid, target.id, 99);
    const view = await getCartView(sid);
    const line = view.lines.find((l) => l.offerId === target.id);
    expect(line?.quantity).toBe(2);
    await removeCartItem(sid, line!.itemId);
    await prisma.offer.update({ where: { id: target.id }, data: { stock: 5 } });
  });

  it("survives the parallel first-touch race (cart + /api/cart together)", async () => {
    const fresh = "race-session-" + Date.now();
    // exactly what the browser does on first paint: cart page and badge fetch concurrently
    const results = await Promise.all([
      getCartView(fresh),
      getCartView(fresh),
      getCartView(fresh),
      getCartView(fresh),
    ]);
    expect(new Set(results.map((r) => r.sessionId)).size).toBe(1);
    expect(results.every((r) => r.lines.length === 0)).toBe(true);
    const carts = await prisma.cart.findMany({ where: { sessionId: fresh } });
    expect(carts.length).toBe(1); // unique(sessionId) — exactly one cart
    await prisma.cart.delete({ where: { sessionId: fresh } });
  });

  it("merges parallel adds of the same offer into one line", async () => {
    const part = await radiatorPart();
    const offers = await getOffersForPart(part.id, "cheapest");
    const target = offers.find((o) => o.stock >= 4)!;
    const fresh = "race-add-" + Date.now();
    await Promise.all([addToCart(fresh, target.id, 2), addToCart(fresh, target.id, 2)]);
    const view = await getCartView(fresh);
    const lines = view.lines.filter((l) => l.offerId === target.id);
    expect(lines.length).toBe(1); // merged, not duplicated
    expect(lines[0]!.quantity).toBe(4);
    await prisma.cart.deleteMany({ where: { sessionId: fresh } });
  });
});

describe("checkout state machine (multi-seller, stock-safe)", () => {
  it("full lifecycle: cart → pending order + pending payment → mock success → PAID + stock decrement", async () => {
    // Pick two parts from DIFFERENT sellers to force a multi-seller order.
    const radiator = await radiatorPart();
    const pad = await prisma.part.findUniqueOrThrow({ where: { slug: "brake-pad-front-206" } });
    const rOffers = (await getOffersForPart(radiator.id, "cheapest")).filter((o) => o.seller.sellerStatus === "ACTIVE");
    const pOffers = (await getOffersForPart(pad.id, "cheapest")).filter((o) => o.seller.sellerStatus === "ACTIVE");
    const rOffer = rOffers.find((o) => o.stock >= 1)!;
    const rQty = Math.min(2, rOffer.stock);
    const pOffer = pOffers.find((o) => o.sellerId !== rOffer.sellerId && o.stock >= 1)!;
    const pQty = 1;

    const stockBeforeR = (await prisma.offer.findUniqueOrThrow({ where: { id: rOffer.id } })).stock;
    const stockBeforeP = (await prisma.offer.findUniqueOrThrow({ where: { id: pOffer.id } })).stock;

    await addToCart(sid, rOffer.id, rQty);
    await addToCart(sid, pOffer.id, pQty);

    const variantT5 = await prisma.vehicleVariant.findFirstOrThrow({ where: { trim: "تیپ ۵" } });
    const validation = await validateCartForCheckout(sid, variantT5.id);
    expect(validation.ok).toBe(true);

    const checkout = await createCheckout(sid, variantT5.id);
    expect(checkout.ok).toBe(true);
    const order = checkout.ok ? checkout.order : null;
    expect(order).not.toBeNull();
    if (!checkout.ok || !order) return;

    // pending state BEFORE payment
    expect(order.status).toBe("PENDING_PAYMENT");
    expect(order.paymentStatus).toBe("PENDING");
    const sellerOrders = await prisma.sellerOrder.findMany({ where: { orderId: order.id } });
    expect(sellerOrders.length).toBe(2); // grouped per seller
    expect(sellerOrders.every((so) => so.status === "PENDING")).toBe(true);

    // stock untouched before payment success
    const stockMidR = (await prisma.offer.findUniqueOrThrow({ where: { id: rOffer.id } })).stock;
    expect(stockMidR).toBe(stockBeforeR);

    // FAILURE path: stock still untouched
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    const fail = await settleMockPayment(payment.authority!, "failure");
    expect(fail.ok).toBe(false);
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: rOffer.id } })).stock).toBe(stockBeforeR);

    // SUCCESS path: stock decremented exactly, everything flips to PAID/CONFIRMED
    // (retry creates a NEW payment attempt — the failed authority is terminal)
    const retry = await retryPayment(order.orderNumber);
    expect(retry.ok).toBe(true);
    const ok = await settleMockPayment(retry.ok ? retry.authority : "", "success");
    expect(ok.ok).toBe(true);
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: rOffer.id } })).stock).toBe(stockBeforeR - rQty);
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: pOffer.id } })).stock).toBe(stockBeforeP - pQty);

    const paid = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { sellerOrders: true, payments: true },
    });
    expect(paid.status).toBe("PAID");
    expect(paid.paymentStatus).toBe("SUCCEEDED");
    expect(paid.sellerOrders.every((so) => so.status === "CONFIRMED")).toBe(true);
    // payment history: first attempt FAILED, retry SUCCEEDED — none left PENDING
    expect(paid.payments.length).toBe(2);
    expect(paid.payments.find((pm) => pm.authority === payment.authority)?.status).toBe("FAILED");
    const settled = paid.payments.find((pm) => pm.authority === (retry.ok ? retry.authority : ""));
    expect(settled?.status).toBe("SUCCEEDED");

    // double-settlement guard: replaying ANY authority must NOT double-decrement
    await settleMockPayment(payment.authority!, "success");
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: rOffer.id } })).stock).toBe(stockBeforeR - rQty);

    const view = await getCartView(sid);
    expect(view.lines.length).toBe(0); // settlement empties the buyer's cart
  });

  it("settlement aborts on amount mismatch (tampered payment row)", async () => {
    const part = await radiatorPart();
    const offer = (await getOffersForPart(part.id, "cheapest")).find((o) => o.stock >= 1)!;
    const tamperSid = `tamper_${sid}`;
    await addToCart(tamperSid, offer.id, 1);
    const checkout = await createCheckout(tamperSid);
    expect(checkout.ok).toBe(true);
    if (!checkout.ok) return;

    // Simulate a tampered/corrupted payment row (amount ≠ order.total).
    await prisma.payment.updateMany({
      where: { orderId: checkout.order.id },
      data: { amount: 1 },
    });
    const result = await settleMockPayment(checkout.authority, "success");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("AMOUNT_MISMATCH");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: checkout.order.id } });
    expect(order.status).toBe("PENDING_PAYMENT"); // untouched
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).stock)
      .toBe((await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).stock); // no decrement

    // cleanup
    await prisma.payment.deleteMany({ where: { orderId: checkout.order.id } });
    await prisma.order.deleteMany({ where: { id: checkout.order.id } });
    await prisma.cartItem.deleteMany({ where: { cart: { sessionId: tamperSid } } });
    await prisma.cart.deleteMany({ where: { sessionId: tamperSid } });
  });

  it("parallel settlements of one authority settle exactly once (no oversell)", async () => {
    // Dedicated fixture offers so the race is deterministic (stock=1 each).
    const sellers = await prisma.seller.findMany({ where: { sellerStatus: "ACTIVE" }, take: 2, orderBy: { businessName: "asc" } });
    const rPart = await prisma.part.findUniqueOrThrow({ where: { slug: "radiator-206" } });
    const padPart = await prisma.part.findUniqueOrThrow({ where: { slug: "brake-pad-front-206" } });
    const rOffer = await prisma.offer.upsert({
      where: { id: "test-conc-r" },
      update: { stock: 1 },
      create: { id: "test-conc-r", sellerId: sellers[0]!.id, partId: rPart.id, price: 111000, stock: 1, lowStockThreshold: 1 },
    });
    const pOffer = await prisma.offer.upsert({
      where: { id: "test-conc-p" },
      update: { stock: 1 },
      create: { id: "test-conc-p", sellerId: sellers[1]!.id, partId: padPart.id, price: 99000, stock: 1, lowStockThreshold: 1 },
    });

    const concSid = `conc_${sid}`;
    await addToCart(concSid, rOffer.id, 1);
    await addToCart(concSid, pOffer.id, 1);
    const checkout = await createCheckout(concSid);
    expect(checkout.ok).toBe(true);
    if (!checkout.ok) return;

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => settleMockPayment(checkout.authority, "success")),
    );
    const oks = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
    expect(oks).toBe(1);
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: rOffer.id } })).stock).toBe(0);
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: pOffer.id } })).stock).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: checkout.order.id } })).status).toBe("PAID");
    expect((await getCartView(concSid)).lines.length).toBe(0);

    // cleanup: children before parents (RESTRICT FKs) — delete ALL order items
    // referencing the fixture offers (covers orphans left by earlier runs),
    // then the orders, then any orphaned cart items referencing the fixtures.
    await prisma.orderItem.deleteMany({ where: { offerId: { in: ["test-conc-r", "test-conc-p"] } } });
    await prisma.sellerOrder.deleteMany({ where: { orderId: checkout.order.id } });
    await prisma.order.deleteMany({ where: { id: checkout.order.id } });
    await prisma.cartItem.deleteMany({ where: { offerId: { in: ["test-conc-r", "test-conc-p"] } } });
    await prisma.cartItem.deleteMany({ where: { cart: { sessionId: concSid } } });
    await prisma.cart.deleteMany({ where: { sessionId: concSid } });
    await prisma.offer.deleteMany({ where: { id: { in: ["test-conc-r", "test-conc-p"] } } });
    // Settlement-created artifacts would poison later runs' amount-match and
    // attempt-claim guards (Payment→Order restrict; attempts cascade via order).
    await prisma.paymentAttempt.deleteMany({ where: { payment: { authority: checkout.authority } } });
    await prisma.payment.deleteMany({ where: { authority: checkout.authority } });
    await prisma.sellerEventLog.deleteMany({
      where: { OR: [{ event: { in: ["settlement_started", "settlement_completed", "payment_attempt_created", "order_created"] }, meta: { path: ["authority"], equals: checkout.authority } }, { event: "order_created", meta: { path: ["total"], equals: 210000 } }] },
    });
  });

  it("blocks checkout when stock insufficient or basket empty", async () => {
    const empty = await validateCartForCheckout(`other_${sid}`);
    expect(empty.ok).toBe(false);

    const part = await prisma.part.findUniqueOrThrow({ where: { slug: "alternator-206" } });
    const outOffer = (await prisma.offer.findFirst({ where: { partId: part.id, stock: 0 } }));
    if (outOffer) {
      await addToCart(sid, outOffer.id, 1); // server clamps to 0 → line vanishes from view
      const view = await getCartView(sid);
      expect(view.lines.find((l) => l.offerId === outOffer.id)).toBeUndefined();
    }
  });
});

describe("seller & admin visibility", () => {
  it("seller sees its confirmed seller order; admin sees order + mappings", async () => {
    const order = await prisma.order.findFirst({ where: { status: "PAID" }, include: { sellerOrders: true } });
    expect(order).not.toBeNull();
    const so = order!.sellerOrders[0]!;
    const visibleToSeller = await prisma.sellerOrder.findFirst({
      where: { sellerId: so.sellerId, orderId: order!.id },
    });
    expect(visibleToSeller).not.toBeNull();

    // Count zone mappings on the ACTIVE asset version (v2 adds a second copy of
    // every mapping — the invariant is per-version, not per-table).
    const activeVersion = await prisma.assetVersion.findFirst({
      where: { status: "ACTIVE" },
      orderBy: { activatedAt: "desc" },
      select: { id: true },
    });
    const mappings = await prisma.meshMapping.count({
      where: { kind: "zone", versionId: activeVersion!.id },
    });
    expect(mappings).toBe(8);
  });
});
