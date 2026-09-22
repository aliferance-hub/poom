# P2-E Baseline — Production Commerce / Auth / Governance (recorded before any P2-E change)

Date: 2026-09-16 · Method: source inspection of auth/session/payment/order/return surfaces + baseline runs. Nothing claimed without inspection.

## Baseline verification

| Check | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | **0 errors** |
| Tests | `vitest run` | **91/91** (6 files: Phase-1 lifecycle, 2-A assets, 2-B fitment, 2-C garage/search, P2-D seller portal) |
| Build | prior phase gate | green (rebuilt at end of P2-D) |

## Current state per P2-E concern

### Authentication / Session
- `poom_sid` cookie (middleware-issued, HttpOnly, SameSite=Lax, 30d) — **guest cart/garage key only, not an identity credential**.
- `poom_uid` cookie (P2-D demo login): HttpOnly cookie holding the **raw User id** — no server-side session record, no expiry record, no revocation, no rotation. `demoLoginAction` verifies phone against `SELLER_LOGIN`/`ADMIN_LOGIN` env values.
- `getAuthenticatedSeller()` (P2-D) resolves cookie→User→Seller; test-mirrors in `seller-auth-test.ts`. **No `requireAdmin()` / `requireCustomer()` helpers yet** — admin pages read data but admin *actions* still use the Phase-1 `assertDemoTrust()` gate (fails closed outside demo mode, has no role check).
- No login rate limiting. No `lastLoginAt`/`status` on User. `User.status` does not exist.

### Payments
- `Payment` model: one row per attempt (id, orderId, provider, amount, status, authority unique, createdAt, updatedAt) — retries already create NEW rows (`retryPayment`). No `attemptNumber`, no `referenceId`, no `idempotencyKey`, no `failureCode/Message`, no `completedAt`.
- `settleMockPayment(authority, outcome)`: verify → amount-integrity check (payment.amount === order.total) → settlement transaction (conditional stock decrement, payment SUCCEEDED, order PAID, SellerOrders CONFIRMED, cart cleared). Replay protection = PENDING-status check only; a second `success` callback for an already-SUCCEEDED payment returns falsy path — needs explicit idempotent semantics. No `SETTLEMENT_FAILED` representation.

### Orders
- Order status enum: `PENDING_PAYMENT/PAID/CANCELLED/FULFILLED`. SellerOrder enum (DB): `PENDING/CONFIRMED/SHIPPED/DELIVERED/CANCELLED/RETURNED`; P2-D added a service-layer workflow map (`CONFIRMED→SHIPPED→DELIVERED`, terminals `DELIVERED/CANCELLED/RETURNED`, row-locked transitions). No Order-level transition function; customer cancellation flow absent; no `Shipment` model (seller order detail shows status only).
- Customer views: `/account/orders` (list with per-seller status labels), `/checkout/result` (per-seller cards). No `/account/orders/[orderId]` detail, no timeline, no return eligibility.

### Returns / Refunds / Shipment
- **None exist.** No ReturnPolicy/ReturnRequest/Refund/Shipment models. `RETURNED` SellerOrder status is reachable from SHIPPED but no lifecycle backs it.

### Governance / Trust
- `Seller.status` default `DEMO_UNVERIFIED` (string); `verified Boolean`, `rating`, `responseRate` — admin-controlled only by convention; no admin UI for seller status; no trust-state derivation for customers (part pages show seller name/rating only).

### Audit
- `SellerEventLog` (P2-D): seller mutations + CSV events, written transactionally. **No auth/commerce/payment/order lifecycle/return events**, no admin audit UI.

### Environment safety
- `.env` local-only (gitignored), `MOCK_PAYMENTS=1`, demo login phones. `.env.example` safe placeholders. No `DEMO_MODE`/`AUTH_MODE`/`PAYMENT_MODE` abstraction; `assertDemoTrust()` is the only guard.

## Decisions recorded (design constraints for this phase)

1. **Sessions**: introduce a server-side `Session` record (id, userId, tokenHash sha256, createdAt/expiresAt, revokedAt, lastSeenAt) with the raw token only in the cookie (HttpOnly, SameSite=Lax, Secure in production). `poom_uid` raw-id cookie is replaced by the session token — guest `poom_sid` stays untouched (cart/garage).
2. **IdentityProvider abstraction** with `DemoIdentityProvider` (env phones, DEMO_MODE) — no real SMS/email.
3. **Payments**: add `PaymentAttempt` fields (attemptNumber, referenceId unique, idempotencyKey, failureCode/Message, completedAt) and explicit idempotent settlement keyed on the Payment row's own state machine + unique authority; keep Phase-1 settlement transaction intact.
4. **Returns**: `ReturnPolicy` (configurable window days, needsLegalVerification flag) + `ReturnRequest` with explicit state machine; eligibility computed from delivery state + policy, not hard-coded prose.
5. **Governance**: Seller.status becomes an enum (`PENDING/ACTIVE/SUSPENDED/REJECTED`) with admin transition map + audit; customer trust derives from `status=ACTIVE` + `verified`.
6. **Rate limiting**: in-memory fixed-window adapter behind a `RateLimiter` interface (login, payment initiate/callback, return submit, CSV import).
