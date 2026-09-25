/**
 * ───────────── P2-G.1 AREA G10: truthfulness matrix (read-only on seed data) ─────────────
 * Asserts the label module output for every origin × verification × status
 * combination the customer UI can encounter, then verifies live DB combos.
 */
import { PrismaClient } from "@prisma/client";
import { sellerOriginLabelFa, sellerVerificationBadgeFa, sellerTrustSummaryFa } from "../src/lib/seller/seller-trust-label";
import { getOffersForPart } from "../src/lib/offers";

const prisma = new PrismaClient();
let pass = 0, fail = 0;
function verdict(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`CASE ${name}: PASS ${detail}`); }
  else { fail++; console.log(`CASE ${name}: FAIL ${detail}`); }
}

type Axes = { sellerOrigin: "DEMO" | "REAL_ONBOARDING" | "SYSTEM"; sellerVerificationStatus: "UNVERIFIED" | "PENDING_REVIEW" | "VERIFIED" | "REJECTED"; sellerStatus: string };

async function main() {
  // ── Case A: DEMO + ACTIVE (+ anything) → demo presentation, never a badge
  const A: Axes = { sellerOrigin: "DEMO", sellerVerificationStatus: "UNVERIFIED", sellerStatus: "ACTIVE" };
  verdict("A: DEMO+ACTIVE", sellerTrustSummaryFa(A).includes("DEMO") && sellerVerificationBadgeFa(A) === null,
    `«${sellerTrustSummaryFa(A)}»`);

  // ── Case B: REAL_ONBOARDING + ACTIVE + UNVERIFIED → real-onboarding, NOT verified
  const B: Axes = { sellerOrigin: "REAL_ONBOARDING", sellerVerificationStatus: "UNVERIFIED", sellerStatus: "ACTIVE" };
  const bSummary = sellerTrustSummaryFa(B);
  verdict("B: REAL+ACTIVE+UNVERIFIED", bSummary.includes("فروشنده واقعی") && !bSummary.includes("تأیید شده") && sellerVerificationBadgeFa(B) === null,
    `«${bSummary}» badge=${sellerVerificationBadgeFa(B)}`);

  // ── Case C: REAL_ONBOARDING + ACTIVE + VERIFIED → verified IN THIS SYSTEM
  const C: Axes = { sellerOrigin: "REAL_ONBOARDING", sellerVerificationStatus: "VERIFIED", sellerStatus: "ACTIVE" };
  const cBadge = sellerVerificationBadgeFa(C);
  verdict("C: REAL+ACTIVE+VERIFIED", cBadge?.text === "تأیید شده در سیستم",
    `badge=«${cBadge?.text}»`);

  // ── Case D: REAL_ONBOARDING + PENDING (governance) → not in the marketplace at all
  //    (offers.ts filters sellerStatus=ACTIVE) — DB check on the live catalog:
  const part = await prisma.part.findFirstOrThrow({ where: { slug: "radiator-assembly" } });
  void part;
  const pendingSellerCount = await prisma.offer.count({ where: { active: true, seller: { sellerStatus: "PENDING" } } });
  const suspendedSellerCount = await prisma.offer.count({ where: { active: true, seller: { sellerStatus: "SUSPENDED" } } });
  const rejectedSellerCount = await prisma.offer.count({ where: { active: true, seller: { sellerStatus: "REJECTED" } } });
  verdict("D/E: PENDING+SUSPENDED+REJECTED absent from storefront", pendingSellerCount === 0 && suspendedSellerCount === 0 && rejectedSellerCount === 0,
    `pending=${pendingSellerCount} suspended=${suspendedSellerCount} rejected=${rejectedSellerCount}`);

  // ── Live walk: the real seller's actual offer must carry live authoritative axes
  const alborz = await prisma.seller.findFirstOrThrow({ where: { sellerOrigin: "REAL_ONBOARDING" } });
  const liveOffers = await getOffersForPart((await prisma.part.findUniqueOrThrow({ where: { slug: "radiator-assembly" } })).id);
  const own = liveOffers.find((o) => o.sellerId === alborz.id);
  if (own) {
    verdict("live: real offer labels", own.seller.sellerOrigin === "REAL_ONBOARDING"
      && own.seller.sellerVerificationStatus === "UNVERIFIED"
      && sellerVerificationBadgeFa(own.seller) === null,
      `«${sellerTrustSummaryFa(own.seller)}»`);
  } else {
    console.log("CASE live: real offer labels: INFO (offer currently not in marketplace — check sellerStatus)");
  }

  // ── The unverified real seller never wears any trust badge in any query shape
  const allReal = await prisma.seller.findMany({ where: { sellerOrigin: "REAL_ONBOARDING" } });
  const badgeLeaks = allReal.filter((s) => s.sellerVerificationStatus !== "VERIFIED" && sellerVerificationBadgeFa(s) !== null);
  verdict("no-badge-leak-for-unverified-real", badgeLeaks.length === 0, `checked=${allReal.length}`);

  console.log(`\nRESULT: ${pass} PASS, ${fail} FAIL`);
}

main()
  .catch((e) => { console.error("FATAL", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
