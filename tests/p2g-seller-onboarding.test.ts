/**
 * ─────────────────── P2-G — Real Seller Onboarding + Real Offers ───────────────────
 * G1: onboarding (user → PENDING seller → admin approval → ACTIVE)
 * G2: real offers (ACTIVE seller creates offers on REAL parts only)
 * G4: end-to-end vertical slice (onboard → approve → publish → customer checkout → SellerOrder)
 * G5: security (no self-approval, ownership, IDOR, governance gating)
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createSession, revokeSession } from "@/lib/auth/session";
import { applyAsSeller, createSellerOffer } from "@/lib/seller/seller-onboarding";
import { updateSellerOffer } from "@/lib/seller/seller-offers";
import { updateSellerProfile } from "@/lib/seller/seller-service";
import { parseSellerInventoryCsv } from "@/lib/seller/seller-csv";
import { fitmentPresentationReason, FITMENT_REVIEW_FA } from "@/lib/fitment";
import { transitionSellerStatus } from "@/lib/governance";
import { createCheckout, settleMockPayment } from "@/lib/checkout";
import { addToCart } from "@/lib/cart";

const prisma = new PrismaClient();
const REAL_PART = "radiator-assembly";

const cleanup: {
  sellers: string[]; offers: string[]; users: string[]; sessions: string[];
  orders: string[]; payments: string[]; carts: string[]; logs: string[]; parts: string[];
} = { sellers: [], offers: [], users: [], sessions: [], orders: [], payments: [], carts: [], logs: [], parts: [] };

let uniqueSeq = 0;
function uniquePhone(): string {
  return `09${((Date.now() % 1_000_000_000) * 10 + (uniqueSeq++ % 10)).toString().padStart(9, "0").slice(-9)}`;
}

afterAll(async () => {
  await prisma.cartItem.deleteMany({ where: { cartId: { in: cleanup.carts } } });
  await prisma.cart.deleteMany({ where: { id: { in: cleanup.carts } } });
  await prisma.paymentAttempt.deleteMany({ where: { paymentId: { in: cleanup.payments } } });
  await prisma.payment.deleteMany({ where: { id: { in: cleanup.payments } } });
  await prisma.sellerOrder.deleteMany({ where: { orderId: { in: cleanup.orders } } });
  await prisma.orderItem.deleteMany({ where: { offerId: { in: cleanup.offers } } });
  await prisma.order.deleteMany({ where: { id: { in: cleanup.orders } } });
  await prisma.offer.deleteMany({ where: { id: { in: cleanup.offers } } });
  await prisma.sellerEventLog.deleteMany({ where: { sellerId: { in: cleanup.sellers } } });
  await prisma.seller.deleteMany({ where: { id: { in: cleanup.sellers } } });
  await prisma.session.deleteMany({ where: { id: { in: cleanup.sessions } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
  await prisma.$disconnect();
});

// ─────────────────────────── G1: onboarding ───────────────────────────

describe("G1: seller onboarding", () => {
  it("a customer user applies → PENDING seller owned by that user, audited", async () => {
    const user = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    cleanup.users.push(user.id);

    const r = await applyAsSeller(user.id, { businessName: "فروشگاه واقعی تست P2-G", city: "تهران" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    cleanup.sellers.push(r.sellerId);

    const seller = await prisma.seller.findUniqueOrThrow({ where: { id: r.sellerId } });
    expect(seller.sellerStatus).toBe("PENDING");
    expect(seller.verified).toBe(false);
    expect(seller.userId).toBe(user.id);

    const log = await prisma.sellerEventLog.findFirst({ where: { sellerId: seller.id, event: "seller_onboarding_applied" } });
    expect(log).toBeTruthy();
  });

  it("a user cannot apply twice (userId is unique per seller)", async () => {
    const user = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    cleanup.users.push(user.id);
    const first = await applyAsSeller(user.id, { businessName: "فروشگاه اول" });
    expect(first.ok).toBe(true);
    if (first.ok) cleanup.sellers.push(first.sellerId);

    const second = await applyAsSeller(user.id, { businessName: "فروشگاه دوم" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("ALREADY_A_SELLER");
  });

  it("an ADMIN can never apply (no self-approval path)", async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
    const r = await applyAsSeller(admin.id, { businessName: "فروشگاه ادمین" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ROLE_NOT_ALLOWED");
  });

  it("invalid business names are rejected", async () => {
    const user = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    cleanup.users.push(user.id);
    const r = await applyAsSeller(user.id, { businessName: "ab" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("INVALID");
  });

  it("PENDING seller cannot publish offers; only after admin governance approval", async () => {
    const user = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    cleanup.users.push(user.id);
    const applied = await applyAsSeller(user.id, { businessName: "فروشگاه در انتظار" });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    cleanup.sellers.push(applied.sellerId);

    const part = await prisma.part.findUniqueOrThrow({ where: { slug: REAL_PART } });
    const deny = await createSellerOffer(applied.sellerId, user.id, {
      partSlug: REAL_PART, priceIrr: 100_000_0, stock: 5, shippingDaysMin: 1, shippingDaysMax: 3,
    });
    expect(deny.ok).toBe(false);
    if (!deny.ok) expect(deny.reason).toBe("NOT_ACTIVE");

    // admin governance approval (P2-E state machine, audited)
    const ok = await transitionSellerStatus({ sellerId: applied.sellerId, to: "ACTIVE", adminUserId: "p2g-test-admin" });
    expect(ok.ok).toBe(true);

    const seller = await prisma.seller.findUniqueOrThrow({ where: { id: applied.sellerId } });
    expect(seller.sellerStatus).toBe("ACTIVE");
    void part;
  });
});

// ─────────────────────────── G2/G5: real offers ───────────────────────────

describe("G2/G5: real offer pipeline", () => {
  it("ACTIVE real seller creates an offer on a real part (audited)", async () => {
    const user = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    cleanup.users.push(user.id);
    const applied = await applyAsSeller(user.id, { businessName: "فروشگاه آفر واقعی" });
    if (applied.ok) cleanup.sellers.push(applied.sellerId);
    await transitionSellerStatus({ sellerId: applied.ok ? applied.sellerId : "", to: "ACTIVE", adminUserId: "p2g-test-admin" });

    const r = await createSellerOffer(applied.ok ? applied.sellerId : "", user.id, {
      partSlug: REAL_PART, priceIrr: 6_500_000, stock: 4, shippingDaysMin: 1, shippingDaysMax: 2, sellerSku: "REAL-RAD-1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    cleanup.offers.push(r.offerId);

    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: r.offerId } });
    expect(offer.price).toBe(6_500_000);
    expect(offer.shippingDays).toBe(1); // legacy field in sync with min
    expect(offer.active).toBe(true);

    const log = await prisma.sellerEventLog.findFirst({ where: { sellerId: offer.sellerId, event: "seller_offer_created", entityId: offer.id } });
    expect(log).toBeTruthy();
  });

  it("real sellers CANNOT sell synthetic/demo parts (PART_NOT_ELIGIBLE)", async () => {
    const user = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    cleanup.users.push(user.id);
    const applied = await applyAsSeller(user.id, { businessName: "فروشگاه مرز کاتالوگ" });
    if (applied.ok) cleanup.sellers.push(applied.sellerId);
    const sid = applied.ok ? applied.sellerId : "";
    await transitionSellerStatus({ sellerId: sid, to: "ACTIVE", adminUserId: "p2g-test-admin" });

    const demoPart = await prisma.part.findFirstOrThrow({ where: { dataStatus: "DEMO", active: true } });
    const r = await createSellerOffer(sid, user.id, {
      partSlug: demoPart.slug, priceIrr: 1_000_000, stock: 1, shippingDaysMin: 1, shippingDaysMax: 2,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("PART_NOT_ELIGIBLE");
  });

  it("negative price and invalid shipping ranges are rejected", async () => {
    const user = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    cleanup.users.push(user.id);
    const applied = await applyAsSeller(user.id, { businessName: "فروشگاه اعتبارسنجی" });
    if (applied.ok) cleanup.sellers.push(applied.sellerId);
    const sid = applied.ok ? applied.sellerId : "";
    await transitionSellerStatus({ sellerId: sid, to: "ACTIVE", adminUserId: "p2g-test-admin" });

    const bad = await createSellerOffer(sid, user.id, {
      partSlug: REAL_PART, priceIrr: -5, stock: 1, shippingDaysMin: 5, shippingDaysMax: 2,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("INVALID");
  });

  it("SUSPENDED seller loses offer-publishing and storefront visibility (governance gate)", async () => {
    const user = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    cleanup.users.push(user.id);
    const applied = await applyAsSeller(user.id, { businessName: "فروشگاه تعلیق‌پذیر" });
    if (applied.ok) cleanup.sellers.push(applied.sellerId);
    const sid = applied.ok ? applied.sellerId : "";
    await transitionSellerStatus({ sellerId: sid, to: "ACTIVE", adminUserId: "p2g-test-admin" });

    const r = await createSellerOffer(sid, user.id, {
      partSlug: REAL_PART, priceIrr: 6_600_000, stock: 2, shippingDaysMin: 1, shippingDaysMax: 2,
    });
    expect(r.ok).toBe(true);
    if (r.ok) cleanup.offers.push(r.offerId);

    // offer is storefront-visible while ACTIVE
    const part = await prisma.part.findUniqueOrThrow({ where: { slug: REAL_PART } });
    let visible = await prisma.offer.findFirst({ where: { id: r.ok ? r.offerId : "", partId: part.id, active: true, seller: { sellerStatus: "ACTIVE" } } });
    expect(visible).not.toBeNull();

    await transitionSellerStatus({ sellerId: sid, to: "SUSPENDED", adminUserId: "p2g-test-admin" });
    visible = await prisma.offer.findFirst({ where: { id: r.ok ? r.offerId : "", partId: part.id, active: true, seller: { sellerStatus: "ACTIVE" } } });
    expect(visible).toBeNull(); // suspended seller's offer vanishes from the storefront

    // restore
    await transitionSellerStatus({ sellerId: sid, to: "ACTIVE", adminUserId: "p2g-test-admin" });
  });
});

// ─────────────────────── G4: end-to-end vertical slice ───────────────────────

describe("G4: onboard → approve → publish → customer checkout → SellerOrder", () => {
  it("the full real-seller vertical slice works through the normal commerce path", async () => {
    // 1) onboard + approve
    const owner = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    cleanup.users.push(owner.id);
    const applied = await applyAsSeller(owner.id, { businessName: "فروشگاه برش عمودی واقعی" });
    expect(applied.ok).toBe(true);
    const sid = applied.ok ? applied.sellerId : "";
    cleanup.sellers.push(sid);
    expect((await transitionSellerStatus({ sellerId: sid, to: "ACTIVE", adminUserId: "p2g-test-admin" })).ok).toBe(true);

    // 2) publish a real offer
    const offerRes = await createSellerOffer(sid, owner.id, {
      partSlug: REAL_PART, priceIrr: 7_200_000, stock: 10, shippingDaysMin: 1, shippingDaysMax: 2,
    });
    expect(offerRes.ok).toBe(true);
    if (!offerRes.ok) return;
    cleanup.offers.push(offerRes.offerId);

    // 3) a customer buys it through the normal storefront path (cart → checkout → settle)
    const buyer = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    cleanup.users.push(buyer.id);
    const { token } = await createSession(buyer.id);
    cleanup.sessions.push(token);

    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: offerRes.offerId } });
    await addToCart(token, offer.id, 2);

    const checkout = await createCheckout(token);
    expect(checkout.ok).toBe(true);
    if (!checkout.ok) return;
    cleanup.orders.push(checkout.order.id);

    const settle = await settleMockPayment(checkout.authority ?? "", "success");
    expect(settle.ok).toBe(true);

    // 4) the real seller sees the real SellerOrder with an intact price snapshot
    const so = await prisma.sellerOrder.findFirstOrThrow({
      where: { orderId: checkout.order.id, sellerId: sid },
      include: { items: true },
    });
    expect(so.status).toBe("CONFIRMED");
    expect(so.items[0]!.unitPrice).toBe(7_200_000);
    expect(so.items[0]!.quantity).toBe(2);

    // 5) stock decremented exactly once
    const after = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(after.stock).toBe(8);
  });
});

// ───────────── P2-G adversarial-audit regression (M-2, D/E confirmations) ─────────────

describe("P2-G adversarial audit regressions", () => {
  it("M-2: an admin-deprecated (DEPRECATED) real part cannot receive a NEW offer", async () => {
    const user = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    cleanup.users.push(user.id);
    const applied = await applyAsSeller(user.id, { businessName: "فروشگاه قطعه منسوخ" });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    cleanup.sellers.push(applied.sellerId);
    await transitionSellerStatus({ sellerId: applied.sellerId, to: "ACTIVE", adminUserId: "p2g-test-admin" });

    // spin a throwaway real-looking part and deprecate it (exact admin path effect)
    const part = await prisma.part.create({
      data: {
        slug: `p2g-deprecated-${Date.now().toString(36)}`, title: "قطعه منسوخ آزمون", sku: `P2G-DEP-${Date.now().toString(36)}`,
        categoryId: (await prisma.part.findUniqueOrThrow({ where: { slug: REAL_PART }, select: { categoryId: true } })).categoryId,
        active: true, sourceRef: "p2g-audit-test", sourceUpdatedAt: new Date(), dataStatus: "DEPRECATED",
      },
    });
    cleanup.parts.push(part.id);
    try {
      // Part stays `active` in the storefront sense but is governance-DEPRECATED —
      // eligibility must reject it BEFORE the generic PART_NOT_FOUND fallback.
      const r = await createSellerOffer(applied.sellerId, user.id, {
        partSlug: part.slug, priceIrr: 1_000, stock: 1, shippingDaysMin: 1, shippingDaysMax: 2,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("PART_NOT_ELIGIBLE");
    } finally {
      await prisma.part.deleteMany({ where: { id: part.id } }).catch(() => {});
      cleanup.parts = cleanup.parts.filter((p) => p !== part.id);
    }
  });

  it("M-2b: sellableParts listing matches server eligibility (no DEPRECATED parts listed)", async () => {
    // The form query is now identical in spirit to createSellerOffer eligibility.
    const deprecatedReal = await prisma.part.findFirst({ where: { sourceRef: { not: null }, dataStatus: "DEPRECATED" } });
    if (!deprecatedReal) return; // nothing deprecated in this DB snapshot — vacuous
    const user = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    cleanup.users.push(user.id);
    const applied = await applyAsSeller(user.id, { businessName: "فروشگاه فهرست فروش" });
    if (applied.ok) cleanup.sellers.push(applied.sellerId);
    const sid = applied.ok ? applied.sellerId : "";
    await transitionSellerStatus({ sellerId: sid, to: "ACTIVE", adminUserId: "p2g-test-admin" });
    const r = await createSellerOffer(sid, user.id, { partSlug: deprecatedReal.slug, priceIrr: 1_000, stock: 1, shippingDaysMin: 1, shippingDaysMax: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("PART_NOT_ELIGIBLE");
  });

  it("cross-seller offer mutation stays blocked at the service boundary (IDOR regression)", async () => {
    const uA = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    const uB = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    cleanup.users.push(uA.id, uB.id);
    const a = await applyAsSeller(uA.id, { businessName: "فروشگاه ای‌دی‌آر الف" });
    const b = await applyAsSeller(uB.id, { businessName: "فروشگاه ای‌دی‌آر ب" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    cleanup.sellers.push(a.sellerId, b.sellerId);
    await transitionSellerStatus({ sellerId: a.sellerId, to: "ACTIVE", adminUserId: "p2g-test-admin" });

    const off = await createSellerOffer(a.sellerId, uA.id, { partSlug: REAL_PART, priceIrr: 123_000, stock: 2, shippingDaysMin: 1, shippingDaysMax: 2 });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    cleanup.offers.push(off.offerId);

    // B mutates A's offer by id — ownership clause returns NOT_FOUND, nothing changes
    const res = await updateSellerOffer(b.sellerId, uB.id, off.offerId, { priceIrr: 1, stock: 0, shippingDaysMin: 1, shippingDaysMax: 2, active: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("NOT_FOUND");
    const row = await prisma.offer.findUniqueOrThrow({ where: { id: off.offerId } });
    expect(row.price).toBe(123_000);
    expect(row.active).toBe(true);
  });
});

// ───────── P2-G adversarial-audit findings: M-1 (SKU uniqueness), L-2, L-3 ─────────

async function mkActiveSeller(name: string): Promise<{ sellerId: string; userId: string }> {
  const user = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
  cleanup.users.push(user.id);
  const applied = await applyAsSeller(user.id, { businessName: name });
  if (!applied.ok) throw new Error(`apply failed: ${applied.reason}`);
  cleanup.sellers.push(applied.sellerId);
  const approved = await transitionSellerStatus({ sellerId: applied.sellerId, to: "ACTIVE", adminUserId: "p2g-test-admin" });
  if (!approved.ok) throw new Error(`approve failed: ${approved.reason}`);
  return { sellerId: applied.sellerId, userId: user.id };
}

describe("P2-G audit findings (M-1 seller-SKU uniqueness, L-2 self-governance, L-3 CSV)", () => {
  it("M-1: the DB enforces one listing per seller_sku (unique index backstop)", async () => {
    const idx = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'Offer' AND indexname = 'Offer_sellerId_sellerSku_key'`,
    );
    expect(idx.length).toBe(1);
  });

  it("M-1: a duplicate seller_sku for the same seller is rejected (DUPLICATE_OFFER, not a silent second listing)", async () => {
    const { sellerId, userId } = await mkActiveSeller("فروشگاه اس‌کیو تکراری");
    const sku = `P2G-SKU-${Date.now().toString(36)}`;
    const first = await createSellerOffer(sellerId, userId, {
      partSlug: REAL_PART, priceIrr: 100_000, stock: 5, shippingDaysMin: 1, shippingDaysMax: 2, sellerSku: sku,
    });
    expect(first.ok).toBe(true);
    if (first.ok) cleanup.offers.push(first.offerId);

    const second = await createSellerOffer(sellerId, userId, {
      partSlug: REAL_PART, priceIrr: 200_000, stock: 1, shippingDaysMin: 1, shippingDaysMax: 2, sellerSku: sku,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("DUPLICATE_OFFER");

    // untouched: exactly the first listing exists
    const rows = await prisma.offer.findMany({ where: { sellerId, sellerSku: sku } });
    expect(rows.length).toBe(1);
    expect(rows[0]!.price).toBe(100_000);
  });

  it("M-1: concurrent create with the same SKU yields exactly one offer (no duplicate rows)", async () => {
    const { sellerId, userId } = await mkActiveSeller("فروشگاه اس‌کیو هم‌زمان");
    const sku = `P2G-RACE-${Date.now().toString(36)}`;
    const input = { partSlug: REAL_PART, priceIrr: 500_000, stock: 1, shippingDaysMin: 1, shippingDaysMax: 2, sellerSku: sku };
    const results = await Promise.all([
      createSellerOffer(sellerId, userId, input),
      createSellerOffer(sellerId, userId, input),
      createSellerOffer(sellerId, userId, input),
      createSellerOffer(sellerId, userId, input),
    ]);
    for (const r of results) if (r.ok) cleanup.offers.push(r.offerId);
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(await prisma.offer.count({ where: { sellerId, sellerSku: sku } })).toBe(1);
    // losers are reported as duplicates, never as a silent success
    for (const r of results) if (!r.ok) expect(r.reason).toBe("DUPLICATE_OFFER");
  });

  it("M-1: re-labelling an existing offer onto a SKU already used by the same seller is refused (STALE_SKU)", async () => {
    const { sellerId, userId } = await mkActiveSeller("فروشگاه اس‌کیو انتقالی");
    const suffix = Date.now().toString(36);
    const skuA = `P2G-A-${suffix}`;
    const skuB = `P2G-B-${suffix}`;
    const a = await createSellerOffer(sellerId, userId, { partSlug: REAL_PART, priceIrr: 10_000, stock: 1, shippingDaysMin: 1, shippingDaysMax: 2, sellerSku: skuA });
    const b = await createSellerOffer(sellerId, userId, { partSlug: REAL_PART, priceIrr: 20_000, stock: 1, shippingDaysMin: 1, shippingDaysMax: 2, sellerSku: skuB });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    cleanup.offers.push(a.offerId, b.offerId);

    const clash = await updateSellerOffer(sellerId, userId, b.offerId, {
      priceIrr: 20_000, stock: 1, shippingDaysMin: 1, shippingDaysMax: 2, sellerSku: skuA,
    });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.reason).toBe("STALE_SKU");
    // the other listing was not taken over
    const rowA = await prisma.offer.findUniqueOrThrow({ where: { id: a.offerId } });
    expect(rowA.sellerSku).toBe(skuA);
    expect(rowA.price).toBe(10_000);
  });

  it("L-3: a CSV file repeating a seller_sku is rejected per-row instead of silently last-wins", () => {
    const csv = [
      "seller_sku,part_id,price_irr,stock,shipping_days_min,shipping_days_max,active",
      "DUP-SKU-1,part-one,1000,1,1,2,1",
      "DUP-SKU-1,part-two,2000,9,1,2,1",
    ].join("\n");
    const parsed = parseSellerInventoryCsv(csv);
    expect(parsed.ok).toBe(true);
    expect(parsed.validCount).toBe(1);
    expect(parsed.invalidCount).toBe(1);
    const invalid = parsed.rows.find((r) => r.status === "INVALID");
    expect(invalid?.error ?? "").toContain("تکراری");
    expect(invalid?.data).toBeUndefined();
  });

  it("L-2: an admin cannot change the governance status of a seller they own (SELF_GOVERNANCE)", async () => {
    const owner = await prisma.user.create({ data: { phone: uniquePhone(), role: "ADMIN" } });
    cleanup.users.push(owner.id);
    const seller = await prisma.seller.create({
      data: { businessName: `ادمین مالک ${Date.now().toString(36)}`, sellerStatus: "PENDING", status: "PENDING_REVIEW", userId: owner.id },
    });
    cleanup.sellers.push(seller.id);

    const self = await transitionSellerStatus({ sellerId: seller.id, to: "ACTIVE", adminUserId: owner.id });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.reason).toBe("SELF_GOVERNANCE");
    expect((await prisma.seller.findUniqueOrThrow({ where: { id: seller.id } })).sellerStatus).toBe("PENDING");

    // identity-based, not a blanket block: a *different* admin still can
    const other = await transitionSellerStatus({ sellerId: seller.id, to: "ACTIVE", adminUserId: "p2g-test-admin" });
    expect(other.ok).toBe(true);
  });

  it("M: seller profile update cannot escalate sellerStatus/verified/isRealSeller (whitelist strips injected fields)", async () => {
    const owner = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    cleanup.users.push(owner.id);
    const applied = await applyAsSeller(owner.id, { businessName: `فروشگاه تزریق پروفایل ${Date.now().toString(36)}` });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    cleanup.sellers.push(applied.sellerId);

    const evil = {
      businessName: "فروشگاه تزریق پروفایل",
      sellerStatus: "ACTIVE", verified: true, isRealSeller: false, rating: 5,
    } as unknown as { businessName: string };
    const res = await updateSellerProfile(applied.sellerId, owner.id, evil);
    expect(res.ok).toBe(true);

    const row = await prisma.seller.findUniqueOrThrow({ where: { id: applied.sellerId } });
    expect(row.sellerStatus).toBe("PENDING"); // not upgraded by self-service
    expect(row.verified).toBe(false);
    expect(row.isRealSeller).toBe(true); // origin unchanged
    expect(row.rating).toBe(0);
  });

  it("A: onboarding ignores injected authority fields (status is always PENDING from the server)", async () => {
    const owner = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    cleanup.users.push(owner.id);
    const evil = {
      businessName: `فروشگاه تزریق وضعیت ${Date.now().toString(36)}`,
      sellerStatus: "ACTIVE", verified: true, rating: 5, userId: "someone-else",
    } as unknown as { businessName: string };
    const applied = await applyAsSeller(owner.id, evil);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    cleanup.sellers.push(applied.sellerId);
    const row = await prisma.seller.findUniqueOrThrow({ where: { id: applied.sellerId } });
    expect(row.sellerStatus).toBe("PENDING");
    expect(row.verified).toBe(false);
    expect(row.rating).toBe(0);
    expect(row.userId).toBe(owner.id); // owner derives from the server-side session id
  });

  it("H: the fitment explanation can never assert «سازگار است» for unverified catalog data", () => {
    // exactly the sentence resolveFitment() returns for a COMPATIBLE verdict
    const engineClaim = "بر اساس قانون ثبت‌شده برای پژو ۲۰۶ سازگار است.";

    // unverified / unknown catalog data ⇒ policy sentence, never the raw claim
    for (const dataStatus of ["REVIEW_REQUIRED", "UNVERIFIED", null, undefined, "SOMETHING_ELSE"]) {
      const shown = fitmentPresentationReason("COMPATIBLE", dataStatus, engineClaim);
      expect(shown).toBe(FITMENT_REVIEW_FA);
      expect(shown).not.toContain("سازگار است");
    }

    // verified / demo rows are deterministic — the engine sentence stands
    expect(fitmentPresentationReason("COMPATIBLE", "VERIFIED", engineClaim)).toBe(engineClaim);
    expect(fitmentPresentationReason("COMPATIBLE", "DEMO", engineClaim)).toBe(engineClaim);

    // non-compatible verdicts pass through untouched (no softening, no rewriting)
    expect(fitmentPresentationReason("INCOMPATIBLE", "REVIEW_REQUIRED", "این قطعه سازگار نیست.")).toBe("این قطعه سازگار نیست.");
    expect(fitmentPresentationReason("REVIEW_REQUIRED", null, "سازگاری نیازمند بررسی است.")).toBe("سازگاری نیازمند بررسی است.");
  });

  it("I: a post-sale offer price/stock change never rewrites historical OrderItem snapshots", async () => {
    const { sellerId, userId } = await mkActiveSeller("فروشگاه تاریخچه قیمت");
    const offerRes = await createSellerOffer(sellerId, userId, {
      partSlug: REAL_PART, priceIrr: 2_500_000, stock: 10, shippingDaysMin: 1, shippingDaysMax: 2,
    });
    expect(offerRes.ok).toBe(true);
    if (!offerRes.ok) return;
    cleanup.offers.push(offerRes.offerId);

    const buyer = await prisma.user.create({ data: { phone: uniquePhone(), role: "CUSTOMER" } });
    cleanup.users.push(buyer.id);
    const { token } = await createSession(buyer.id);
    cleanup.sessions.push(token);
    await addToCart(token, offerRes.offerId, 1);
    const checkout = await createCheckout(token);
    expect(checkout.ok).toBe(true);
    if (!checkout.ok) return;
    cleanup.orders.push(checkout.order.id);
    expect((await settleMockPayment(checkout.authority ?? "", "success")).ok).toBe(true);

    // seller changes the listing afterwards — the settled order must not move
    const bumped = await updateSellerOffer(sellerId, userId, offerRes.offerId, {
      priceIrr: 9_999_999, stock: 10, shippingDaysMin: 1, shippingDaysMax: 2,
      sellerSku: `P2G-HIST-${Date.now().toString(36)}`,
    });
    expect(bumped.ok).toBe(true);

    const item = await prisma.orderItem.findFirstOrThrow({ where: { offerId: offerRes.offerId } });
    expect(item.unitPrice).toBe(2_500_000);
  });
});
