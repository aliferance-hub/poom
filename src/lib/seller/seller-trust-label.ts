/**
 * ─────────────────── P2-G.1: seller trust labels (customer-facing) ───────────────────
 * Every customer surface derives its seller wording HERE, from the authoritative
 * DB state. The UI never claims more trust than the data proves:
 *   - origin (DEMO / REAL_ONBOARDING) and verification (UNVERIFIED…REJECTED)
 *     are independent axes and are labeled independently;
 *   - a REAL_ONBOARDING + UNVERIFIED seller never gets a trust badge —
 *     «فروشنده واقعی» is a neutral provenance fact, not a trust claim;
 *   - VERIFIED always names its scope: «تأیید شده در سیستم» (verified in this
 *     system), never «کسب‌وکار قانونی» or similar overclaims;
 *   - suspended/rejected sellers do not appear in the customer marketplace
 *     (offers.ts filters sellerStatus=ACTIVE), so no customer label is needed.
 */

import type { SellerOrigin, SellerVerificationStatus } from "@prisma/client";

export type SellerTrustState = {
  sellerOrigin: SellerOrigin;
  sellerVerificationStatus: SellerVerificationStatus;
};

/**
 * Neutral provenance label — how the seller entered the system.
 * NOT a trust claim: verification wording comes only from
 * sellerVerificationBadgeFa().
 */
export function sellerOriginLabelFa(s: SellerTrustState): string {
  switch (s.sellerOrigin) {
    case "DEMO":
      return "فروشنده نمایشی · داده‌ها DEMO هستند";
    case "REAL_ONBOARDING":
      return "فروشنده واقعی (ثبت‌نام از طریق پلتفرم)";
    case "SYSTEM":
      // Audit sentinel: not a real seller; should never reach a customer surface.
      return "فروشنده سیستمی";
  }
}

/**
 * The ONLY verification badge wording customers can ever see.
 * Returns null unless the seller is REAL_ONBOARDING + VERIFIED — so an
 * unverified real seller (or any demo seller) can never wear a trust badge.
 */
export function sellerVerificationBadgeFa(
  s: SellerTrustState,
): { text: string; className: string } | null {
  if (s.sellerOrigin === "DEMO") return null;
  if (s.sellerVerificationStatus !== "VERIFIED") return null;
  return { text: "تأیید شده در سیستم", className: "bg-blue-50 text-blue-700" };
}

/**
 * Compact two-line summary for surfaces with tight space (cart, checkout).
 * Both axes, explicitly separated.
 */
export function sellerTrustSummaryFa(s: SellerTrustState): string {
  const origin = sellerOriginLabelFa(s);
  return s.sellerVerificationStatus === "VERIFIED" && s.sellerOrigin === "REAL_ONBOARDING"
    ? `${origin} · ${sellerVerificationBadgeFa(s)!.text}`
    : origin;
}
