# POOM MVP — Production-Oriented Audit

Date: 2026-09-14 · Scope: `poom/` implementation as built · Method: source read + DB queries (`scripts/sql.mjs`) + concurrency spike (`poom/scripts/spike-concurrency.mts`) + live Preview inspection. Nothing is marked verified from file existence alone.

---

## Executive Summary

**Overall rating: B−** (acceptable as a demo/MVP skeleton; **not** production-ready until the Critical and High items below are fixed)

The commerce core (checkout state machine, stock safety, multi-seller grouping) is genuinely solid and survived an adversarial concurrency spike. The weakest areas are **authorization** (demo trust boundary on admin/seller mutations), **missing indexes**, and **a real race window in checkout** (TOCTOU between validation and settlement — bounded by the stock-guard, but produces stale-error UX).

---

## Critical Issues

### C-1 · Unauthenticated admin/seller mutations (demo trust boundary)
- **Files:** `src/app/admin-actions.ts` (all 3 actions), `src/app/seller/page.tsx`
- **Severity:** CRITICAL (pre-audit: anyone could edit any offer, any fitment, any zone; post-audit: fail-closed outside demo mode)
- **Detail:** `updateSellerOfferAction` mutates ANY offer by id (no seller ownership scope); `updateFitmentStatusAction` lets a seller effectively change official fitment; `updateZoneAction` is admin-grade. Server Actions are callable by any browser client.
- **Fixed in this audit:** `assertDemoTrust()` gate added — mutations throw `AUTH_REQUIRED` when `MOCK_PAYMENTS!=="1"` AND `NODE_ENV==="production"`. `TODO(AUTH)` markers document the exact scoping needed (`sellerId` ownership filter).
- **Residual risk:** in demo mode anyone can still mutate (by design, but must be stated). Fix with real auth before any non-demo deployment.

### C-2 · Guest session id is unauthenticated identity
- **Files:** `src/middleware.ts`, `src/lib/session.ts`
- **Severity:** CRITICAL for any real deployment / acceptable for guest-cart demo
- **Detail:** `poom_sid` cookie = full ownership of cart + orders. Anyone with the cookie value reads/sets another guest's cart; sessions never expire server-side; `newSessionId()` uses `Math.random()` (not CSPRNG) — middleware uses `crypto.randomUUID()` (fine).
- **Recommendation:** keep `poom_sid` for anonymous cart only; bind orders to real `User` rows with OTP auth (PRD already plans it).

## High Priority

### H-1 · TOCTOU race: checkout validate → order → settle
- **Files:** `src/lib/checkout.ts` (`createCheckout`, `settleMockPayment`)
- **Severity:** HIGH (data-safe but wrong-UX under contention)
- **Detail:** validation reads stock at checkout time; settlement re-checks via conditional `updateMany ... stock >= qty`. Two buyers can both create orders for the same last unit; the loser gets `STOCK_CONFLICT` at payment time (surface: generic failure). Verified by spike: **no oversell, exactly-one settlement** — the money/stock invariants hold; only the UX path degrades.
- **Recommendation:** pre-reserve at order creation (conditional decrement into a `Reservation` row, restore on payment failure) — PRD §26 risk 3 anticipated this.

### H-2 · Order-result page scoping was horizontal-tenancy-open
- **Files:** `src/app/checkout/result/page.tsx`
- **Severity:** HIGH (info disclosure of arbitrary order + buyer session linkage)
- **Detail:** `orderNumber` in URL fetched the order unscoped — any visitor could view any order's lines/subtotals.
- **Fixed in this audit:** `findFirst({ where: { orderNumber, sessionId: await getSessionId() } })` — guests can only view their own session's orders.

### H-3 · Missing hot-path indexes
- **Files:** `prisma/schema.prisma`
- **Severity:** HIGH (perf at scale; invisible at 41 parts)
- **Detail:** no index on `Offer(partId, active)`-adjacent lookups is fine at MVP scale, but `CartItem(cartId)` is covered only by the composite unique; `Fitment(partId, vehicleId, variantId)` has an index (good); missing: `OrderItem(sellerOrderId)` inverse lookups, `Offer(sellerId)`, `Order(sessionId)` (orders-by-guest lookup on every `/account/orders` hit).
- **Recommendation:** add `@@index([sessionId])` on Order, `@@index([sellerId])` on Offer, `@@index([sellerOrderId])` is implicit via FK in PG (Prisma creates FK indexes for required relations — verify with `\d`).

### H-4 · ESLint disabled during builds
- **File:** `next.config.ts` (`eslint: { ignoreDuringBuilds: true }`)
- **Severity:** HIGH (process) — no lint gate exists at all (no eslint config installed).
- **Recommendation:** add `eslint` + `eslint-config-next`, run in CI; do not ship with the escape hatch.

## Medium / Low Priority

### M-1 · Payment amount integrity is adapter-implied, not enforced
- **Files:** `src/lib/payments.ts`, `src/lib/checkout.ts`
- **Detail:** `Payment.amount` is written by the trusted server path (`order.total`), and settlement never reads browser amounts. But `verifyPayment` doesn't re-verify `payment.amount === order.total` — with a real gateway the callback signature check must live **inside** the adapter, and amount match must be asserted before settlement. Add: `if (payment.amount !== order.total) abort` in settlement.
- **Status:** PARTIALLY MITIGATED for mock (no client input path); REQUIRED before any real gateway.

### M-2 · Mock payment endpoint is user-selectable outcome
- **Files:** `src/app/checkout/mock-pay/page.tsx`, `src/app/actions.ts` (`mockPayAction`)
- **Detail:** the buyer chooses success/failure (that's what a mock is), but the settlement trusts the adapter outcome. Fine while `MockPaymentAdapter` is the only implementation; a real gateway must verify signatures server-side.

### M-3 · `searchParts` loads up to 200 parts into memory
- **File:** `src/lib/catalog.ts`
- **Detail:** in-memory scoring with a code comment acknowledging the migration path (tsvector/trigram). Fine for 41 parts; will fall over at thousands.

### M-4 · No idempotency key on order creation
- **Detail:** double-click on "ایجاد سفارش" can create two PENDING orders for one cart. Mitigation exists (settlement only pays one; the other just dies as PENDING), but duplicate-order noise is possible. Add a client-generated idempotency token or unique (sessionId, checkoutToken).

### M-5 · RTL/UX nits
- **Files:** `src/app/layout.tsx`, `src/components/viewer/*`
- **Detail:** cart badge overlay uses `-left-2` (RTL-correct), but viewer fullscreen button has no `aria-label`; number inputs on cart page accept free typing then clamp server-side (good) but show no inline hint. No mobile bottom-sheet (PRD §22 wanted one); desktop panel is the only part panel.

### L-1 · `authenticityNote`/`warrantyNote` are free-text demo strings
- **Detail:** PRD wants a Policy Engine + verification workflow; current fields can't lie structurally (nothing renders them as real guarantees), but they also don't model evidence.

### L-2 · `VehicleVariant.productionStart/End` seeded 2002–2015 (likely wrong for Iran-market 206)
- **Detail:** DEMO-labeled everywhere, but should be replaced with sourced data before any real use.

## Verified Strengths

1. **Settlement is transactional and race-proof.** Spike: 10 parallel `settleMockPayment` on one authority → exactly 1 OK, `stock` 1→0 exactly once per line, order PAID once, cart emptied, 8 losers cleanly rejected (`ALREADY_SUCCEEDED`). Ran twice, deterministic. (`poom/scripts/spike-concurrency.mts`, permanent test `parallel settlements ... no oversell`.)
2. **Stock never moves before success.** Verified: after a `failure` outcome, offer stock unchanged; after success, decrement equals ordered qty; replay of the failed authority cannot decrement (status guard).
3. **Prices are server-computed everywhere.** No browser-supplied amount/price reaches DB: cart view re-reads `Offer.price` from DB; checkout re-reads; `OrderItem.unitPrice` snapshots `Offer.price` at order time (price-snapshot correctness ✔); seller edits go through server action with clamping.
4. **Multi-seller grouping works** — verified in UI (order with lines from 2 sellers → 2 SellerOrders with correct subtotals 640,000 / 1,203,000) and in tests.
5. **Cart is DB-authoritative.** Zustand stores a badge count only (`store/cart-count.ts`), hydrated from `/api/cart`, never persisted; all mutations are server actions writing `Cart/CartItem`; stock overshoot clamps to available; dead lines are now pruned (post-audit) so view and DB converge.
6. **Asset Contract chain is real:** `zone_cooling` mapping (camera pos/target) → `assembly-cooling` slug → `part_radiator_main` PartMeshMapping → `radiator-206` Part → 2 CONFIRMED Fitments (تیپ ۲، تیپ ۵) → 4 Offers across 3 sellers. Verified live (3D click → part page) and by test (`Asset Contract exposes all 8 zone mappings ...`).
7. **Persian normalization** — `لنت ترمز ۲۰۶` ≡ `لنت ترمز 206`; `ك`→`ک`, `ي`→`ی`, ZWNJ, punctuation, digits; unit-tested incl. the PRD example set; live search returns the radiator for `رادیاتور ۲۰۶`.
8. **TypeScript strict** passes with `noUncheckedIndexedAccess`; **build** passes (16 routes); **17/17 tests** green incl. concurrency test.
9. **FK integrity** — verified RESTRICT on `OrderItem→Offer` blocks orphaning purchase history (spike cleanup error proved the guard fires).

## Test Coverage Gaps

Covered today: fitment, normalization, cart CRUD+clamp, offer sorts, asset contract, multi-seller grouping, stock decrement only-on-success, payment failure, retry, double settlement, **parallel settlement (new)**, cart clearing, empty/insufficient checkout blocking, seller/admin visibility.

Missing (recommended):
1. **Authorization tests** (currently impossible — no auth exists; write them WITH the auth feature: cross-seller offer edit denied, cross-session order read denied, fitment edit admin-only).
2. **Payment amount tampering** — unit test asserting settlement aborts if `Payment.amount ≠ Order.total` (needs M-1 fix first).
3. **Concurrent addToCart** on the same cart row (two tabs) — currently last-write-wins on quantity via update; assert merge semantics explicitly.
4. **RTL snapshot test** for money formatting at edge values (0, 9.999 IRR → rounding).
5. **E2E golden path in CI** (Playwright) — the preview walk is manual today.
6. **Order-number uniqueness under contention** (M-4) — parse-check `POOM-` uniqueness with parallel checkouts.

## Security Findings

| # | Finding | Severity | Status |
|---|---|---|---|
| S-1 | Admin/seller actions unauthenticated (C-1) | Critical | **Fixed** (fail-closed gate; real auth still required) |
| S-2 | Order result readable by any visitor (H-2) | High | **Fixed** (session-scoped) |
| S-3 | Guest session = identity (C-2) | Critical-for-prod | Documented; needs real auth |
| S-4 | No secrets client-side: `.env` holds only local DB URL + `MOCK_PAYMENTS`; no gateway keys exist | Info | OK |
| S-5 | Cookie flags: httpOnly+sameSite=lax+30d; no `secure` flag (localhost) | Low | Add `secure` in prod |
| S-6 | Payment callback forgeable **in mock only** (M-2) — `settleMockPayment` has no signature | Medium (mock-scoped) | Acceptable for mock; must be signature-verified for real gateway |
| S-7 | Amount server-verified: server-derived at creation; **settlement now aborts on `Payment.amount ≠ Order.total`** (M-1 fix); real gateway must also verify signature inside adapter | Medium | **Fixed** (mock scope); signature check still required for real gateway |
| S-8 | SQLi: all data access via Prisma parameterized queries; raw SQL only in `scripts/sql.mjs` (operator tool, not web-reachable) | Info | OK |
| S-9 | `redirect(back)` used a client-supplied form string — a crafted `back="//evil.com"` could redirect off-site | Medium | **Fixed:** relative-path whitelist `^\/(?!\/)[^\\\s]*$` in `addToCartAction` |

## Architecture Findings

- **Boundaries hold.** Catalog (`lib/catalog.ts`) / commerce (`lib/cart.ts`, `lib/checkout.ts`) / payments (`lib/payments.ts`) / 3D registry (`lib/registry3d.ts`) are separate modules with one-directional imports: commerce→catalog types only, viewer→contract type only. **No 3D→commerce import**; `car-scene.tsx` uses only `AssetContract` + `ZoneInfo` types and navigates by URL.
- **Part/Offer coupling:** correct direction — `Offer` references `Part` (FK), comparison logic (`lib/offers.ts`) sorts Offers; `Part` knows nothing of pricing. No accidental inverse coupling found.
- **Duplicated logic:** minor — stock-state classification exists in `offers.ts` (UI labels) and implicitly in cart clamp; acceptable. `getOrCreateCart` called repeatedly inside `addToCart` (2× per call) — cheap but sloppy; single fetch would do.
- **Circular dependencies:** none found (verified by import graph reading; `checkout → cart, payments, prisma`; `actions → checkout, cart, session`; nothing imports back).
- **Hidden global state:** only the Prisma singleton (`lib/prisma.ts`) — standard Next dev pattern, intentional.
- **Business logic in UI:** `SellerOfferRow` (client) owns clamping? No — it sends raw numbers; clamping happens server-side (`admin-actions.ts`). Viewer components contain **zero** domain logic (navigation only). ✔
- **Unnecessary abstraction:** `PaymentService` interface with one impl is justified by the PRD's adapter requirement (ZarinPal next). `stockLabel`/`stockState` exports slightly over-factored — fine.

## Performance Findings

Measured, not estimated:
- **First Load JS** (build output): shared 103 kB; heaviest route = `/vehicles/.../[trim]` **108 kB** (viewer page). The 3D stack (three+R3F+drei ≈ 600–700 kB raw) is **excluded from this** via `dynamic(..., { ssr:false })` + `next/dynamic` chunking — verified: the build's per-route numbers show non-viewer pages at 103–107 kB.
- **Server pages are all `ƒ (Dynamic)`** — every request hits DB (session+cart in layout). At MVP scale fine; layout's cart read doubles on every page including static-ish ones. Consider making the header badge client-fetch-only to drop the server cart read from every route.
- **N+1-ish patterns:** `validateCartForCheckout` runs 1–2 fitment queries **per line** (loop) — fine for small carts; batch with `findMany({ where: { partId: { in: [...] }, variantId } })` later.
- **3D runtime:** one Canvas, `dpr [1,2]`, no shadows; camera lerp runs `useFrame` every frame even when idle — cheap (two `lerp`s) but could gate on distance-threshold. Materials are shared per-Box (no leak found; R3F disposes on unmount — `NOT VERIFIED` under StrictMode double-mount in dev, but prod build doesn't double-mount).
- **Images:** none used (text/badge UI only) — nothing to optimize; PRD galleries will need `next/image`.
- **No Lighthouse run claimed.**

## UX Findings

From the live preview (screenshots taken during build & audit turns):
- **Visual hierarchy** works: graphite header, hero CTA, zone cards; RTL layout correct end-to-end (Vazirmatn loads, fa digits everywhere).
- **3D affordance:** hover hint pill ("بچرخانید · روی ناحیه یا قطعه کلیک کنید") + accent highlight + zone panel on click = clickable zones are discoverable; but **part hotspots (radiator/battery/pad/floor mat) look identical to zone boxes** — nothing signals they navigate to a product. Recommendation: pulsing dot markers or cursor change + label on hover.
- **Transition clarity:** breadcrumb + zone panel "مشاهده قطعات این ناحیه" keeps orientation vehicle→zone→assembly→part; good.
- **Offer comparison:** sort chips + stock badges (موجود/کم‌موجود/ناموجود) + best-offer tag read clearly; prices formatted `۶۴۰,۰۰۰ تومان`.
- **Cart/multi-seller:** cart page groups lines with per-seller labels; checkout shows "فروشندگان درگیر: ۲" — decent; a per-seller grouping *in the cart page* (PRD step 17) is only implicit (seller name per line), not visual sections.
- **States:** loading (viewer placeholder ✔), empty cart ✔, error (checkout blocked with Persian reasons ✔, payment failure page ✔). **Not built:** network-error toasts, offline, 404 pages (default Next).
- **Mobile:** responsive grids + sticky header verified at narrow width in earlier screenshots; **no bottom-sheet** for part panel (PRD §22) — offer cards render below the viewer instead. Desktop two-column part layout ✔.
- **Persian digits in inputs:** cart qty input shows Latin digits (functional, minor inconsistency).

## Recommended Fix Order

1. **S-9** — validate `back` redirect (30 min, closes an open-redirect).
2. **M-1** — assert `payment.amount === order.total` inside settlement (30 min, makes amount integrity structural).
3. **H-4** — add ESLint config + gate (1 h).
4. **H-3** — add `Order(sessionId)`, `Offer(sellerId)` indexes + migration (1 h).
5. **C-1/C-2/H-2 hardening → real Auth (OTP)** with role checks; rewrite admin/seller actions with ownership scoping; add the missing authorization tests (2–3 d).
6. **H-1** — stock reservation at checkout (reserve → settle → release) + concurrency tests for the reservation path (1–2 d).
7. **M-4** — idempotency token on checkout button (2 h).
8. **M-3** — move search to Postgres trigram/tsvector when catalog >500 parts.
9. **UX batch:** 3D hotspot affordance, mobile bottom-sheet, cart per-seller sections, `secure` cookie flag (1–2 d).

---

## Files changed during this audit (fixes only — no features)

| File | Change |
|---|---|
| `src/app/admin-actions.ts` | `assertDemoTrust()` fail-closed gate + `TODO(AUTH)` scoping notes |
| `src/app/checkout/result/page.tsx` | order fetch scoped to guest session (S-2/H-2 fix) |
| `src/app/actions.ts` | **S-9 fix:** open-redirect guard on `back` (relative-path whitelist); removed dead `clearCartAction`/unused import |
| `src/lib/checkout.ts` | **M-1 fix:** `AMOUNT_MISMATCH` abort in settlement when `Payment.amount ≠ Order.total` |
| `src/lib/cart.ts` | dead cart lines pruned in `getCartView` (view ⇄ DB convergence) |
| `src/lib/persian.ts` | doc comment on `newSessionId` (kept as middleware fallback) |
| `src/components/viewer/car-scene.tsx` | fullscreen handler dead-code cast removed |
| `tests/checkout-lifecycle.test.ts` | two new permanent tests: parallel settlements settle exactly once; settlement aborts on tampered amount |
| `scripts/spike-concurrency.mts` | (new, `poom/scripts/`) reusable 10×-parallel settlement spike with self-cleaning fixtures |

## Post-fix verification (all run 2026-09-14)

```
npx tsc --noEmit                → 0 errors
vitest run                      → Test Files 2 passed · Tests 18 passed (18)  [incl. amount-tamper + parallel-settlement]
npm run build                   → ✓ Compiled successfully · 16/16 routes
npx tsx scripts/spike-concurrency.mts (×3) → SPIKE PASS ✔ (oks=1, stock exactly 0, cart 0, PAID)
DB leftovers check              → fixtures=0, offers=92 (seed-exact)
Preview /parts/radiator-206     → HTTP 200, 4 offers rendered (5th was leftover fixture, purged), console clean
Server restarted (PID 15264) after fixes; preview re-registered
```
