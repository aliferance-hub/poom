import { test, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { addToCart } from "@/lib/cart";
import { createCheckout } from "@/lib/checkout";
import { paymentService } from "@/lib/payments";

test("probe raw settlement race errors", async () => {
  const prisma = new PrismaClient();
  const sid = `probe_${Date.now()}`;
  const sellers = await prisma.seller.findMany({ where: { sellerStatus: "ACTIVE", id: { startsWith: "demo-" } }, take: 2, orderBy: { businessName: "asc" } });
  const rPart = await prisma.part.findUniqueOrThrow({ where: { slug: "radiator-206" } });
  const padPart = await prisma.part.findUniqueOrThrow({ where: { slug: "brake-pad-front-206" } });
  const rOffer = await prisma.offer.upsert({ where: { id: "probe-conc-r" }, update: { stock: 1 }, create: { id: "probe-conc-r", sellerId: sellers[0]!.id, partId: rPart.id, price: 111000, stock: 1, lowStockThreshold: 1 } });
  const pOffer = await prisma.offer.upsert({ where: { id: "probe-conc-p" }, update: { stock: 1 }, create: { id: "probe-conc-p", sellerId: sellers[1]!.id, partId: padPart.id, price: 99000, stock: 1, lowStockThreshold: 1 } });
  await addToCart(sid, rOffer.id, 1);
  await addToCart(sid, pOffer.id, 1);
  const checkout = await createCheckout(sid);
  if (!checkout.ok) throw new Error("checkout failed");
  const payment = await prisma.payment.findUniqueOrThrow({ where: { authority: checkout.authority }, include: { attempts: true } });
  const attempt = payment.attempts.find((a) => a.authority === checkout.authority)!;
  const ps = paymentService();
  const verify = await ps.verifyPayment({ authority: checkout.authority, outcome: "success" });
  console.log("verify:", JSON.stringify(verify));
  const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
    prisma.$transaction(async (tx) => {
      const claimed = await tx.paymentAttempt.updateMany({ where: { id: attempt.id, status: "PENDING" }, data: { status: "SUCCEEDED", completedAt: new Date() } });
      if (claimed.count !== 1) return "already";
      await tx.offer.updateMany({ where: { id: rOffer.id, stock: { gte: 1 } }, data: { stock: { decrement: 1 } } });
      await tx.offer.updateMany({ where: { id: pOffer.id, stock: { gte: 1 } }, data: { stock: { decrement: 1 } } });
      return "settled";
    }).catch((e) => `ERR: ${String(e).slice(0, 300)}`),
  ));
  for (const r of results) console.log(r.status === "fulfilled" ? String(r.value) : `REJ ${String(r.reason).slice(0, 200)}`);
  console.log("rStock:", (await prisma.offer.findUniqueOrThrow({ where: { id: "probe-conc-r" } })).stock);
  // cleanup
  await prisma.paymentAttempt.deleteMany({ where: { paymentId: payment.id } });
  await prisma.payment.deleteMany({ where: { id: payment.id } });
  await prisma.order.deleteMany({ where: { id: checkout.order.id } });
  await prisma.cartItem.deleteMany({ where: { cart: { sessionId: sid } } });
  await prisma.cart.deleteMany({ where: { sessionId: sid } });
  await prisma.offer.deleteMany({ where: { id: { in: ["probe-conc-r", "probe-conc-p"] } } });
  await prisma.$disconnect();
  expect(true).toBe(true);
});
