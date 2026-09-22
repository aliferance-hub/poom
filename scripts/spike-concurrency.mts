// Concurrency spike: N parallel settleMockPayment() calls on ONE authority.
// PASS = exactly 1 OK; dependent offer stock hits exactly 0 (no oversell); no negative stock.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const N = 10;

async function main() {
  // Fixture: two offers from DIFFERENT sellers, stock=1 each, one cart line per offer.
  const sellers = await prisma.seller.findMany({ take: 2 });
  let rPart = await prisma.part.findUnique({ where: { slug: "radiator-206" } });
  let padPart = await prisma.part.findUnique({ where: { slug: "brake-pad-front-206" } });
  if (!rPart || !padPart) throw new Error("seed missing");

  const rOffer = await prisma.offer.upsert({
    where: { id: "spike-radiator" },
    update: { stock: 1 },
    create: { id: "spike-radiator", sellerId: sellers[0].id, partId: rPart.id, price: 111000, stock: 1, lowStockThreshold: 1 },
  });
  const pOffer = await prisma.offer.upsert({
    where: { id: "spike-pad" },
    update: { stock: 1 },
    create: { id: "spike-pad", sellerId: sellers[1].id, partId: padPart.id, price: 99000, stock: 1, lowStockThreshold: 1 },
  });

  const sid = `spike_${Date.now()}`;
  const { addToCart, getCartView } = await import("../src/lib/cart.ts");
  const { createCheckout, settleMockPayment } = await import("../src/lib/checkout.ts");

  await addToCart(sid, rOffer.id, 1);
  await addToCart(sid, pOffer.id, 1);
  const view = await getCartView(sid);
  if (view.lines.length !== 2) throw new Error("fixture cart wrong: " + JSON.stringify(view));

  const checkout = await createCheckout(sid);
  if (!checkout.ok) throw new Error("checkout failed: " + JSON.stringify(checkout));
  const authority = checkout.authority;

  // Fire N parallel settlements on the SAME authority.
  const results = await Promise.allSettled(
    Array.from({ length: N }, () => settleMockPayment(authority, "success")),
  );
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const oks = fulfilled.filter((r) => r.value.ok).length;
  const rejects = results.filter((r) => r.status === "rejected");
  const reasons = fulfilled.filter((r) => !r.value.ok).map((r) => r.value.reason);

  const stockR = (await prisma.offer.findUnique({ where: { id: rOffer.id } })).stock;
  const stockP = (await prisma.offer.findUnique({ where: { id: pOffer.id } })).stock;

  const paid = await prisma.order.findUnique({ where: { orderNumber: checkout.order.orderNumber } });
  const cartLines = (await getCartView(sid)).lines.length;

  console.log(JSON.stringify({
    N, oks, rejects: rejects.length, reasons, stockR, stockP,
    orderStatus: paid.status, paymentStatus: paid.paymentStatus, cartLinesAfter: cartLines,
  }, null, 2));

  const pass = oks === 1 && stockR === 0 && stockP === 0 && paid.status === "PAID" && cartLines === 0;
  console.log(pass ? "SPIKE PASS ✔" : "SPIKE FAIL ✘");

  // cleanup fixture rows: OrderItems referencing fixtures first (Offer FK is RESTRICT),
  // then orders, cart, and the fixture offers themselves.
  await prisma.orderItem.deleteMany({ where: { offerId: { in: ["spike-radiator", "spike-pad"] } } });
  await prisma.order.deleteMany({ where: { orderNumber: checkout.order.orderNumber } });
  await prisma.cartItem.deleteMany({ where: { cart: { sessionId: sid } } });
  await prisma.cart.deleteMany({ where: { sessionId: sid } });
  await prisma.offer.deleteMany({ where: { id: { in: ["spike-radiator", "spike-pad"] } } });
  process.exit(pass ? 0 : 1);
}

main().finally(() => prisma.$disconnect());
