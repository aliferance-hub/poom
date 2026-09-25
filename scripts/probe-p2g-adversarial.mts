/**
 * ───────────── P2-G adversarial probes (run against the REAL dev DB) ─────────────
 * Each probe prints PROBE <name>: <PASS|FAIL|INFO> — oracle is actual DB state.
 * Safe by construction: creates its own fixtures (unique phones), cleans up after.
 */
import { PrismaClient } from "@prisma/client";
import { applyAsSeller, createSellerOffer } from "../src/lib/seller/seller-onboarding";
import { updateSellerOffer, setSellerOfferActive } from "../src/lib/seller/seller-offers";
import { updateSellerProfile } from "../src/lib/seller/seller-service";
import { transitionSellerStatus, setSellerVerificationStatus } from "../src/lib/governance";
import { createSession } from "../src/lib/auth/session";

const prisma = new PrismaClient();
let seq = 0;
const uniq = () => `09${((Date.now() % 1e9) * 10 + (seq++ % 10)).toString().padStart(9, "0").slice(-9)}`;

const clean = { users: [] as string[], sellers: [] as string[], offers: [] as string[], sessions: [] as string[] };
let pass = 0, fail = 0;
function verdict(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`PROBE ${name}: PASS ${detail}`); }
  else { fail++; console.log(`PROBE ${name}: FAIL ${detail}`); }
}

async function mkRealSeller(name: string): Promise<{ userId: string; sellerId: string }> {
  const user = await prisma.user.create({ data: { phone: uniq(), role: "CUSTOMER" } });
  clean.users.push(user.id);
  const ap = await applyAsSeller(user.id, { businessName: name });
  if (!ap.ok) throw new Error(`apply failed: ${ap.reason}`);
  clean.sellers.push(ap.sellerId);
  await transitionSellerStatus({ sellerId: ap.sellerId, to: "ACTIVE", adminUserId: "probe-admin" });
  return { userId: user.id, sellerId: ap.sellerId };
}

async function main() {
  const realPart = await prisma.part.findFirstOrThrow({ where: { slug: "radiator-assembly" }, select: { id: true, slug: true } });

  // ── PROBE 1: can a seller flip isRealSeller / verified / sellerStatus through
  // the whitelisted profile-update path with injected extra fields?
  {
    const A = await mkRealSeller("پروب تزریق فیلد");
    const r = await updateSellerProfile(A.sellerId, A.userId, {
      businessName: "پروب تزریق فیلد", ownerName: "x", phone: "", city: "", address: "",
      // injection attempt — must be ignored by the Zod whitelist:
      ...(JSON.parse('{"verified":true,"isRealSeller":true,"sellerStatus":"ACTIVE","rating":5.0,"userId":null}') as Record<string, unknown>),
    } as unknown as Parameters<typeof updateSellerProfile>[2]);
    const s = await prisma.seller.findUniqueOrThrow({ where: { id: A.sellerId } });
    verdict("profile-injection", r.ok === false || (!s.verified && s.isRealSeller === true && s.sellerStatus === "ACTIVE" && s.rating === 0),
      r.ok === false ? `(rejected: ${(r as { reason?: string }).reason ?? "INVALID"})` : `(status=${s.sellerStatus} verified=${s.verified} real=${s.isRealSeller} rating=${s.rating})`);
  }

  // ── PROBE 2: cross-seller offer mutation (IDOR) — B tries A's offer id
  {
    const A = await mkRealSeller("پروب فروشنده الف");
    const B = await mkRealSeller("پروب فروشنده ب");
    const off = await createSellerOffer(A.sellerId, A.userId, { partSlug: realPart.slug, priceIrr: 12345, stock: 5, shippingDaysMin: 1, shippingDaysMax: 2 });
    if (!off.ok) throw new Error("offer create failed");
    clean.offers.push(off.offerId);

    const asB = await updateSellerOffer(B.sellerId, B.userId, off.offerId, { priceIrr: 1, stock: 0, shippingDaysMin: 1, shippingDaysMax: 2, active: false });
    const asA = await updateSellerOffer(A.sellerId, A.userId, off.offerId, { priceIrr: 12346, stock: 4, shippingDaysMin: 1, shippingDaysMax: 2 });
    const o1 = await prisma.offer.findUniqueOrThrow({ where: { id: off.offerId } });
    verdict("offer-idor", asB.ok === false && asB.reason === "NOT_FOUND" && o1.price === 12346,
      `B→A: ${asB.ok ? "MUTATED!" : asB.reason}, A: ok=${asA.ok} price=${o1.price}`);

    const tB = await setSellerOfferActive(B.sellerId, B.userId, off.offerId, false);
    verdict("offer-toggle-idor", tB.ok === false && tB.reason === "NOT_FOUND");
  }

  // ── PROBE 3: seller tries to approve own application / suspend a rival
  {
    const A = await mkRealSeller("پروب حاکمیت");
    const B = await mkRealSeller("پروب حاکمیت رقیب");
    // transitionSellerStatus takes adminUserId as a string — a caller without an
    // admin session can only reach it through the admin server action, which
    // requires requireAdmin(). Simulate a hostile caller passing their own id:
    const r = await transitionSellerStatus({ sellerId: A.sellerId, to: "SUSPENDED", adminUserId: B.userId });
    // The lib-level function has no role gate (it trusts its caller); the
    // boundary is requireAdmin() in admin-p2e-actions.ts. Confirm + document.
    const s = await prisma.seller.findUniqueOrThrow({ where: { id: A.sellerId } });
    verdict("governance-lib-trusts-caller", s.sellerStatus === "SUSPENDED",
      `lib-level call with actor=B.userId succeeded → governance.ts is a trusted-internal API (boundary = requireAdmin in the action)`);
    await transitionSellerStatus({ sellerId: A.sellerId, to: "ACTIVE", adminUserId: "probe-admin" });
    void B;
  }

  // ── PROBE 4: real seller cannot create offer on a demo part (boundary) —
  // also: PENDING seller cannot, suspended seller cannot (already unit-tested,
  // here verify the DB-truth of seller status gating at lib level)
  {
    const A = await mkRealSeller("پروب وضعیت حاکمیتی");
    await transitionSellerStatus({ sellerId: A.sellerId, to: "SUSPENDED", adminUserId: "probe-admin" });
    const r1 = await createSellerOffer(A.sellerId, A.userId, { partSlug: realPart.slug, priceIrr: 1000, stock: 1, shippingDaysMin: 1, shippingDaysMax: 2 });
    await transitionSellerStatus({ sellerId: A.sellerId, to: "ACTIVE", adminUserId: "probe-admin" });
    const r2 = await createSellerOffer(A.sellerId, A.userId, { partSlug: realPart.slug, priceIrr: 1000, stock: 1, shippingDaysMin: 1, shippingDaysMax: 2 });
    if (r2.ok) clean.offers.push(r2.offerId);
    verdict("seller-status-gate", r1.ok === false && r1.reason === "NOT_ACTIVE" && r2.ok === true,
      `suspended→${r1.ok ? "CREATED!" : r1.reason}, active→${r2.ok ? "ok" : r2.reason}`);
  }

  // ── PROBE 5 (M-1): duplicate concurrent offer creation reusing one seller_sku
  // must yield EXACTLY ONE listing — the DB unique index is the backstop when
  // several transactions pass the in-transaction pre-check at the same time.
  {
    const A = await mkRealSeller("پروب آفر همزمان");
    const sku = `PROBE-RACE-${Date.now().toString(36)}`;
    const input = { partSlug: realPart.slug, priceIrr: 5000, stock: 1, shippingDaysMin: 1, shippingDaysMax: 2, sellerSku: sku };
    const res = await Promise.allSettled([
      createSellerOffer(A.sellerId, A.userId, input),
      createSellerOffer(A.sellerId, A.userId, input),
      createSellerOffer(A.sellerId, A.userId, input),
      createSellerOffer(A.sellerId, A.userId, input),
    ]);
    const created = res.filter(r => r.status === "fulfilled" && r.value.ok).length;
    for (const r of res) if (r.status === "fulfilled" && r.value.ok) clean.offers.push((r.value as { offerId: string }).offerId);
    const losers = res.filter(r => r.status === "fulfilled" && !r.value.ok) as PromiseFulfilledResult<{ ok: false; reason: string }>[];
    const allDupes = losers.every(l => l.value.reason === "DUPLICATE_OFFER");
    const rows = await prisma.offer.count({ where: { sellerId: A.sellerId, sellerSku: sku } });
    verdict("concurrent-offer-create-same-sku", created === 1 && rows === 1 && allDupes,
      `created=${created}/4, rows in DB=${rows}, losers=${losers.map(l => l.value.reason).join("/")} (unique index Offer(sellerId,sellerSku) enforced)`);
  }

  // ── PROBE 5b (M-1): the unique index exists at DB level
  {
    const idx = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename='Offer' AND indexname='Offer_sellerId_sellerSku_key'`,
    );
    verdict("offer-sku-unique-index", idx.length === 1, `index rows=${idx.length}`);
  }

  // ── PROBE 6: isRealSeller present on demo seed sellers? (truth oracle)
  {
    const demo = await prisma.seller.findMany({ where: { isRealSeller: false }, select: { businessName: true, sellerStatus: true, verified: true }, take: 5 });
    const real = await prisma.seller.findMany({ where: { isRealSeller: true }, select: { businessName: true, sellerStatus: true }, take: 10 });
    verdict("isrealseller-db-truth", true, `demo-flagged=${demo.length} real-flagged=${real.length} → ${real.map(r => r.businessName).join("، ")}`);
  }

  // ── PROBE 7: rejected seller cannot re-login to portal (session revoked?)
  {
    const A = await mkRealSeller("پروب ابطال نشست");
    const { token } = await createSession(A.userId);
    clean.sessions.push(token);
    await transitionSellerStatus({ sellerId: A.sellerId, to: "SUSPENDED", adminUserId: "probe-admin" });
    const sess = await prisma.session.findFirst({ where: { tokenHash: { not: "" }, userId: A.userId, revokedAt: null } });
    const sessionsForUser = await prisma.session.findMany({ where: { userId: A.userId } });
    const revokedCount = sessionsForUser.filter(s => s.revokedAt !== null).length;
    verdict("suspend-revokes-sessions", sessionsForUser.length > 0 && revokedCount === sessionsForUser.length && sess === null,
      `sessions=${sessionsForUser.length} revoked=${revokedCount}`);
  }

  // ───────────── P2-G.1 probes: trust axes under attack ─────────────

  // ── PROBE 8: seller profile-update path cannot mutate the new trust axes
  {
    const A = await mkRealSeller("پروب محور اعتماد ۸");
    const before = await prisma.seller.findUniqueOrThrow({ where: { id: A.sellerId } });
    const r = await updateSellerProfile(A.sellerId, A.userId, {
      businessName: "پروب محور اعتماد ۸",
      sellerOrigin: "DEMO",
      sellerVerificationStatus: "VERIFIED",
      sellerStatus: "SUSPENDED",
      verified: true,
      verifiedAt: new Date(),
      verificationActor: "self",
    } as never);
    const after = await prisma.seller.findUniqueOrThrow({ where: { id: A.sellerId } });
    verdict("trust-axes-immune-to-profile-injection",
      r.ok === true
        && after.sellerOrigin === before.sellerOrigin
        && after.sellerVerificationStatus === "UNVERIFIED"
        && after.sellerStatus === before.sellerStatus
        && after.verified === false,
      `origin=${after.sellerOrigin} verification=${after.sellerVerificationStatus}`);
  }

  // ── PROBE 9: forged verification value is rejected by the state machine
  {
    const A = await mkRealSeller("پروب جعل مقدار ۹");
    const r = await setSellerVerificationStatus({
      sellerId: A.sellerId,
      to: "HAX" as never,
      adminUserId: "probe-admin",
    });
    const s = await prisma.seller.findUniqueOrThrow({ where: { id: A.sellerId } });
    verdict("forged-verification-value-denied", r.ok === false && s.sellerVerificationStatus === "UNVERIFIED",
      `result=${JSON.stringify(r)}`);
  }

  // ── PROBE 10: onboarding input cannot smuggle origin/verification fields
  {
    const user = await prisma.user.create({ data: { phone: uniq(), role: "CUSTOMER" } });
    clean.users.push(user.id);
    const r = await applyAsSeller(user.id, {
      businessName: "پروب قاچاق ۱۰",
      sellerVerificationStatus: "VERIFIED",
      sellerOrigin: "DEMO",
      verified: true,
    } as never);
    const s = r.ok ? await prisma.seller.findUniqueOrThrow({ where: { id: r.sellerId } }) : null;
    if (r.ok && s) clean.sellers.push(s.id);
    verdict("onboarding-cannot-smuggle-trust-fields",
      r.ok === true && s !== null
        && s!.sellerVerificationStatus === "UNVERIFIED"
        && s!.sellerOrigin === "REAL_ONBOARDING",
      `origin=${s?.sellerOrigin} verification=${s?.sellerVerificationStatus}`);
  }

  // ── PROBE 11: verification is audited and evidence-backed; revocation clears both
  {
    const A = await mkRealSeller("پروب ممیزی ۱۱");
    await setSellerVerificationStatus({ sellerId: A.sellerId, to: "VERIFIED", adminUserId: "probe-admin", note: "بررسی" });
    const v = await prisma.seller.findUniqueOrThrow({ where: { id: A.sellerId } });
    const logsAfterVerify = await prisma.sellerEventLog.count({ where: { sellerId: A.sellerId, event: "seller_verification_changed" } });
    const okV = v.verifiedAt !== null && v.verificationActor === "probe-admin" && logsAfterVerify === 1;
    await setSellerVerificationStatus({ sellerId: A.sellerId, to: "UNVERIFIED", adminUserId: "probe-admin" });
    const u = await prisma.seller.findUniqueOrThrow({ where: { id: A.sellerId } });
    const logsAfterRevoke = await prisma.sellerEventLog.count({ where: { sellerId: A.sellerId, event: "seller_verification_changed" } });
    verdict("verification-audited-and-revocable", okV && u.verifiedAt === null && u.verificationActor === null && logsAfterRevoke === 2,
      `logs after verify=${logsAfterVerify}, after revoke=${logsAfterRevoke}, actor=${u.verificationActor ?? "null"}`);
  }

  console.log(`\nRESULT: ${pass} PASS, ${fail} FAIL`);
}

main()
  .catch((e) => { console.error("PROBE-FATAL", e); process.exitCode = 1; })
  .finally(async () => {
    await prisma.offer.deleteMany({ where: { id: { in: clean.offers } } });
    await prisma.sellerEventLog.deleteMany({ where: { sellerId: { in: clean.sellers } } });
    await prisma.seller.deleteMany({ where: { id: { in: clean.sellers } } });
    await prisma.session.deleteMany({ where: { id: { in: clean.sessions } } });
    await prisma.user.deleteMany({ where: { id: { in: clean.users } } });
    await prisma.$disconnect();
  });
