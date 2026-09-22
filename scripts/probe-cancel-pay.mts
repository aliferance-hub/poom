// Attack: cancel-then-callback — does settlement resurrect a CANCELLED order?
// Run from poom/ with alias support: npx --yes tsx is NOT used; we inline via
// vitest-free direct imports like spike-concurrency does (no @/ aliases here).
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const sid = `probe-cancel-${Date.now()}`;
  const offer = await prisma.offer.findFirstOrThrow({
    where: { part: { slug: "radiator-206" }, active: true, stock: { gte: 2 } },
    orderBy: { price: "asc" },
  });
  const cart = await prisma.cart.create({ data: { sessionId: sid } });
  await prisma.cartItem.create({ data: { cartId: cart.id, offerId: offer.id, quantity: 1 } });
  const stockBefore = offer.stock;

  // server-side view of the cart (mirrors getCartView price authority)
  const lines = await prisma.cartItem.findMany({ where: { cartId: cart.id }, include: { offer: true } });
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.offer.price, 0);

  const orderNumber = `PROBE-${Date.now().toString(36).toUpperCase()}`;
  const order = await prisma.order.create({
    data: { orderNumber, sessionId: sid, status: "PENDING_PAYMENT", paymentStatus: "PENDING", total: subtotal, shippingTotal: 0 },
  });
  const so = await prisma.sellerOrder.create({ data: { orderId: order.id, sellerId: offer.sellerId, status: "PENDING", subtotal, shipping: 0 } });
  await prisma.orderItem.create({ data: { sellerOrderId: so.id, partId: offer.partId, offerId: offer.id, quantity: 1, unitPrice: offer.price, total: subtotal } });
  const authority = `MOCK-${orderNumber}-probe`;
  const payment = await prisma.payment.create({ data: { orderId: order.id, provider: "mock", amount: subtotal, status: "PENDING", authority } });
  await prisma.paymentAttempt.create({ data: { paymentId: payment.id, attemptNumber: 1, provider: "mock", amountIrr: subtotal, authority, idempotencyKey: `${orderNumber}-k1` } });

  // customer cancels (mirror of cancelCustomerOrder service path)
  await prisma.$transaction([
    prisma.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } }),
    prisma.sellerOrder.updateMany({ where: { orderId: order.id, status: "PENDING" }, data: { status: "CANCELLED" } }),
  ]);

  // stale gateway success callback arrives via the real service
  
  const mod = await import("../src/lib/checkout.ts");
  const res = await mod.settleMockPayment(authority, "success");
  const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, paymentStatus: true } });
  const stockAfter = (await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).stock;
  console.log("settle:", JSON.stringify(res));
  console.log("order after:", JSON.stringify(after), "stock:", stockBefore, "->", stockAfter);
  console.log(after.status === "CANCELLED" && stockAfter === stockBefore ? "CANCEL_ATTACK: SAFE" : "CANCEL_ATTACK: VULNERABLE");

  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  await prisma.cart.delete({ where: { id: cart.id } });
  await prisma.orderItem.deleteMany({ where: { sellerOrderId: so.id } });
  await prisma.paymentAttempt.deleteMany({ where: { paymentId: payment.id } });
  await prisma.payment.delete({ where: { id: payment.id } });
  await prisma.sellerOrder.delete({ where: { id: so.id } });
  await prisma.order.delete({ where: { id: order.id } });
}
main().finally(() => prisma.$disconnect());
