"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { assertDemoTrust } from "@/lib/demo-trust";
import type { FitmentStatus } from "@prisma/client";

/**
 * DEMO trust boundary lives in @/lib/demo-trust (a "use server" module may only
 * export async functions). Actions below remain the only write surface used by
 * seller/admin UIs.
 */

export async function updateSellerOfferAction(offerId: string, price: number, stock: number) {
  await assertDemoTrust();
  // TODO(AUTH): scope to `where: { id: offerId, sellerId: currentSellerId() }` so a
  // seller can never modify another seller's offer (audit finding SEC-1).
  const p = Math.max(0, Math.round(Number(price) || 0));
  const s = Math.max(0, Math.round(Number(stock) || 0));
  await prisma.offer.update({ where: { id: offerId }, data: { price: p, stock: s } });
  revalidatePath("/seller");
  revalidatePath("/admin");
}

export async function updateFitmentStatusAction(fitmentId: string, status: FitmentStatus) {
  await assertDemoTrust();
  const allowed: FitmentStatus[] = ["CONFIRMED", "PARTIAL", "REJECTED", "PENDING_REVIEW"];
  if (!allowed.includes(status)) throw new Error("BAD_STATUS");
  await prisma.fitment.update({ where: { id: fitmentId }, data: { fitmentStatus: status } });
  revalidatePath("/admin/fitment");
}

export async function updateZoneAction(zoneId: string, title: string, description: string) {
  await assertDemoTrust();
  await prisma.vehicleZone.update({
    where: { id: zoneId },
    data: { title: title.slice(0, 80), description: description.slice(0, 200) },
  });
  revalidatePath("/admin");
  revalidatePath("/admin/zones");
}
