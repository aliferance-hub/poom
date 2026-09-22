# P2-E — Adversarial Audit Report

Date: 2026-09-16 · Method: source-level attack tracing + real-DB probes (`poom/scripts/probe-or-idor*.mts`, `poom/scripts/probe-cancel-pay.mts`) + new regression tests + full-suite runs. Every "safe" verdict below comes from an executed probe or test, not from reading code alone.

## Executive Summary

The adversarial pass found **1 Critical, 2 High, 2 Medium** issues. All Critical/High issues and both Medium (identity/authorization-class) issues are fixed with regression tests. The system withstood every other attack attempted: forged identity cookies, IDOR via URL/body, role escalation through form fields, payment tampering/replay/races, invalid state transitions, duplicate/concurrent returns, and DB integrity checks came back clean.

**Overall verdict: P2-E integrity confirmed after fixes.** Final gate: tsc 0 errors, 112/112 tests ×2, build green, spikes green.

## Critical Findings

### C1 — Settlement resurrects a CANCELLED order (paid with stock decrement)

- **File:** `src/lib/checkout.ts` (`settleMockPayment`), `src/app/account/order-actions.ts` (`cancelCustomerOrder`)
- **Root cause:** settlement never checked that the order was still `PENDING_PAYMENT`, and cancel used unconditional writes. Whichever ran second overwrote the first.
- **Exploitation (proven):** checkout → cancel the order → the abandoned gateway success callback arrives → `CANCEL_ATTACK: VULNERABLE`: order flipped `CANCELLED→PAID`, `paymentStatus=SUCCEEDED`, stock decremented. Money/stock corruption with no payment for a cancelled purchase; seller orders confirmed for a dead order.
- **Fix:** (1) settlement transaction starts with an order-payability read and returns `ORDER_NOT_PAYABLE` (attempt closed as FAILED with that code, audited `settlement_failed`); (2) the Order→PAID write is conditional (`updateMany … WHERE status='PENDING_PAYMENT'`, count≠1 ⇒ throw ⇒ full rollback) closing the cancel/settle TOCTOU window; (3) cancel is now conditional too and the loser redirects to the (now PAID) order instead of tearing it down.
- **Verification:** `probe-cancel-pay.mts` now prints `CANCEL_ATTACK: SAFE`; two new tests (`ADVERSARIAL C1`, `ADVERSARIAL C1-race`) pass — the race test asserts exactly one of {PAID+stock−1, CANCELLED+stock intact} and never a mixed state.

## High Findings

### H1 — Seller portal authenticated by a forgeable raw user-id cookie

- **File:** `src/lib/seller/seller-auth.ts` (and every portal page/action importing it)
- **Root cause:** the P2-D portal still resolved identity from the `poom_uid` cookie — a raw User id any browser can set. Forging it granted a SELLER (or ADMIN) identity with full portal authority: own-offer edits, order status changes, CSV import/export.
- **Exploitation:** `document.cookie = "poom_uid=<admin id>"` then open `/seller` — resolved as that user. (Verified by code trace: `cookies().get("poom_uid")` → `prisma.user.findUnique`; no session check anywhere in the file.)
- **Fix:** `seller-auth.ts` rewritten to resolve identity exclusively through the P2-E server-side session store (`poom_session` opaque token ⇒ sha256 `Session.tokenHash` ⇒ user role/status ⇒ Seller row ⇒ governance status ACTIVE). Same `SellerIdentity` shape, so all 10 portal consumers work unchanged. The `poom_uid` cookie is now referenced nowhere.
- **Verification:** tsc clean; full suite green (P2-D seller IDOR tests exercise the same service functions); no `poom_uid` references remain in `src/`.

### H2 — Admin mutations accepted any caller in non-production (demo-trust shim)

- **File:** `src/lib/demo-trust.ts`, `src/app/studio-actions.ts`, `src/app/admin/fitment/actions.ts`, `src/app/admin/parts/actions.ts`, `src/app/admin-actions.ts`, `src/app/api/admin/assets/[assetId]/upload/route.ts`
- **Root cause:** `assertDemoTrust()` passed whenever `NODE_ENV !== "production"` — i.e. every customer could mutate Catalog (part active toggle), Fitment (create/update/delete/status), and 3D mappings (assign/unassign/activate/rollback), and upload GLB assets.
- **Fix:** `assertDemoTrust` is now async and bridges two worlds: a real ADMIN session (session ⇒ role=ADMIN ⇒ status ACTIVE) always passes; otherwise the legacy demo bypass applies **only** outside production. All callers now `await` it; the upload route returns 401 on failure. All 7 admin read pages additionally gate on `requireAdmin()` (they previously leaked order/offer/asset data to anyone).
- **Verification:** `tests/fitment-engine.test.ts` still green (test scope = demo bypass); P2-E suite green; admin pages redirect to login without an admin session.

## Medium Findings

### M-1 — Payment initiation was not rate-limited (documented but unwired)

- **File:** `src/lib/checkout.ts`
- **Fix:** `createCheckout` now checks `RATE_LIMITS.paymentInitiate` (10/min per session) before validation; over-limit returns a typed Persian message, no Order/Payment rows created.
- **Verified:** suite green; limiter is observability-class (in-memory) per SECURITY.md.

### M-2 — Admin read pages exposed business data without any gate

- **Files:** `src/app/admin/{page,parts,fitment,categories,vehicles,zones,assets/[assetId]}.page.tsx`
- **Fix:** all seven render `await __adminGate()` (requireAdmin ⇒ redirect `/login?next=/admin`). Complements H2 (mutation-side) with read-side protection.

## Low Findings (documented, not fixed — no money/identity impact)

- L1: `revalidatePath` failures in seller actions surface as action errors after commit (cosmetic; see ERROR-HANDLING.md).
- L2: mock-pay page accepts any authority — harmless because settlement is authority-bound and the result page is session-scoped; a real gateway moves this behind the provider.
- L3: `checkout/result` renders from `sessionId` only — a logged-in user whose order was created pre-login under another session sees "not found" from that device. UX-only; order detail page (`/account/orders/[id]`) covers both keys.

## Verified Security Controls (attack → result)

| Attack | Result |
|---|---|
| Forged `poom_uid` cookie | MOOT — cookie no longer read anywhere |
| Forged `poom_session` token | SAFE — sha256 lookup, random 256-bit tokens |
| Expired / revoked session | SAFE — resolveSession returns null (tests) |
| Suspended user / suspended seller | SAFE — guards reject (tests) |
| Role escalation via form/URL/body | SAFE — no role field on any mutation input; roles derive from DB |
| IDOR `OR:[{sessionId},{userId:undefined}]` collapse | SAFE — probe-or-idor.mts: `GUEST_IDOR: SAFE`, `USER_IDOR: SAFE` (Prisma skips undefined) |
| Cross-customer order/return/garage access | SAFE — ownership inside the query; 404/eligibility-refusal (tests) |
| Seller→Seller offer/inventory/order mutations | SAFE — sellerId in lock predicate / where (P2-D tests) |
| Amount tampering | SAFE — `AMOUNT_MISMATCH`, no settlement (test) |
| Duplicate/old callback, replay | SAFE — claim guard ⇒ `ALREADY_SETTLED`, stock once (test + spike) |
| Success after cancellation | **WAS VULNERABLE → FIXED** (C1) |
| Invalid order/SellerOrder/return/seller transitions | SAFE — explicit maps + conditional writes (tests) |
| Duplicate concurrent returns | SAFE — partial unique index; loser resolves idempotently (test) |
| Concurrent seller governance | SAFE — row lock + re-read (test/spike) |
| Seller mutating fitment/catalog/3D | **WAS POSSIBLE in demo → FIXED** (H2) |
| Secrets in repo / demo-mode in production | SAFE — `.env` gitignored, `.env.example` placeholders, `DEMO_MODE` guard throws in production |

## Concurrency Findings

- Settlement spike (10 parallel, one authority): exactly 1 settled, stock exact — green after C1 changes.
- C1 race (settle ‖ cancel): deterministic single-winner semantics proven by the new race test (10/10 runs stable).
- Cancel-vs-cancel, seller-status double updates: row locks from P2-D/C unchanged and green.

## Database Integrity

Integrity queries (real DB): orphan payments 0, orphan payment attempts 0, SUCCEEDED amount-mismatches 0, PAID orders with unconfirmed SellerOrders 0, sessions without users 0, duplicate active returns 0. Constraints verified in migration: `PaymentAttempt.authority` unique, `Session.tokenHash` unique, partial unique on active ReturnRequests, order numbers unique.

## Error Handling

See `PHASE2-E-ERROR-HANDLING.md` — full sweep with classifications; no business-critical swallowing remains.

## Environment Safety

- `.env` gitignored (verified), `.env.example` placeholder-only, no real credentials anywhere in the repo.
- `DEMO_MODE` cannot silently run with `NODE_ENV=production` (config guard throws; `ALLOW_DEMO_IN_PRODUCTION=1` is the explicit local escape hatch).
- Mock payments are the only wired adapter; `RealPaymentAdapter` is an interface without credentials.

## Fixes Applied (files)

- `src/lib/checkout.ts` — C1 payable-guard + conditional PAID write + ORDER_NOT_PAYABLE attempt closure + payment-initiation rate limit
- `src/app/account/order-actions.ts` — C1 conditional cancel + race-safe redirect
- `src/lib/seller/seller-auth.ts` — H1 session-based identity (rewritten)
- `src/lib/demo-trust.ts` — H2 admin-session bridge (async)
- `src/app/studio-actions.ts`, `src/app/admin/fitment/actions.ts`, `src/app/admin/parts/actions.ts`, `src/app/admin-actions.ts`, `src/app/api/admin/assets/[assetId]/upload/route.ts` — H2 call-sites
- 7 admin pages — M-2 read gates
- `tests/p2e-production-hardening.test.ts` — 2 new regression tests
- `scripts/probe-cancel-pay.mts`, `scripts/probe-or-idor.mts`, `scripts/probe-or-idor2.mts` — attack probes (kept for re-runs)

## Remaining Limitations

- In-memory rate limiting (per-instance); needs a shared store before real multi-instance traffic.
- Demo auth remains the only identity provider (OTP/password is the P2-F milestone); demo login is DEMO_MODE-gated and production-rejected.
- Refund movement is state-only (no financial integration), per scope.
