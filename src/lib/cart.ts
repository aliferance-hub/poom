import { prisma } from "@/lib/prisma";
import { newSessionId } from "@/lib/persian";
import type { Offer, Seller, Part } from "@prisma/client";

export type CartLine = {
  itemId: string;
  offerId: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  offer: Offer & { seller: Seller; part: Part };
};

export type CartView = {
  sessionId: string;
  lines: CartLine[];
  itemCount: number;
  subtotal: number;
  errors: string[];
};

/** Always ensure a cart row exists for the session (server is source of truth).
 *  Concurrency-safe: parallel first requests (page + /api/cart) race the insert;
 *  the sessionId unique constraint picks exactly one winner, losers re-read. */
export async function getOrCreateCart(sessionId: string) {
  const existing = await prisma.cart.findUnique({ where: { sessionId } });
  if (existing) return existing;
  try {
    return await prisma.cart.create({ data: { sessionId } });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      return prisma.cart.findUniqueOrThrow({ where: { sessionId } });
    }
    throw e;
  }
}

/** Server-authoritative cart view: re-reads prices/stock from DB, flags issues. */
export async function getCartView(sessionId: string): Promise<CartView> {
  const cart = await getOrCreateCart(sessionId);
  const items = await prisma.cartItem.findMany({
    where: { cartId: cart.id },
    include: { offer: { include: { seller: true, part: true } } },
    orderBy: { id: "asc" },
  });

  const lines: CartLine[] = [];
  const errors: string[] = [];
  let subtotal = 0;
  let itemCount = 0;

  for (const it of items) {
    const o = it.offer;
    if (!o.active) {
      errors.push(`پیشنهاد «${o.part.title}» از «${o.seller.businessName}» غیرفعال شد و از سبد حذف می‌شود.`);
      continue;
    }
    const qty = Math.min(it.quantity, o.stock);
    if (qty <= 0) {
      errors.push(`«${o.part.title}» از «${o.seller.businessName}» ناموجود شد.`);
      // Drop dead lines so the authoritative view and DB converge.
      await prisma.cartItem.delete({ where: { id: it.id } }).catch(() => {});
      continue;
    }
    if (qty < it.quantity) {
      errors.push(`موجودی «${o.part.title}» فقط ${qty} عدد است (درخواست ${it.quantity}).`);
    }
    const lineTotal = qty * o.price;
    lines.push({ itemId: it.id, offerId: o.id, quantity: qty, unitPrice: o.price, lineTotal, offer: o });
    subtotal += lineTotal;
    itemCount += qty;
  }
  return { sessionId, lines, itemCount, subtotal, errors };
}

export async function addToCart(sessionId: string, offerId: string, quantity: number) {
  const offer = await prisma.offer.findUnique({ where: { id: offerId } });
  if (!offer || !offer.active) throw new Error("OFFER_UNAVAILABLE");
  if (offer.stock <= 0) throw new Error("OUT_OF_STOCK");
  const qty = Math.max(1, Math.min(quantity, offer.stock));
  const cartId = (await getOrCreateCart(sessionId)).id;

  const existing = await prisma.cartItem.findUnique({
    where: { cartId_offerId: { cartId, offerId } },
  });
  if (existing) {
    return prisma.cartItem.update({
      where: { id: existing.id },
      data: { quantity: Math.min(existing.quantity + qty, offer.stock) },
    });
  }
  try {
    return await prisma.cartItem.create({
      data: { cartId, offerId, quantity: qty },
    });
  } catch (e) {
    // parallel add of the same offer — merge into the winning line
    if ((e as { code?: string }).code === "P2002") {
      const again = await prisma.cartItem.findUniqueOrThrow({ where: { cartId_offerId: { cartId, offerId } } });
      return prisma.cartItem.update({
        where: { id: again.id },
        data: { quantity: Math.min(again.quantity + qty, offer.stock) },
      });
    }
    throw e;
  }
}

export async function updateCartItem(sessionId: string, itemId: string, quantity: number) {
  const cart = await getOrCreateCart(sessionId);
  const item = await prisma.cartItem.findFirst({ where: { id: itemId, cartId: cart.id }, include: { offer: true } });
  if (!item) throw new Error("ITEM_NOT_FOUND");
  if (quantity <= 0) return prisma.cartItem.delete({ where: { id: itemId } });
  return prisma.cartItem.update({
    where: { id: itemId },
    data: { quantity: Math.min(quantity, item.offer.stock) },
  });
}

export async function removeCartItem(sessionId: string, itemId: string) {
  const cart = await getOrCreateCart(sessionId);
  const item = await prisma.cartItem.findFirst({ where: { id: itemId, cartId: cart.id } });
  if (!item) throw new Error("ITEM_NOT_FOUND");
  return prisma.cartItem.delete({ where: { id: itemId } });
}
