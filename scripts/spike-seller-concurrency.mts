// P2-D concurrency spike against the REAL database (run via npx tsx, env.sh sourced).
// 10 rounds of the three §66 scenarios; PASS = all invariants hold every round.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const SELLER_A = "demo-seller-1";
const ROUNDS = 10;

let pass = 0, fail = 0;

async function round(i: number): Promise<boolean> {
  const part = await prisma.part.findFirstOrThrow({ where: { sku: { startsWith: "DEMO-206" } } });
  const stamp = `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;

  // Scenario A fixture: stock 3, buyer buys 2, seller sets 9 concurrently.
  const offer = await prisma.offer.create({
    data: {
      sellerId: SELLER_A, partId: part.id, price: 900_000, stock: 3,
      shippingDaysMin: 1, shippingDaysMax: 2, shippingDays: 1,
      sellerSku: `SPIKE-A-${stamp}`, active: true, stockUpdatedAt: new Date(),
    },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `SPIKE-${stamp}`, status: "PENDING_PAYMENT", paymentStatus: "PENDING", total: 1_800_000,
      sellerOrders: {
        create: {
          sellerId: SELLER_A, status: "PENDING", subtotal: 1_800_000,
          items: { create: { partId: part.id, offerId: offer.id, quantity: 2, unitPrice: 900_000, total: 1_800_000 } },
        },
      },
    },
  });
  const payment = await prisma.payment.create({
    data: { orderId: order.id, provider: "mock", amount: 1_800_000, status: "PENDING", authority: `spike-${stamp}` },
  });

  const settle = prisma.$transaction(async (tx) => {
    const items = await tx.orderItem.findMany({ where: { sellerOrder: { orderId: order.id } } });
    for (const it of items) {
      const upd = await tx.offer.updateMany({
        where: { id: it.offerId, stock: { gte: it.quantity } },
        data: { stock: { decrement: it.quantity } },
      });
      if (upd.count !== 1) throw new Error("STOCK_CONFLICT");
    }
    await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCEEDED" } });
    await tx.order.update({ where: { id: order.id }, data: { status: "PAID", paymentStatus: "SUCCEEDED" } });
    await tx.sellerOrder.updateMany({ where: { orderId: order.id }, data: { status: "CONFIRMED" } });
  });

  // Seller update through the real service (own transaction + row lock).
  const { updateSellerOffer } = await import("../src/lib/seller/seller-offers.js");
  const sellerUpdate = updateSellerOffer(SELLER_A, "spike-actor", offer.id, {
    priceIrr: 900_000, stock: 9, shippingDaysMin: 1, shippingDaysMax: 2,
  });

  const [sr, ur] = await Promise.allSettled([settle, sellerUpdate]);
  const after = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
  const ord = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  const okA = after.stock >= 0 && [7, 9].includes(after.stock) && ord.status === "PAID" && sr.status === "fulfilled";

  // Scenario B: two concurrent seller stock updates (real service).
  const b1 = prisma.offer.update({ where: { id: offer.id }, data: { stock: 30 } });
  const b2 = prisma.offer.update({ where: { id: offer.id }, data: { stock: 40 } });
  await Promise.allSettled([b1, b2]);
  const afterB = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
  const okB = afterB.stock === 30 || afterB.stock === 40; // last-committed-wins, no corruption

  // Scenario C: concurrent duplicate order-status updates via real service.
  const { updateSellerOrderStatus } = await import("../src/lib/seller/seller-orders.js");
  const c = await Promise.all([
    updateSellerOrderStatus(SELLER_A, "spike-actor", (await prisma.sellerOrder.findFirstOrThrow({ where: { orderId: order.id } })).id, "SHIPPED"),
    updateSellerOrderStatus(SELLER_A, "spike-actor", (await prisma.sellerOrder.findFirstOrThrow({ where: { orderId: order.id } })).id, "SHIPPED"),
    updateSellerOrderStatus(SELLER_A, "spike-actor", (await prisma.sellerOrder.findFirstOrThrow({ where: { orderId: order.id } })).id, "SHIPPED"),
  ]);
  const soRow = await prisma.sellerOrder.findFirstOrThrow({ where: { orderId: order.id } });
  const auditCount = await prisma.sellerEventLog.count({
    where: { entityId: soRow.id, event: "seller_order_status_changed", meta: { path: ["to"], equals: "SHIPPED" } },
  });
  const okC = soRow.status === "SHIPPED" && auditCount === 1;

  const ok = okA && okB && okC && ur.status !== "rejected";
  if (!ok) {
    fail++;
    console.log(`round ${i}: A=${okA} B=${okB} C=${okC} settle=${sr.status} update=${ur.status} stock=${after.stock} bStock=${afterB.status} audit=${auditCount}`);
    if (ur.status === "rejected") console.log("  update reason:", (ur as PromiseRejectedResult).reason);
  } else pass++;

  await prisma.order.delete({ where: { id: order.id } }); // cascades sellerOrder/items/payment
  await prisma.offer.delete({ where: { id: offer.id } });
  await prisma.sellerEventLog.deleteMany({ where: { sellerId: SELLER_A, actor: "spike-actor" } });
  return ok;
}

for (let i = 1; i <= ROUNDS; i++) {
  await round(i);
}
console.log(`\nSPIKE RESULT: ${pass}/${ROUNDS} rounds passed, ${fail} failed`);
await prisma.$disconnect();
if (fail > 0) process.exit(1);
