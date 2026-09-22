"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { addToCart, updateCartItem, removeCartItem } from "@/lib/cart";
import { createCheckout, settleMockPayment } from "@/lib/checkout";
import { getSessionId } from "@/lib/session";

export async function addToCartAction(formData: FormData) {
  const offerId = String(formData.get("offerId") ?? "");
  const quantity = Number(formData.get("quantity") ?? 1);
  // Open-redirect guard (audit S-9): only same-origin relative paths are honored.
  const rawBack = String(formData.get("back") ?? "/cart");
  const back = /^\/(?!\/)[^\\\s]*$/.test(rawBack) ? rawBack : "/cart";
  if (!offerId) return;
  const sid = await getSessionId();
  try {
    await addToCart(sid, offerId, Number.isFinite(quantity) ? quantity : 1);
  } catch {
    // DEMO UX: silent on unavailable offers; cart page shows authoritative state.
  }
  revalidatePath(back);
  revalidatePath("/cart");
  redirect(back.includes("#") ? back : `${back}#added`);
}

export async function updateCartItemAction(formData: FormData) {
  const itemId = String(formData.get("itemId") ?? "");
  const quantity = Number(formData.get("quantity") ?? 1);
  const sid = await getSessionId();
  if (itemId) await updateCartItem(sid, itemId, quantity);
  revalidatePath("/cart");
  revalidatePath("/checkout");
}

export async function removeCartItemAction(formData: FormData) {
  const itemId = String(formData.get("itemId") ?? "");
  const sid = await getSessionId();
  if (itemId) await removeCartItem(sid, itemId);
  revalidatePath("/cart");
  revalidatePath("/checkout");
}

export async function startCheckoutAction(formData: FormData) {
  const variantId = String(formData.get("variantId") ?? "") || undefined;
  const sid = await getSessionId();
  const result = await createCheckout(sid, variantId);
  if (!result.ok) {
    redirect(`/checkout?error=${encodeURIComponent(result.validation.problems.join(" | "))}`);
  }
  redirect(result.redirectUrl);
}

export async function mockPayAction(formData: FormData) {
  const authority = String(formData.get("authority") ?? "");
  const outcome = String(formData.get("outcome") ?? "success") === "failure" ? "failure" : "success";
  const result = await settleMockPayment(authority, outcome);
  if (result.ok) redirect(`/checkout/result?order=${encodeURIComponent(result.orderNumber)}`);
  redirect(`/checkout/result?order=${encodeURIComponent(result.orderNumber ?? "")}&failed=1&reason=${encodeURIComponent(result.reason ?? "")}`);
}
