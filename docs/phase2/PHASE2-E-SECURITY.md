# P2-E — Security (identity, ownership, IDOR, attacks, environment)

## Identity boundary (§5, §12)

- Session: opaque 32-byte random token; only its SHA-256 hash is stored
  (`Session.tokenHash @unique`), the raw token lives solely in an HttpOnly,
  SameSite=Lax cookie (`poom_session`), Secure when NODE_ENV=production.
  Expiry `expiresAt` (7d) is checked on every resolve; logout sets `revokedAt`
  and clears the cookie; expired/revoked sessions resolve to unauthenticated.
- The legacy `poom_uid` cookie (raw user id) was removed from the login
  actions — identity is never a client-supplied id anymore.
- `DEMO_MODE` guard: `getEnvConfig()` rejects `NODE_ENV=production` with
  `DEMO_MODE=true` (throws at config load), demo login is additionally
  restricted to `NODE_ENV !== "production"`.

## Role guards (§14–16)

`requireAdmin()`, `requireSeller()`, `requireCustomer()` in
src/lib/auth/identity.ts — each: session → user → `role` → `status ACTIVE`.
`getAuthenticatedSeller()` additionally resolves the Seller row and requires
`sellerStatus === "ACTIVE"` before any portal mutation. Guard placement:
server actions + route handlers only; no page is trusted because it renders.

## Ownership matrix (verified by p2e-production-hardening.test.ts)

| Actor → object | Result |
|---|---|
| Seller A → Seller B offer (price/stock/active) | DENY (404/not-found) |
| Seller A → Seller B SellerOrder (status/shipment) | DENY |
| Seller A → Seller B inventory | DENY |
| Customer → seller offer mutation | DENY (role) |
| Seller → fitment / catalog / 3D mapping mutation | DENY (role) |
| Customer A → Customer B order detail | DENY (ownership query, not post-hoc check) |
| Customer A → return on B's order item | DENY |
| Guest (no session) → any account/seller mutation | DENY |
| Customer → admin actions | DENY |

Ownership queries filter by the session-derived principal
(`userId`/`sellerId`) inside the same `findUnique`/`findFirst` — no
`findUnique({id})` then UI-level check (§17).

## Payment attack coverage (§59)

- amount tampering ⇒ `AMOUNT_MISMATCH` (server re-reads both rows),
- order/payment id mismatch / cross-order callback ⇒ `ORDER_MISMATCH`,
- duplicate success callback ⇒ idempotent `ALREADY_SETTLED` (no double
  settlement — Phase-1 spike still green),
- success on FAILED attempt ⇒ `ATTEMPT_FAILED`,
- settlement failure ⇒ attempt stays FAILED (`SETTLEMENT_FAILED`),
  order retryable; never fake-paid.

## Rate limits (§44)

In-memory sliding-window limiter (`src/lib/auth/rate-limit.ts`) wired on:
login (5/min per IP+phone), payment initiation, return submission. Provider
agnostic interface — a Redis adapter can replace it without touching
call-sites. Distributed limitation: per-instance only (documented in §Limitations).

## Mutation validation (§45–46)

All P2-E mutations use zod schemas (login, shipment, returns, admin
governance, customer cancel). Mutations are POST server-actions/POST routes;
no state change on GET. Session cookie is SameSite=Lax (CSRF posture per
Next.js server-action defaults; no custom CSRF layer added — documented
decision).

## Environment safety (§54, §78)

- `.env` is gitignored (verified); `.env.example` holds placeholders only —
  no credentials. No real gateway/SMS keys anywhere (mock providers only).
- `DATABASE_URL` points at the local portable PG (127.0.0.1:5433).
- Data-quality guards: demo seeds isolated under demo sessions/skus;
  `DEMO_MODE` cannot silently masquerade as production (config guard above).
