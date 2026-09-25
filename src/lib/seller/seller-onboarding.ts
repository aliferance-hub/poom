import { prisma } from "@/lib/prisma";
import { logSellerEvent, logSellerEventTx } from "@/lib/seller/seller-audit";
import {
  sellerOfferUpdateSchema,
  zodFaErrors,
} from "@/lib/seller/seller-validation";
import type { SellerOfferUpdateInput } from "@/lib/seller/seller-validation";

/**
 * ─────────────────── P2-G: real seller onboarding + real offers ───────────────────
 * The first non-seed path for a seller to enter the marketplace. Principles:
 * - Onboarding creates a PENDING seller owned by the registering User (userId unique).
 * - Only an admin can move PENDING → ACTIVE (existing P2-E governance, audited).
 * - Real offers can only be created by an ACTIVE seller on a VERIFIED or REVIEW_REQUIRED
 *   real part (sourceRef present). Demo (synthetic) parts stay demo-seller territory —
 *   real sellers never sell synthetic catalog rows.
 * - Offers are seller-owned data on the canonical Part; they never redefine the part.
 */

export type ApplyResult =
  | { ok: true; sellerId: string; sellerStatus: "PENDING" }
  | { ok: false; reason: "AUTH_REQUIRED" | "ALREADY_A_SELLER" | "ROLE_NOT_ALLOWED" | "INVALID"; errors?: string[] };

const businessNameRe = /^[\u0600-\u06FF\w\s\u200c().,،-]{3,80}$/;

/** Step 1: a logged-in (non-seller) user applies to become a real seller. */
export async function applyAsSeller(
  userId: string,
  input: { businessName: string; ownerName?: string; phone?: string; city?: string; address?: string },
): Promise<ApplyResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.status === "SUSPENDED" || user.status === "DISABLED") {
    return { ok: false, reason: "AUTH_REQUIRED" };
  }
  // Governance: an ADMIN must never be able to approve their own seller
  // application — admins are excluded from onboarding entirely.
  if (user.role === "ADMIN") {
    return { ok: false, reason: "ROLE_NOT_ALLOWED" };
  }

  const existing = await prisma.seller.findUnique({ where: { userId } });
  if (existing) {
    return { ok: false, reason: "ALREADY_A_SELLER", errors: ["شما قبلاً فروشنده شده‌اید."] };
  }

  if (!businessNameRe.test(input.businessName.trim())) {
    return { ok: false, reason: "INVALID", errors: ["نام کسب‌وکار نامعتبر است (۳ تا ۸۰ کاراکتر)."] };
  }

  const seller = await prisma.seller.create({
    data: {
      businessName: input.businessName.trim(),
      ownerName: input.ownerName?.trim() || null,
      phone: input.phone?.trim() || null,
      city: input.city?.trim() || null,
      address: input.address?.trim() || null,
      // governance status starts PENDING — admin approval required before selling
      sellerStatus: "PENDING",
      status: "PENDING_REVIEW", // legacy Phase-1 string surfaced to admin UI
      verified: false, // legacy derived flag — verification is sellerVerificationStatus
      isRealSeller: true, // legacy origin flag kept in sync (P2-G.1)
      // P2-G.1: origin is REAL_ONBOARDING, verification is UNVERIFIED — onboarding
      // proves how the seller arrived, NEVER that they are verified.
      sellerOrigin: "REAL_ONBOARDING",
      sellerVerificationStatus: "UNVERIFIED",
      rating: 0,
      userId,
    },
  });
  await logSellerEvent({
    sellerId: seller.id,
    actor: userId,
    event: "seller_onboarding_applied",
    entity: "Seller",
    entityId: seller.id,
    meta: { businessName: seller.businessName },
  });
  return { ok: true, sellerId: seller.id, sellerStatus: "PENDING" };
}

export type CreateOfferResult =
  | { ok: true; offerId: string }
  | {
      ok: false;
      reason:
        | "AUTH_REQUIRED"          // no seller session
        | "NOT_ACTIVE"             // seller not governance-ACTIVE yet
        | "PART_NOT_FOUND"
        | "PART_NOT_ELIGIBLE"      // synthetic/demo parts are not sellable by real sellers
        | "DUPLICATE_OFFER"
        | "INVALID";
      errors?: string[];
    };

/** Step 2 (after admin approval): an ACTIVE real seller publishes an offer on a real part. */
export async function createSellerOffer(
  sellerId: string,
  actor: string,
  input: SellerOfferUpdateInput & { partSlug: string },
): Promise<CreateOfferResult> {
  const seller = await prisma.seller.findUnique({ where: { id: sellerId } });
  if (!seller) return { ok: false, reason: "AUTH_REQUIRED" };
  if (seller.sellerStatus !== "ACTIVE") return { ok: false, reason: "NOT_ACTIVE" };

  const part = await prisma.part.findUnique({
    where: { slug: input.partSlug },
    select: { id: true, slug: true, active: true, sourceRef: true, dataStatus: true },
  });
  if (!part || !part.active) return { ok: false, reason: "PART_NOT_FOUND" };
  // P2-G eligibility: real sellers sell real catalog data only (never synthetic rows)
  if (!part.sourceRef) return { ok: false, reason: "PART_NOT_ELIGIBLE" };
  // P2-G audit fix (M-2): a deprecated part has been withdrawn by admin — new
  // offers must not be publishable on it (withdrawal is a governance decision).
  if (part.dataStatus === "DEPRECATED") return { ok: false, reason: "PART_NOT_ELIGIBLE" };

  // `active` is optional in the shared schema and FORCED true here — a new offer
  // always starts live; deactivation happens only through the owner's toggle.
  const parsed = sellerOfferUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "INVALID", errors: zodFaErrors(parsed.error).split("؛ ") };
  }
  const data = parsed.data;

  try {
    const offer = await prisma.$transaction(async (tx) => {
      // P2-G audit fix (M-1): a duplicate seller_sku would make the CSV inventory
      // import ambiguous (rows match by seller_sku). Reject it explicitly; the
      // unique index Offer(sellerId, sellerSku) is the concurrency-safe backstop.
      if (data.sellerSku) {
        const clash = await tx.offer.findFirst({
          where: { sellerId, sellerSku: data.sellerSku },
          select: { id: true },
        });
        if (clash) return null;
      }
      const row = await tx.offer.create({
        data: {
          sellerId,
          partId: part.id,
          price: data.priceIrr,
          stock: data.stock,
          lowStockThreshold: 3,
          shippingDaysMin: data.shippingDaysMin,
          shippingDaysMax: data.shippingDaysMax,
          shippingDays: data.shippingDaysMin, // legacy field stays in sync
          sellerSku: data.sellerSku ?? null,
          warrantyNote: data.warrantyFa ?? null,
          stockUpdatedAt: new Date(),
          priceUpdatedAt: new Date(),
          active: true, // forced — see note above
        },
      });
      await logSellerEventTx(tx, {
        sellerId,
        actor,
        event: "seller_offer_created",
        entity: "Offer",
        entityId: row.id,
        meta: { partId: part.id, price: row.price, stock: row.stock },
      });
      return row;
    });
    if (!offer) {
      return { ok: false, reason: "DUPLICATE_OFFER", errors: ["این کد کالا (SKU) را قبلاً برای آفر دیگری ثبت کرده‌اید."] };
    }
    return { ok: true, offerId: offer.id };
  } catch (e) {
    // Concurrent create of the same seller_sku loses at the unique index.
    if ((e as { code?: string }).code === "P2002") {
      return { ok: false, reason: "DUPLICATE_OFFER", errors: ["این کد کالا (SKU) را قبلاً برای آفر دیگری ثبت کرده‌اید."] };
    }
    throw e;
  }
}
