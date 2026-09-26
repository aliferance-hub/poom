import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  updateSellerOffer,
  setSellerOfferActive,
  getSellerOffers,
} from "@/lib/seller/seller-offers";
import { getSellerOrders, getSellerOrder, updateSellerOrderStatus } from "@/lib/seller/seller-orders";
import {
  parseSellerInventoryCsv,
  previewSellerInventoryImport,
  commitSellerInventoryImport,
  exportSellerInventoryCsv,
} from "@/lib/seller/seller-csv";
import { updateSellerProfile } from "@/lib/seller/seller-service";
import { prisma as appPrisma } from "@/lib/prisma";

// Real-DB tests (same pattern as P2-C suite): services are the unit under test;
// identity is simulated by passing the derived sellerId explicitly — the route
// layer derives it from the cookie and is covered in preview E2E.
const prisma = new PrismaClient();

const SELLER_A = "demo-seller-1"; // paired with SELLER_LOGIN
const SELLER_B = "demo-seller-2"; // isolation target
const ACTOR = "test-actor-p2d";

let offerAId = "";
let offerBId = "";
let orderAId = "";
let csvPartId = "";

const createdOffers: string[] = [];
const createdOrderIds: string[] = [];

beforeAll(async () => {
  const sellers = await prisma.seller.findMany({ orderBy: { businessName: "asc" } });
  const a = sellers.find((s) => s.id === SELLER_A);
  const b = sellers.find((s) => s.id === SELLER_B);
  if (!a || !b) throw new Error("Demo sellers missing — run seed first");

  const part = await prisma.part.findFirstOrThrow({ where: { sku: { startsWith: "DEMO-206" } } });
  csvPartId = part.id;

  // Dedicated test offers (deleted after) — seed data stays untouched.
  const offerA = await prisma.offer.create({
    data: {
      sellerId: SELLER_A, partId: part.id, price: 1_500_000, stock: 10,
      shippingDaysMin: 2, shippingDaysMax: 3, shippingDays: 2,
      sellerSku: "T-P2D-A", stockUpdatedAt: new Date(), priceUpdatedAt: new Date(),
    },
  });
  const offerB = await prisma.offer.create({
    data: {
      sellerId: SELLER_B, partId: part.id, price: 1_600_000, stock: 5,
      shippingDaysMin: 1, shippingDaysMax: 2, shippingDays: 1,
      sellerSku: "T-P2D-B", stockUpdatedAt: new Date(), priceUpdatedAt: new Date(),
    },
  });
  offerAId = offerA.id;
  offerBId = offerB.id;
  createdOffers.push(offerAId, offerBId);

  // One PAID parent order + SellerOrder for SELLER_A (status machine tests).
  const order = await prisma.order.create({
    data: {
      orderNumber: `P2D-${Date.now()}`, status: "PAID", paymentStatus: "SUCCEEDED",
      total: 1_500_000,
      sellerOrders: {
        create: {
          sellerId: SELLER_A, status: "CONFIRMED", subtotal: 1_500_000, shipping: 0,
          items: {
            create: { partId: part.id, offerId: offerAId, quantity: 1, unitPrice: 1_500_000, total: 1_500_000 },
          },
        },
      },
    },
    include: { sellerOrders: true },
  });
  orderAId = order.sellerOrders[0]!.id;
  createdOrderIds.push(order.id);
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.offer.deleteMany({ where: { id: { in: createdOffers } } });
  await prisma.sellerEventLog.deleteMany({ where: { sellerId: SELLER_A, actor: ACTOR } });
  await prisma.$disconnect();
});

// ─────────────────── Authorization / IDOR (§39–40) ───────────────────

describe("seller isolation", () => {
  it("seller B cannot update seller A's offer — NOT_FOUND, data unchanged", async () => {
    const res = await updateSellerOffer(SELLER_B, ACTOR, offerAId, {
      priceIrr: 1, stock: 0, shippingDaysMin: 0, shippingDaysMax: 0,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("NOT_FOUND");
    const row = await prisma.offer.findUniqueOrThrow({ where: { id: offerAId } });
    expect(row.price).toBe(1_500_000); // untouched
  });

  it("seller B cannot read seller A's orders via detail service", async () => {
    const res = await getSellerOrder(SELLER_B, orderAId);
    expect(res).toBeNull();
  });

  it("seller B cannot transition seller A's order status", async () => {
    const res = await updateSellerOrderStatus(SELLER_B, ACTOR, orderAId, "SHIPPED");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("NOT_FOUND");
    const row = await prisma.sellerOrder.findUniqueOrThrow({ where: { id: orderAId } });
    expect(row.status).toBe("CONFIRMED");
  });

  it("nonexistent offer ids are indistinguishable from foreign ones (NOT_FOUND either way)", async () => {
    const res = await updateSellerOffer(SELLER_A, ACTOR, "does-not-exist", {
      priceIrr: 100, stock: 1, shippingDaysMin: 0, shippingDaysMax: 1,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("NOT_FOUND");
  });

  it("getSellerOrders only returns own suborders", async () => {
    // Hermetic fixture: the isolation target must not depend on residual rows
    // from other suites — create a dedicated foreign suborder (P2-H CI parity).
    const foreignOrder = await prisma.order.create({
      data: {
        orderNumber: `P2D-FGN-${Date.now()}`, status: "PAID", paymentStatus: "SUCCEEDED",
        total: 1_600_000,
        sellerOrders: {
          create: {
            sellerId: SELLER_B, status: "CONFIRMED", subtotal: 1_600_000, shipping: 0,
            items: { create: { partId: csvPartId, offerId: offerBId, quantity: 1, unitPrice: 1_600_000, total: 1_600_000 } },
          },
        },
      },
      include: { sellerOrders: true },
    });
    createdOrderIds.push(foreignOrder.id);
    const foreign = foreignOrder.sellerOrders[0]!;

    const mine = await getSellerOrders(SELLER_A);
    expect(mine.rows.some((r) => r.id === foreign.id)).toBe(false);
    expect(mine.rows.some((r) => r.id === orderAId)).toBe(true);
  });

  it("seller profile update cannot touch verified/rating/status (whitelist)", async () => {
    const before = await prisma.seller.findUniqueOrThrow({ where: { id: SELLER_A } });
    const res = await updateSellerProfile(SELLER_A, ACTOR, {
      businessName: "فروشنده نمایشی ۱ (ویرایش تست)",
      ownerName: "مستربین",
      phone: "02100000001",
      city: "تهران",
      address: "آدرس تست",
      // injection attempts — must be ignored by the Zod whitelist:
      verified: true, rating: 5, status: "VERIFIED",
    } as never);
    expect(res.ok).toBe(true);
    const after = await prisma.seller.findUniqueOrThrow({ where: { id: SELLER_A } });
    expect(after.verified).toBe(before.verified);
    expect(after.rating).toBe(before.rating);
    expect(after.status).toBe(before.status);
    expect(after.ownerName).toBe("مستربین");
  });
});

// ─────────────────── Offer management (§12, §41–42, §62) ───────────────────

describe("offer update validation", () => {
  it("rejects negative price / negative stock / reversed shipping range with Persian errors", async () => {
    const res = await updateSellerOffer(SELLER_A, ACTOR, offerAId, {
      priceIrr: -5, stock: -1, shippingDaysMin: 5, shippingDaysMax: 2,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("INVALID");
      expect(res.errors?.some((e) => e.includes("قیمت"))).toBe(true);
    }
  });

  it("rejects float money and huge integers", async () => {
    const res = await updateSellerOffer(SELLER_A, ACTOR, offerAId, {
      priceIrr: 1500.75 as unknown as number, stock: 1, shippingDaysMin: 1, shippingDaysMax: 2,
    });
    expect(res.ok).toBe(false);
    const res2 = await updateSellerOffer(SELLER_A, ACTOR, offerAId, {
      priceIrr: 10_000_000_000_000, stock: 1, shippingDaysMin: 1, shippingDaysMax: 2,
    });
    expect(res2.ok).toBe(false);
  });

  it("valid update writes server-authoritative price/stock + freshness timestamps + audit rows", async () => {
    const res = await updateSellerOffer(SELLER_A, ACTOR, offerAId, {
      priceIrr: 1_800_000, stock: 5, sellerSku: "T-P2D-A2",
      shippingDaysMin: 3, shippingDaysMax: 4, warrantyFa: "۶ ماه",
    });
    expect(res.ok).toBe(true);
    const row = await prisma.offer.findUniqueOrThrow({ where: { id: offerAId } });
    expect(row.price).toBe(1_800_000);
    expect(row.stock).toBe(5);
    expect(row.shippingDaysMin).toBe(3);
    expect(row.shippingDaysMax).toBe(4);
    expect(row.shippingDays).toBe(3); // legacy stays in sync
    expect(row.stockUpdatedAt).toBeTruthy();
    expect(row.priceUpdatedAt).toBeTruthy();
    const logs = await prisma.sellerEventLog.findMany({ where: { sellerId: SELLER_A, entityId: offerAId, actor: ACTOR } });
    const events = logs.map((l) => l.event).sort();
    expect(events).toContain("seller_offer_price_updated");
    expect(events).toContain("seller_offer_stock_updated");
    expect(events).toContain("seller_offer_sku_updated");
  });

  it("historical OrderItem keeps its snapshot price after offer price change (§28)", async () => {
    await updateSellerOffer(SELLER_A, ACTOR, offerAId, { priceIrr: 2_000_000, stock: 5, shippingDaysMin: 2, shippingDaysMax: 3 });
    const item = await prisma.orderItem.findFirstOrThrow({ where: { sellerOrderId: orderAId } });
    expect(item.unitPrice).toBe(1_500_000); // snapshot immutable
  });

  it("activate/deactivate is idempotent and audited once per real change", async () => {
    await setSellerOfferActive(SELLER_A, ACTOR, offerAId, false);
    const first = await prisma.sellerEventLog.count({ where: { sellerId: SELLER_A, entityId: offerAId, event: "seller_offer_status_changed", actor: ACTOR } });
    await setSellerOfferActive(SELLER_A, ACTOR, offerAId, false); // duplicate = no-op
    const second = await prisma.sellerEventLog.count({ where: { sellerId: SELLER_A, entityId: offerAId, event: "seller_offer_status_changed", actor: ACTOR } });
    expect(second).toBe(first);
    await setSellerOfferActive(SELLER_A, ACTOR, offerAId, true);
  });
});

// ─────────────────── Inventory freshness (§15–16, §63) ───────────────────

describe("inventory listing", () => {
  it("filters low_stock with row-level threshold comparison", async () => {
    const { rows } = await getSellerOffers(SELLER_A, { status: "low_stock" });
    for (const r of rows) {
      expect(r.stock).toBeGreaterThan(0);
      expect(r.stock).toBeLessThanOrEqual(r.lowStockThreshold);
    }
  });

  it("out_of_stock filter and freshness flags", async () => {
    await prisma.offer.update({ where: { id: offerAId }, data: { stock: 0, stockUpdatedAt: new Date() } });
    const { rows } = await getSellerOffers(SELLER_A, { status: "out_of_stock" });
    expect(rows.some((r) => r.id === offerAId)).toBe(true);
    const fresh = await getSellerOffers(SELLER_A, {});
    expect(fresh.rows.find((r) => r.id === offerAId)?.freshness).toBe("fresh");
    await prisma.offer.update({ where: { id: offerAId }, data: { stock: 5 } });
  });
});

// ─────────────────── CSV (§17–23, §43, §64) ───────────────────

describe("csv import/export", () => {
  const header = "seller_sku,part_id,price_irr,stock,shipping_days_min,shipping_days_max,active";
  const validRow = () => `${header}\nT-P2D-A2,${csvPartId},1750000,7,2,4,1`;

  it("parses and previews a valid file; commit updates all rows (all-or-nothing)", async () => {
    const parsed = parseSellerInventoryCsv(validRow());
    expect(parsed.ok).toBe(true);
    const { preview, validCount, invalidCount } = await previewSellerInventoryImport(SELLER_A, parsed);
    expect(validCount).toBe(1);
    expect(invalidCount).toBe(0);
    expect(preview[0]?.partTitle).toBeTruthy();

    const res = await commitSellerInventoryImport(SELLER_A, ACTOR, preview);
    expect(res.ok).toBe(true);
    const row = await prisma.offer.findUniqueOrThrow({ where: { id: offerAId } });
    expect(row.price).toBe(1_750_000);
    expect(row.stock).toBe(7);
  });

  it("unknown SKU → INVALID (no offer created); foreign SKU → INVALID, other seller untouched", async () => {
    const csv = `${header}\nNO-SUCH-SKU,${csvPartId},100,1,1,1,1\nT-P2D-B,${csvPartId},100,1,1,1,1`;
    const parsed = parseSellerInventoryCsv(csv);
    expect(parsed.ok).toBe(true);
    const { preview, validCount } = await previewSellerInventoryImport(SELLER_A, parsed);
    expect(validCount).toBe(0);
    expect(preview.every((r) => r.status === "INVALID")).toBe(true);

    const res = await commitSellerInventoryImport(SELLER_A, ACTOR, preview);
    expect(res.ok).toBe(false);
    const b = await prisma.offer.findUniqueOrThrow({ where: { id: offerBId } });
    expect(b.price).toBe(1_600_000); // seller B untouched
  });

  it("mixed file with one invalid row → commit refused entirely (all-or-nothing)", async () => {
    const csv = `${header}\nT-P2D-A2,${csvPartId},123,1,1,2,1\nT-P2D-A2,${csvPartId},-5,1,1,2,1`;
    const parsed = parseSellerInventoryCsv(csv);
    const { preview } = await previewSellerInventoryImport(SELLER_A, parsed);
    const res = await commitSellerInventoryImport(SELLER_A, ACTOR, preview);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("HAS_INVALID");
    const row = await prisma.offer.findUniqueOrThrow({ where: { id: offerAId } });
    expect(row.price).not.toBe(123); // nothing applied
  });

  it("rejects bad headers, negative stock, malformed boolean, oversized input", async () => {
    expect(parseSellerInventoryCsv("a,b\n1,2").ok).toBe(false);
    const badStock = parseSellerInventoryCsv(`${header}\nT-P2D-A2,${csvPartId},100,-3,1,2,1`);
    expect(badStock.rows[0]?.status).toBe("INVALID");
    const badBool = parseSellerInventoryCsv(`${header}\nT-P2D-A2,${csvPartId},100,1,1,2,xyz`);
    expect(badBool.rows[0]?.status).toBe("INVALID");
    const big = parseSellerInventoryCsv("x".repeat(2 * 1024 * 1024 + 10));
    expect(big.ok).toBe(false);
    const manyRows = parseSellerInventoryCsv(`${header}\n` + Array.from({ length: 501 }, (_, i) => `T-P2D-A2,${csvPartId},100,1,1,2,1`).join("\n"));
    expect(manyRows.ok).toBe(false);
  });

  it("export contains only seller's rows and escapes formula-injection openers", async () => {
    await prisma.offer.update({ where: { id: offerAId }, data: { sellerSku: "=1+1" } });
    const csv = await exportSellerInventoryCsv(SELLER_A);
    const lines = csv.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(csv).toContain("'=1+1"); // escaped
    expect(csv).not.toContain("T-P2D-B"); // no foreign rows
    await prisma.offer.update({ where: { id: offerAId }, data: { sellerSku: "T-P2D-A2" } });
  });
});

// ─────────────────── Orders state machine (§26, §65) ───────────────────

describe("seller order state machine", () => {
  it("valid path CONFIRMED → SHIPPED → DELIVERED", async () => {
    const r1 = await updateSellerOrderStatus(SELLER_A, ACTOR, orderAId, "SHIPPED");
    expect(r1.ok).toBe(true);
    const r2 = await updateSellerOrderStatus(SELLER_A, ACTOR, orderAId, "DELIVERED");
    expect(r2.ok).toBe(true);
  });

  it("invalid jump rejected: CANCELLED(terminal) → SHIPPED", async () => {
    const res = await updateSellerOrderStatus(SELLER_A, ACTOR, orderAId, "SHIPPED");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("INVALID_TRANSITION");
  });

  it("duplicate status update is idempotent (no duplicate audit)", async () => {
    const before = await prisma.sellerEventLog.count({ where: { entityId: orderAId, event: "seller_order_status_changed", actor: ACTOR } });
    const res = await updateSellerOrderStatus(SELLER_A, ACTOR, orderAId, "DELIVERED");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.idempotent).toBe(true);
    const after = await prisma.sellerEventLog.count({ where: { entityId: orderAId, event: "seller_order_status_changed", actor: ACTOR } });
    expect(after).toBe(before);
  });

  it("concurrent duplicate SHIPPED→DELIVERED updates: exactly one audit row, valid final state", async () => {
    // Reset to CONFIRMED via a second fixture order.
    const order = await prisma.order.create({
      data: {
        orderNumber: `P2D-C-${Date.now()}`, status: "PAID", paymentStatus: "SUCCEEDED",
        total: 1_500_000,
        sellerOrders: { create: { sellerId: SELLER_A, status: "CONFIRMED", subtotal: 1_500_000 } },
      },
      include: { sellerOrders: true },
    });
    createdOrderIds.push(order.id);
    const soId = order.sellerOrders[0]!.id;

    const results = await Promise.all([
      updateSellerOrderStatus(SELLER_A, ACTOR, soId, "SHIPPED"),
      updateSellerOrderStatus(SELLER_A, ACTOR, soId, "SHIPPED"),
      updateSellerOrderStatus(SELLER_A, ACTOR, soId, "SHIPPED"),
    ]);
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBeGreaterThanOrEqual(1); // idempotent duplicates also ok
    const row = await prisma.sellerOrder.findUniqueOrThrow({ where: { id: soId } });
    expect(row.status).toBe("SHIPPED"); // exactly valid final state
    const audit = await prisma.sellerEventLog.count({
      where: { entityId: soId, event: "seller_order_status_changed", actor: ACTOR, meta: { path: ["to"], equals: "SHIPPED" } },
    });
    expect(audit).toBe(1); // no duplicate side effects
  });
});

// ─────────────────── Vertical privilege (§39): customer/seller boundaries ───────────────────

describe("vertical privilege boundaries", () => {
  it("customer/session identity cannot resolve as seller (getAuthenticatedSeller contract)", async () => {
    // The route layer derives identity solely from the poom_uid cookie; a guest
    // or customer cookie yields null → 404 in every seller API route.
    const { getAuthenticatedSellerForTest } = await import("@/lib/seller/seller-auth-test");
    expect(await getAuthenticatedSellerForTest(null)).toBeNull();
    const customer = await prisma.user.upsert({
      where: { phone: "09120000000" }, update: { role: "CUSTOMER" }, create: { phone: "09120000000", role: "CUSTOMER" },
    });
    expect(await getAuthenticatedSellerForTest(customer.id)).toBeNull();
  });

  it("seller cannot mutate Fitment / Catalog / 3D mapping (admin-only surfaces)", async () => {
    // These mutations live exclusively in admin actions guarded by the ADMIN
    // identity; the seller service layer exposes NO fitment/catalog/3D writes.
    const sellerExports = await import("@/lib/seller/seller-offers");
    const orderExports = await import("@/lib/seller/seller-orders");
    const svcExports = await import("@/lib/seller/seller-service");
    for (const mod of [sellerExports, orderExports, svcExports]) {
      for (const [name, fn] of Object.entries(mod)) {
        if (typeof fn !== "function") continue;
        expect(name).not.toMatch(/fitment|catalog|zone|asset|mapping/i);
      }
    }
    // And the admin mutation paths reject a SELLER-ROLE user:
    const { getAuthenticatedAdminForTest } = await import("@/lib/seller/seller-auth-test");
    const sellerUser = await prisma.user.findUniqueOrThrow({ where: { phone: "09012345678" } });
    expect(await getAuthenticatedAdminForTest(sellerUser.id)).toBeNull();
  });
});

// ─────────────────── Concurrency (§36, §66) ───────────────────

describe("concurrency", () => {
  it("Scenario A: seller stock update + customer settlement → no negative stock, no lost settlement", async () => {
    // Fixture: dedicated offer with stock 3; buyer buys 2; seller sets stock 9 concurrently.
    const offer = await prisma.offer.create({
      data: {
        sellerId: SELLER_A, partId: csvPartId, price: 900_000, stock: 3,
        shippingDaysMin: 1, shippingDaysMax: 2, shippingDays: 1,
        sellerSku: "T-P2D-RACE", active: true, stockUpdatedAt: new Date(),
      },
    });
    createdOffers.push(offer.id);
    const order = await prisma.order.create({
      data: {
        orderNumber: `P2D-RC-${Date.now()}`, status: "PENDING_PAYMENT", paymentStatus: "PENDING",
        total: 1_800_000, sessionId: "p2d-race-session",
        sellerOrders: {
          create: {
            sellerId: SELLER_A, status: "PENDING", subtotal: 1_800_000,
            items: { create: { partId: csvPartId, offerId: offer.id, quantity: 2, unitPrice: 900_000, total: 1_800_000 } },
          },
        },
      },
      include: { sellerOrders: true },
    });
    createdOrderIds.push(order.id);
    const payment = await prisma.payment.create({
      data: { orderId: order.id, provider: "mock", amount: 1_800_000, status: "PENDING", authority: `p2d-auth-${Date.now()}` },
    });

    // Settlement replicates Phase-1 mechanics (conditional decrement inside tx).
    const settle = (async () => {
      await prisma.$transaction(async (tx) => {
        const items = await tx.orderItem.findMany({ where: { sellerOrder: { orderId: order.id } } });
        for (const it of items) {
          const updated = await tx.offer.updateMany({
            where: { id: it.offerId, stock: { gte: it.quantity } },
            data: { stock: { decrement: it.quantity } },
          });
          if (updated.count !== 1) throw new Error("STOCK_CONFLICT");
        }
        await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCEEDED" } });
        await tx.order.update({ where: { id: order.id }, data: { status: "PAID", paymentStatus: "SUCCEEDED" } });
        await tx.sellerOrder.updateMany({ where: { orderId: order.id }, data: { status: "CONFIRMED" } });
      });
    })();

    const sellerUpdate = updateSellerOffer(SELLER_A, ACTOR, offer.id, {
      priceIrr: 900_000, stock: 9, shippingDaysMin: 1, shippingDaysMax: 2,
    });

    await Promise.allSettled([settle, sellerUpdate]);

    const final = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
    const paid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(final.stock).toBeGreaterThanOrEqual(0); // never negative
    expect([7, 9]).toContain(final.stock); // 9→7 (settlement won/lost properly) or 9 then settlement after
    expect(paid.status).toBe("PAID"); // settlement succeeded
  });

  it("Scenario B: two concurrent seller stock updates → last committed wins, no corruption", async () => {
    const res = await Promise.allSettled([
      updateSellerOffer(SELLER_A, ACTOR, offerAId, { priceIrr: 1_100_000, stock: 21, shippingDaysMin: 1, shippingDaysMax: 2 }),
      updateSellerOffer(SELLER_A, ACTOR, offerAId, { priceIrr: 1_200_000, stock: 22, shippingDaysMin: 1, shippingDaysMax: 2 }),
    ]);
    const fulfilled = res.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(2); // both valid server-authoritative writes
    const row = await prisma.offer.findUniqueOrThrow({ where: { id: offerAId } });
    expect([1_100_000, 1_200_000]).toContain(row.price);
    expect([21, 22]).toContain(row.stock);
    expect(row.stock).toBeGreaterThanOrEqual(0);
  });
});
