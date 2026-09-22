import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { addToCart, getCartView } from "@/lib/cart";
import { createCheckout, settleMockPayment } from "@/lib/checkout";
import { resolveFitment } from "@/lib/fitment";
import { getAssetContractForVehicle } from "@/lib/registry3d";
import { getOffersForPart } from "@/lib/offers";
import type { OfferSort } from "@/lib/offers";

/**
 * P2-F (F7): the FIRST REAL END-TO-END PATH.
 *
 * 3D contract (part_radiator_main mesh)
 *   → mapped real Part (206-RAD-001, from the F5 pipeline)
 *   → Fitment Engine verdict for an active variant
 *   → seller offer (demo sellers remain for dev — F6)
 *   → cart → checkout → mock settlement → SellerOrder
 *
 * Uses only the production service layer — no special-case code.
 */

const sid = `p2f_e2e_${Math.random().toString(36).slice(2)}`;

async function realRadiator() {
  const contractVehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
  const contract = await getAssetContractForVehicle(contractVehicle.id);
  expect(contract).not.toBeNull();
  const meshPart = contract!.parts.find((p) => p.meshName === "part_radiator_main");
  expect(meshPart).not.toBeUndefined();

  const realPart = await prisma.part.findFirstOrThrow({ where: { sku: "206-RAD-001" } });
  // The 3D mesh must resolve to the REAL pipeline part (data-driven mapping).
  expect(meshPart!.partId).toBe(realPart.id);
  return { partId: realPart.id };
}

describe("P2-F F7: real 3D → part → fitment → offer → checkout path", () => {
  it("asset contract maps part_radiator_main to the real imported part", async () => {
    await realRadiator();
  });

  it("real part resolves COMPATIBLE for an active variant via the Fitment Engine", async () => {
    const { partId } = await realRadiator();
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { model: "206" } });
    const t5 = await prisma.vehicleVariant.findFirstOrThrow({ where: { vehicleId: vehicle.id, trim: "تیپ ۵" } });
    const res = await resolveFitment(partId, {
      vehicleId: vehicle.id, variantId: t5.id, engine: t5.engine, transmission: t5.transmission, year: 2010,
    });
    expect(res.status).toBe("COMPATIBLE");
  });

  it("offers appear for the real part", async () => {
    const { partId } = await realRadiator();
    // F6: sellers stay synthetic in dev — attach a dev offer (idempotent) so
    // the real part is purchasable exactly like production data would be.
    const demoSeller = await prisma.seller.findFirstOrThrow({ where: { sellerStatus: "ACTIVE" } });
    await prisma.offer.upsert({
      where: { id: "p2f-e2e-offer-rad" },
      create: { id: "p2f-e2e-offer-rad", sellerId: demoSeller.id, partId, price: 6_900_000, stock: 6, active: true },
      update: { partId, active: true, stock: 6 },
    });
    const offers = await getOffersForPart(partId, "best");
    expect(offers.length).toBeGreaterThan(0);
  });

  it("cart → checkout → settlement decrements stock exactly once", async () => {
    const { partId } = await realRadiator();

    const demoSeller = await prisma.seller.findFirstOrThrow({ where: { sellerStatus: "ACTIVE" } });
    const offer = await prisma.offer.upsert({
      where: { id: "p2f-e2e-offer-rad" },
      create: { id: "p2f-e2e-offer-rad", sellerId: demoSeller.id, partId, price: 6_900_000, stock: 6, active: true },
      update: { partId, active: true, stock: 6 },
    });
    const stockBefore = 6;

    await addToCart(sid, offer.id, 2);
    const view = await getCartView(sid);
    expect(view.lines.some((l) => l.offerId === offer.id)).toBe(true);

    const checkout = await createCheckout(sid);
    expect(checkout.ok).toBe(true);
    if (!checkout.ok) return;
    const authority = (checkout as { authority?: string }).authority ?? (checkout as unknown as { payment?: { authority?: string } }).payment?.authority;
    expect(authority).toBeTruthy();

    const settle = await settleMockPayment(authority ?? "", "success");
    expect(settle.ok).toBe(true);

    const after = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(after.stock).toBe(stockBefore - 2);

    const order = await prisma.order.findFirstOrThrow({ where: { sessionId: sid }, orderBy: { createdAt: "desc" } });
    expect(order.status).toBe("PAID"); // customer order settles → PAID
    const sellerOrders = await prisma.sellerOrder.findMany({ where: { orderId: order.id } });
    expect(sellerOrders.length).toBe(1);
    expect(sellerOrders[0]?.status).toBe("CONFIRMED"); // seller leg opens CONFIRMED after settlement

    await prisma.cart.deleteMany({ where: { sessionId: sid } });
  });
});
