# POOM Phase 2-E — Final Report

Date: 2026-09-16 · Scope: `poom/` as built for P2-E (production commerce + auth + governance + trust + payment hardening). Method: source inspection + migration diff + vitest (real PostgreSQL) + spike scripts + live Preview E2E. Nothing marked verified from file existence alone.

> **ADDENDUM — Adversarial audit (same day, post-completion).** A full adversarial pass
> (`PHASE2-E-ADVERSARIAL-AUDIT.md`) found and fixed 1 Critical (settlement could resurrect a
> CANCELLED order to PAID with stock decrement — proven by a DB probe, fixed with a payable-guard
> + conditional writes, regression-tested), 2 High (forgeable `poom_uid` cookie still authoritative
> for the seller portal → migrated to session identity; demo-trust shim let anyone mutate
> catalog/fitment/3D in non-production → admin-session bridge + admin read-page gates),
> and 2 Medium (payment-initiation rate limit wired; admin upload route input hardening).
> Error-handling sweep: `PHASE2-E-ERROR-HANDLING.md`. Post-fix gate: tsc 0, 112/112 ×2,
> build green, all 3 spikes green, probe `CANCEL_ATTACK: SAFE`, preview smoke clean.

## Executive Summary

P2-E lands the production-grade identity and payment core on top of the Phase-1/P2-A/B/C/D foundations without regressing any of them. The actor is now always server-derived (hash-stored session tokens replace the raw user-id cookie), payments gained an immutable attempt ledger with server-verified amounts and idempotent settlement, order lifecycles are explicit state machines, returns/shipments/refunds have modeled foundations, and seller governance + audit logging close the admin loop.

**Remaining risk is honest and documented**: rate limiting is per-instance, the return policy numbers need legal verification, refunds are state-only (no gateway), and the real payment adapter is an interface, not an integration.

## Baseline

`PHASE2-E-BASELINE.md` — recorded before changes: tsc 0 errors, 92/92 tests green, build green, prior phases' guarantees enumerated (settlement spike, garage activation race, P2-B fitment contract, P2-C search/vehicle context).

## Authentication

- `Session` model: SHA-256 `tokenHash` (unique), `expiresAt`, `revokedAt`, `lastSeenAt`; opaque token only in an HttpOnly/SameSite=Lax/`Secure`-in-prod cookie.
- `IdentityProvider` abstraction (`src/lib/auth/identity.ts`) with the demo phone-login provider implementing it; OTP/password providers are future implementations of the same seam.
- `DEMO_MODE` startup guard (config throws in production + demo).
- Login rate-limited (5/min per IP+phone). Logout revokes server-side.
- Legacy `poom_uid` identity cookie removed.
- **Verified**: session expiry and revocation tests; seller/admin/customer role-guard tests.

## Authorization

`requireAdmin / requireSeller / requireCustomer / getAuthenticatedSeller` — role + user status + (seller) seller status. All ownership filtering happens inside the DB query. Full IDOR matrix tested (see PHASE2-E-SECURITY.md) — all DENY paths green.

## Commerce

Checkout recomputes totals from Offer rows server-side; browser-supplied amounts are ignored. Cart mutations stay session-scoped and server-authoritative (Phase-1 behavior preserved). Customer cancellation restricted to `PENDING_PAYMENT`.

## Payments

`PaymentAttempt` ledger (attemptNumber, authority unique, idempotencyKey, failureCode…), server-side amount verification (`AMOUNT_MISMATCH`), replay/idempotency (`ALREADY_SETTLED`, no double stock/cart/audit effects — Phase-1 10-way concurrency spike still: exactly 1 settlement, exact stock), retry creates new attempts (FAILED attempts are never resurrected), settlement failure recorded (`SETTLEMENT_FAILED`) with `settlement_failed` audit and honest customer messaging.

## Orders

Explicit transition tables (`canTransitionOrder`, `canTransitionSellerOrder`) + conditional DB updates; terminal states respected. `Shipment` model + seller tracking UI. Shipping + item snapshots verified against post-order catalog/offer edits.

## Shipments

Carrier/tracking/method/cost/status fields, seller READY_TO_SHIP→SHIPPED with ownership + transition guards, customer-visible per-seller status. No carrier integration (by design).

## Returns

`ReturnPolicy` (configurable, legal-verification-flagged) + `ReturnRequest` with eligibility engine (order state, window from deliveredAt, duplicates), explicit 8-state machine, ownership enforcement, customer request/cancel UI, `Refund` foundation + `markRefunded` closing Order→REFUNDED. No fake external refund.

## Seller Governance

`sellerStatus` lifecycle (PENDING/ACTIVE/SUSPENDED/REJECTED) with pure transition functions, admin `/admin/sellers` (approve/suspend/reject/reactivate, filters, inspection links), every change audited, suspension hides offers from customer queries. Trust badge («فروشنده تأییدشده») rendered only from `verified && ACTIVE`; rating only with ordersCount > 0.

## Security

See PHASE2-E-SECURITY.md. Session hardening, IDOR matrix, payment attack suite, rate-limit hooks, zod validation on all P2-E mutations. `.env` gitignored (checked), `.env.example` placeholder-only, no real credentials introduced.

## Concurrency

- Payment settlement claim inside the transaction (10-way spike: 1 settled / 9 idempotent-absorbed, stock exact).
- Order-status transitions via conditional `updateMany` (lost-update safe).
- Return duplicate request guarded by partial unique index.
- Fixed during this phase: audit logging inside settlement now uses the transaction client (a global-client audit write deadlocked the connection pool under 10-way concurrency); test fixture drift in `checkout-lifecycle.test.ts` resolved without weakening assertions.

## E2E (Preview)

- Customer: login → account → garage/orders → order detail timeline → return request → cancel flow; result page renders from DB state.
- Seller: login → dashboard → offers (price persist) → inventory → orders → status/shipment update → customer view reflects it.
- Admin: login → sellers governance actions → audit stream filters.
- Console: no errors during the walkthroughs.

## Build

`npm run build` green (Next.js production build, routes table emitted). Dev server restarted detached afterwards per runbook.

## Test Results

- `tsc --noEmit`: **0 errors**
- `vitest run`: **112/112 green, twice consecutively** post-adversarial-audit (110 pre-audit; +2 adversarial regression tests)
- Spikes: settlement ×10, garage activation race, seller-order concurrency — all green (re-run after fixes)
- Adversarial probes: `probe-or-idor` (guest+user IDOR) SAFE, `probe-cancel-pay` SAFE
- Build: green (dev server stopped during build per runbook, restarted detached after)

## Environment Safety

DEMO_MODE guard, gitignored `.env`, placeholder `.env.example`, local-only DATABASE_URL, mock payment provider, no secrets in logs or docs.

## Known Limitations

1. Rate limiting is in-memory per instance — needs a shared store for multi-instance deploys (NOT VERIFIED beyond one instance).
2. Return policy values (window days, opened-items) are placeholders pending legal review (NOT VERIFIED).
3. Refunds are state-machine only; no financial integration.
4. Real payment adapter is a documented interface; no gateway credentials exercised.
5. `logAudit` non-transactional writes use a system seller id to satisfy NOT NULL (documented compromise).

## Recommended P2-F

Real OTP identity provider behind `IdentityProvider`; shared rate-limit store; payment gateway adapter skeleton + webhook signature verification; shipment carrier abstraction; return review workflow for seller/admin; order timeline notifications; commission ledger groundwork.
