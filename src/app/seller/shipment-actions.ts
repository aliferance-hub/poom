"use server";

import { revalidatePath } from "next/cache";
import { getAuthenticatedSeller } from "@/lib/auth/identity";
import { updateShipment } from "@/lib/governance";

/**
 * Seller shipment mutations (§33): identity + ownership + transition legality
 * are all enforced inside the service; these actions only adapt the form data.
 */
export async function readyShipmentAction(formData: FormData) {
  const identity = await getAuthenticatedSeller();
  if (!identity) return { ok: false as const, error: "دسترسی فروشنده یافت نشد." };
  const res = await updateShipment({
    sellerOrderId: String(formData.get("sellerOrderId")),
    sellerId: identity.seller.id,
    actor: identity.userId,
    to: "READY_TO_SHIP",
  });
  if (!res.ok) return { ok: false as const, error: res.detail ?? "تغییر وضعیت ارسال مجاز نیست." };
  revalidatePath("/seller/orders");
  return { ok: true as const };
}

export async function shipShipmentAction(formData: FormData) {
  const identity = await getAuthenticatedSeller();
  if (!identity) return { ok: false as const, error: "دسترسی فروشنده یافت نشد." };
  const res = await updateShipment({
    sellerOrderId: String(formData.get("sellerOrderId")),
    sellerId: identity.seller.id,
    actor: identity.userId,
    to: "SHIPPED",
    trackingCode: String(formData.get("trackingCode") ?? ""),
  });
  if (!res.ok) return { ok: false as const, error: res.detail ?? "ثبت ارسال مجاز نیست." };
  revalidatePath("/seller/orders");
  return { ok: true as const };
}

export async function deliverShipmentAction(formData: FormData) {
  const identity = await getAuthenticatedSeller();
  if (!identity) return { ok: false as const, error: "دسترسی فروشنده یافت نشد." };
  const res = await updateShipment({
    sellerOrderId: String(formData.get("sellerOrderId")),
    sellerId: identity.seller.id,
    actor: identity.userId,
    to: "DELIVERED",
  });
  if (!res.ok) return { ok: false as const, error: res.detail ?? "ثبت تحویل مجاز نیست." };
  revalidatePath("/seller/orders");
  return { ok: true as const };
}
