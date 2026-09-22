# P2-D Final Report — Seller Portal + Offer Management + Inventory

Date: 2026-09-16 · Scope: `poom/` · Method: real-DB tests (vitest, service-level with explicit identities) + live Preview E2E (real browser session, real forms/cookies) + concurrency spike against real PostgreSQL + curl IDOR probes. Nothing is claimed verified from file existence alone.

## Executive Summary

**P2-D is complete.** The seller side is now an authenticated, ownership-enforced operational portal. The browser can no longer choose the authoritative seller (the Phase-1 SEC-1 finding is closed for the seller surface): identity flows `poom_uid cookie → User(role=SELLER) → Seller` server-side, and every mutation re-verifies ownership inside its transaction. The old public demo page is preserved at `/seller-demo` without authority. CSV import/export with all-or-nothing semantics, freshness policy, explicit order state machine with row-lock idempotency, and audit logging are in place and verified.

## Verification gate (exact results)

```text
TypeScript:              npx tsc --noEmit → 0 errors
Tests:                   vitest run → 91/91 passed (6 files) — 65 pre-P2D + 26 new P2-D
Tests ×2 (consecutive):  RUN1 91/91, RUN2 91/91 (both green)
P2-D file repeated:      ×3 consecutive PASS (run-suite-loop)
Concurrency (spike):     scripts/spike-seller-concurrency.mts → 10/10 rounds
                         (A: settle+seller-stock — no negative stock, order PAID, stock ∈ {7,9}
                          B: 2 concurrent seller updates — valid final state
                          C: 3 concurrent SHIPPED — final=SHIPPED, exactly 1 audit row)
Build:                   npm run build → ✓ Compiled successfully, 28/28 pages
Preview:                 registered http://127.0.0.1:3010/ (PID 6520, dev mode)
Console:                 clean (only benign CSS-preload warnings; the single 422 entry
                         was my own negative-test fixture, expected)
```

## Seller auth (live-verified)

- `/seller` unauthenticated → redirect `/login?next=/seller` (307, curl + browser).
- Demo login `09012345678` → dashboard renders «فروشنده نمایشی ۱ (ویرایش تست)» with nav, demo badge, real DB cards.
- Foreign session (guest cookie) probes: `/seller`, `/seller/offers` → 307; CSV PUT → `{error: "دسترسی فروشنده یافت نشد."}`; export → **404**.

## Offer management (live-verified)

- Inline editor: price `3,980,000 → 4,250,000` IRR saved via the real form; **persisted across reload**; freshness line updated to «امروز، 22:58».
- Filters/sort/search/pagination render (41 offers, 3 pages, tabs «همه/فعال/غیرفعال/موجود/کم‌موجود/ناموجود»).
- Suite: negative price/stock, reversed shipping range, float money, huge int → INVALID with Persian errors; SKU/warranty bounded; activate/deactivate idempotent with single audit row.

## Inventory & CSV (live-verified)

- Inventory page: bucket cards (کل/موجود/کم‌موجود/ناموجود/کهنه), low-stock uses row-level threshold comparison.
- CSV E2E in the real browser session: export → matched row for `DEMO-SKU-S1-PAD-FRT-01` → preview (1 VALID) → commit `{ok:true, updatedCount:1}` → **DB row: price 4,100,000, stock 8**.
- Negative tests live: foreign SKU → INVALID («…برای فروشگاه شما یافت نشد»), negative price → INVALID, commit with invalid rows → `HAS_INVALID` nothing applied. Suite covers unknown part, bad header, malformed boolean, >500 rows, >2 MB, all-or-nothing rollback, export isolation, formula-injection escape (`=1+1` → `'=1+1`).

## Seller orders (live-verified)

- List scoped to seller (77 rows, status tabs). Detail shows **snapshot prices** («قیمت لحظه‌ی خرید»).
- Clicked «ارسال شده» → status persisted (reload shows SHIPPED; buttons now only «تحویل شده/مرجوعی» — explicit machine).
- Suite: valid path, invalid jump rejected, duplicate-update idempotent (no dup audit), concurrent duplicates → exactly 1 audit row.

## Customer ↔ seller integration (live-verified)

- After CSV commit: public part page `/parts/brake-pad-front-206` renders **۴۱۰,۰۰۰** (new seller-1 price); DB cross-check shows seller-1 = 4,100,000/stock 8 vs other sellers unchanged.
- Seller set SHIPPED → customer's own `/account/orders` page (owner session) renders «ارسال شده» badge (grep=1) — both views read the same SellerOrder row.

## Security (suite + live)

Horizontal/vertical matrix incl. customer-role rejection, admin-boundary check, profile whitelist (verified/rating/status injection attempts dropped), IDOR indistinguishability — all per `PHASE2-D-SECURITY.md`. Phase-1 regressions (payment replay, amount tampering, stock settlement, fitment, garage ownership, search) — covered by the 65 pre-existing tests, all green in both full-suite runs.

## .env audit

`.env` gitignored (lines 4–5); contains only local DB URL, `MOCK_PAYMENTS=1`, and demo login phones. `.env.example` created with safe placeholders. No real secrets exist; none printed.

## Files changed (P2-D)

- Schema/seed: `prisma/schema.prisma`, `prisma/migrations/20260915_p2d_seller_portal/migration.sql`, `prisma/seed-p2d-users.mjs`, `.env` (+demo logins), `.env.example` (new)
- Services (new): `src/lib/seller/{seller-auth, seller-auth-test, seller-audit, seller-validation, seller-offers, seller-inventory, seller-orders, seller-csv, seller-service, seller-metrics}.ts`
- Portal (new): `src/app/login/page.tsx`, `src/app/seller/{login-actions, seller-actions}.ts`, `src/app/seller/{page, offers/page, inventory/page, profile/page, orders/page, orders/[sellerOrderId]/page}.tsx`, `src/app/seller-demo/page.tsx` (preserved public demo)
- API (new): `api/seller/logout`, `api/seller/inventory/export`, `api/seller/inventory/import` routes
- Components (new): `components/seller/{seller-nav, offer-row-editor, csv-import-panel, order-status-buttons, profile-form}.tsx`
- Customer integration: `src/app/account/orders/page.tsx` (suborder status labels)
- Tests/scripts: `tests/p2d-seller-portal.test.ts`, `scripts/spike-seller-concurrency.mts`, `scripts/apply-sql-file.mjs`, `scripts/run-suite-loop.mjs`
- Docs: this file + `PHASE2-D-{BASELINE, SELLER, INVENTORY, CSV, ORDERS, SECURITY}.md`
- One real concurrency fix during testing: `updateSellerOrderStatus` gained a `FOR UPDATE` row lock (read-then-write race produced duplicate audit rows; after the lock: exactly one).

## Known limitations

- Login is demo-mode (env-verified phone), not real credentials — the auth milestone replaces `demoLoginAction` only; the authorization contract stays.
- `PROCESSING`/`READY_TO_SHIP` workflow statuses need a DB enum migration to be persisted (currently accepted as future targets, not reachable — documented).
- CSV matching requires existing `sellerSku`; offers without SKU can't be CSV-updated (seed sets SKUs).
- Screenshot capture unavailable in this environment (webview frames) — all UI verification above is DOM/snapshot/text-level; visual rendering **NOT VERIFIED** pictorially.
- Sales/response-time analytics are real-aggregate or explicitly null; no fabricated metrics.

## Recommended P2-E

1. Real authentication (OTP/credential provider) behind the same identity contract.
2. SellerOrder DB enum migration + PROCESSING/READY_TO_SHIP UI flow, shipment records.
3. Offer-creation flow (admin-approved Part → seller offer) + fitment-report stub («گزارش ناسازگاری»).
4. Admin seller-moderation page (verify/status) completing the §33 loop.
5. Async/queued CSV for beyond-500-row imports (background worker milestone).
