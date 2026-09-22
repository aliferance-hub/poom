"use server";

import { revalidatePath } from "next/cache";
import { getAuthenticatedSeller } from "@/lib/seller/seller-auth";
import { getCurrentUser } from "@/lib/auth/identity";
import { updateSellerOffer, setSellerOfferActive } from "@/lib/seller/seller-offers";
import { updateSellerProfile } from "@/lib/seller/seller-service";
import { updateSellerOrderStatus, type WorkflowStatus } from "@/lib/seller/seller-orders";
import { applyAsSeller, createSellerOffer } from "@/lib/seller/seller-onboarding";

/**
 * Portal server actions (P2-D). Identity is resolved from the session cookie
 * on EVERY call; offerId/sellerOrderId are data, not authority. Failures
 * return domain-safe Persian messages — no stack traces, no existence leaks.
 */

const ERR_FA: Record<string, string> = {
  INVALID: "مقادیر ارسالی نامعتبر است.",
  NOT_FOUND: "این کالا متعلق به فروشگاه شما نیست یا یافت نشد.",
  DB_CONFLICT: "بروزرسانی همزمان؛ دوباره تلاش کنید.",
};

export async function saveOfferAction(formData: FormData) {
  const identity = await getAuthenticatedSeller();
  if (!identity) return { ok: false as const, error: "دسترسی فروشنده یافت نشد. دوباره وارد شوید." };

  const input = {
    priceIrr: Number(formData.get("priceIrr")),
    stock: Number(formData.get("stock")),
    sellerSku: String(formData.get("sellerSku") ?? "").trim(),
    shippingDaysMin: Number(formData.get("shippingDaysMin")),
    shippingDaysMax: Number(formData.get("shippingDaysMax")),
    warrantyFa: String(formData.get("warrantyFa") ?? "").trim(),
    active: formData.get("active") === "on" || formData.get("active") === "true",
  };

  const res = await updateSellerOffer(identity.seller.id, identity.userId, String(formData.get("offerId")), input);
  if (!res.ok) {
    const detail = res.reason === "INVALID" && res.errors ? res.errors.join("؛ ") : ERR_FA[res.reason];
    return { ok: false as const, error: detail ?? "خطای نامشخص." };
  }
  revalidatePath("/seller/offers");
  revalidatePath("/seller/inventory");
  revalidatePath("/seller");
  return { ok: true as const };
}

/** P2-G: a logged-in user applies to become a real seller (creates a PENDING seller). */
export async function applyAsSellerAction(formData: FormData): Promise<{ ok: true } | { ok: false; reason: string; errors?: string[] }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false as const, reason: "AUTH_REQUIRED" };
  const r = await applyAsSeller(user.id, {
    businessName: String(formData.get("businessName") ?? ""),
    ownerName: String(formData.get("ownerName") ?? "") || undefined,
    city: String(formData.get("city") ?? "") || undefined,
    address: String(formData.get("address") ?? "") || undefined,
  });
  if (r.ok) revalidatePath("/admin/sellers");
  return r;
}

/** P2-G: an ACTIVE real seller publishes a new offer on a real part. */
export async function createOfferAction(formData: FormData): Promise<{ ok: true; offerId: string } | { ok: false; error: string }> {
  const identity = await getAuthenticatedSeller();
  if (!identity) return { ok: false as const, error: "دسترسی فروشنده یافت نشد. دوباره وارد شوید." };
  const res = await createSellerOffer(identity.seller.id, identity.userId, {
    partSlug: String(formData.get("partSlug") ?? "").trim(),
    priceIrr: Number(formData.get("priceIrr")),
    stock: Number(formData.get("stock")),
    sellerSku: String(formData.get("sellerSku") ?? "").trim() || undefined,
    shippingDaysMin: Number(formData.get("shippingDaysMin") || 1),
    shippingDaysMax: Number(formData.get("shippingDaysMax") || 3),
    warrantyFa: String(formData.get("warrantyFa") ?? "").trim() || undefined,
  });
  if (!res.ok) {
    const detail = res.reason === "INVALID" && res.errors ? res.errors.join("؛ ") : undefined;
    const fa: Record<string, string> = {
      AUTH_REQUIRED: "دسترسی فروشنده یافت نشد.",
      NOT_ACTIVE: "فروشگاه شما هنوز توسط ادمین تأیید نشده است.",
      PART_NOT_FOUND: "قطعه‌ی هدف یافت نشد یا غیرفعال است.",
      PART_NOT_ELIGIBLE: "فقط قطعات واقعی کاتالوگ قابل فروش هستند (قطعات نمایشی خیر).",
      DUPLICATE_OFFER: "برای این قطعه قبلاً آفر ثبت کرده‌اید.",
      INVALID: "مقادیر ارسالی نامعتبر است.",
    };
    return { ok: false as const, error: detail ?? fa[res.reason] ?? "خطای نامشخص." };
  }
  revalidatePath("/seller/offers");
  revalidatePath("/seller/inventory");
  revalidatePath(`/parts/${String(formData.get("partSlug"))}`);
  return { ok: true as const, offerId: res.offerId };
}

export async function toggleOfferAction(formData: FormData) {
  const identity = await getAuthenticatedSeller();
  if (!identity) return { ok: false as const, error: "دسترسی فروشنده یافت نشد." };
  const active = String(formData.get("active")) === "true";
  const res = await setSellerOfferActive(identity.seller.id, identity.userId, String(formData.get("offerId")), active);
  if (!res.ok) return { ok: false as const, error: ERR_FA[res.reason] ?? "خطای نامشخص." };
  revalidatePath("/seller/offers");
  revalidatePath("/seller/inventory");
  return { ok: true as const };
}

export async function saveProfileAction(formData: FormData) {
  const identity = await getAuthenticatedSeller();
  if (!identity) return { ok: false as const, error: "دسترسی فروشنده یافت نشد." };
  const res = await updateSellerProfile(identity.seller.id, identity.userId, {
    businessName: String(formData.get("businessName") ?? ""),
    ownerName: String(formData.get("ownerName") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    city: String(formData.get("city") ?? ""),
    address: String(formData.get("address") ?? ""),
  });
  if (!res.ok) return { ok: false as const, error: res.errors?.join("؛ ") ?? ERR_FA[res.reason] ?? "خطای نامشخص." };
  revalidatePath("/seller/profile");
  revalidatePath("/seller");
  return { ok: true as const };
}

export async function setOrderStatusAction(formData: FormData) {
  const identity = await getAuthenticatedSeller();
  if (!identity) return { ok: false as const, error: "دسترسی فروشنده یافت نشد." };
  const res = await updateSellerOrderStatus(
    identity.seller.id,
    identity.userId,
    String(formData.get("sellerOrderId")),
    String(formData.get("status")) as WorkflowStatus,
  );
  if (!res.ok) {
    const ERR_ORDER: Record<string, string> = {
      NOT_FOUND: "این سفارش متعلق به فروشگاه شما نیست یا یافت نشد.",
      INVALID_TRANSITION: "وضعیت سفارش قابل تغییر نیست.",
      ORDER_NOT_PAID: "سفارش پرداخت‌شده قابل لغو نیست.",
      DB_CONFLICT: "بروزرسانی همزمان؛ دوباره تلاش کنید.",
    };
    return { ok: false as const, error: res.detail ?? ERR_ORDER[res.reason] ?? "خطای نامشخص." };
  }
  revalidatePath("/seller/orders");
  return { ok: true as const };
}
