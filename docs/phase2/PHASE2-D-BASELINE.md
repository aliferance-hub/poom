# P2-D Baseline — Seller Portal (recorded before any P2-D change)

Date: 2026-09-15 · Method: source inspection of every relevant file + DB row counts + baseline run. Nothing claimed from file existence alone.

## Verification at baseline

| Check | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | **0 errors** |
| Tests | `vitest run` | **65/65 passed** (Phase 1 lifecycle, 2-A assets, 2-B fitment, 2-C garage/search) |
| DB | `scripts/sql.mjs` | 3 sellers · 94 offers · 151 seller orders · seed healthy post-reboot |

## Current seller architecture (inspected)

- `src/app/seller/page.tsx` — a **public demo page**, not a portal: any visitor can switch seller via `?seller=<id>` from the URL. Read-only listing of offers/orders + inline price/stock editing through a shared unauthenticated server action.
- `src/app/admin-actions.ts` — `updateSellerOfferAction(offerId, price, stock)` is **unauthenticated** (`assertDemoTrust()` fails closed only outside demo mode). Carries an explicit `TODO(AUTH)` referencing audit finding **SEC-1** ("scope to own offers"). No seller scoping, no Zod, no audit log.
- `src/app/admin/page.tsx` — admin oversight exists (offers, orders, sellers, zones, assets) and is **kept** as-is this phase.
- `src/middleware.ts` + `src/lib/session.ts` — cookie session (`poom_sid`, HttpOnly) for guests; **no login, no User rows in use** (User table empty in dev DB).

## Schema facts (prisma/schema.prisma)

- `Seller`: businessName, ownerName, phone, city, address, status (default `DEMO_UNVERIFIED`), rating, responseRate, verified — **no userId link**.
- `Offer`: sellerId, partId, price (Int IRR), compareAtPrice, stock, lowStockThreshold (default 3), shippingDays (single int, default 2), sellerSku, condition, warrantyNote, active, updatedAt. Index `[partId, active]` only — **no `sellerId` index**.
- `SellerOrder`: orderId, sellerId, status (`PENDING/CONFIRMED/SHIPPED/DELIVERED/CANCELLED/RETURNED`), subtotal, shipping. **No createdAt/statusUpdateAt**.
- `OrderItem`: snapshot fields `unitPrice`, `total` (immutable) — historical price immutability already guaranteed structurally.
- **No SellerEventLog/AuditLog model. No freshness fields (stockUpdatedAt/priceUpdatedAt).**

## Authorization model (as-found)

- Everything seller/admin is demo-mode; `assertDemoTrust()` is the only gate. There is **no `getAuthenticatedSeller()`** concept, no seller→User binding. This is the SEC-1 known gap the MVP audit recorded as accepted for Phase 1.

## Test coverage as-found

- Phase 1: checkout lifecycle incl. stock settlement, payment replay/double-settle, amount tampering.
- 2-A: asset registry/publish/rollback. 2-B: fitment engine + admin moderation. 2-C: garage CRUD/ownership/activation race, search matrix, Persian normalization.
- **No seller-authorization tests** (nothing to test — actions were unauthenticated).

## P2-D design decisions (from this baseline)

1. **Authentication: demo cookie pairing, not a real auth system.** P2-D stays out of the real-login project (explicitly not in this phase's scope); instead a `SELLER_LOGIN=<phone>` / `ADMIN_LOGIN=<phone>` pair in `.env` configures a `User` row per role. `getAuthenticatedSeller()` resolves cookie→User→Seller; the public `/seller` demo page is preserved at `/seller-demo` and the real portal lives at `/seller` (session-gated).
2. **Schema additions (all additive, no destructive migration):**
   - `Seller.userId → User` (unique) + `User.seller?`
   - `Offer.shippingDaysMin/Max Int?` (migration fills from existing `shippingDays`; single field stays for customer UI compatibility — services write both)
   - `Offer.stockUpdatedAt/priceUpdatedAt DateTime?` for freshness
   - `SellerEventLog` (audit/observability) + `SellerProfileEdit` (admin moderation stub) models
   - Indexes: `Offer(sellerId, active)`, `Offer(sellerId, updatedAt)`, `SellerOrder(sellerId, status)`
3. **Services** in `src/lib/seller/` with `getAuthenticatedSeller()` (role SELLER verified server-side; sellerId always derived from session, never accepted from client).
4. **CSV**: parse → validate → preview → all-or-nothing commit (documented choice); Zod row schema; hard limits (2 MB, 500 rows, 4k-char fields); ownership forced server-side (`sellerId = authenticated seller`); export escapes `=+-@` formula injection.
5. **Seller order state machine**: explicit `ALLOWED_TRANSITIONS` map, single DDL-free implementation in the service; duplicate-delivery mutation is idempotent (no duplicate audit rows).
6. **Concurrency**: offer stock mutations use conditional `updateMany` (checkout's settlement pattern, proven in Phase 1); CSV commit applies `stock: { set }` inside one bounded transaction — merge semantics with concurrent settlement documented and tested.
7. **Freshness policy**: `stockUpdatedAt`-based `fresh` (≤ 48h) / `stale`; threshold is a service constant, surfaced in UI, not hard-coded in components.
