# P2-D — Security

## Identity & trust model

- Login is demo-mode (env-verified phone → `poom_uid` HttpOnly cookie), but the **authorization contract is production-shaped**: identity is resolved server-side on every request; `sellerId` is never accepted from the browser; every mutation re-checks ownership inside its transaction (row lock or scoped WHERE).
- `getAuthenticatedSeller()` fails closed: guest / CUSTOMER / ADMIN / unpaired-User all yield `null` → redirect or 404. Admin has a separate resolver (`getAuthenticatedAdmin`); admin actions can never impersonate seller ownership.
- The Phase-1 `assertDemoTrust()` gate on admin actions remains; the old public `/seller` is preserved as `/seller-demo` with **no mutation authority over the portal** (its Phase-1 inline editor action still carries the `TODO(AUTH)` and is admin/demo-surface, not the portal).

## Isolation matrix (verified: suite + live IDOR probes)

| From → To | Result |
|---|---|
| Seller A → own offer edit | ✅ ALLOW (persisted) |
| Seller A → Seller B offer | ❌ `NOT_FOUND`, B untouched |
| Seller A → Seller B SellerOrder read/status | ❌ `NOT_FOUND`, status unchanged |
| Guest session (no login) → portal pages | ❌ 307 → `/login` |
| Guest → CSV import PUT | ❌ `{error: دسترسی فروشنده یافت نشد}` |
| Guest → CSV export | ❌ 404 |
| Seller role → admin fitment/catalog/3D actions | ❌ (admin resolver rejects; no seller service writes those models — test-asserted) |
| Seller profile form → `verified/rating/status` | ❌ Zod whitelist drops them; values unchanged in DB (test) |
| CSV row with foreign SKU | ❌ INVALID row; commit refused all-or-nothing |

## Tampering (§41–42)

- Price: integer IRR only (`int`, `> 0`, `≤ 9×10¹²`); floats/negatives/huge values rejected server-side (Zod, not just UI).
- Stock: integer `≥ 0`; stock mutation paths are the portal services and settlement decrement only.
- Historical prices: `OrderItem` snapshots immutable; no seller path touches `Order`/`Payment` (amount tampering protection from Phase 1 re-tested green).

## .env safety (§ of the gate)

- `.env` is gitignored (`.gitignore` lines 4–5: `.env`, `.env*.local`) — the P2-D keys (`SELLER_LOGIN`, `ADMIN_LOGIN`) are demo placeholders, not credentials.
- `.env.example` created with safe placeholders only; `DATABASE_URL` points at the local portable PG (`127.0.0.1:5433`). No real/external secrets anywhere; values are never printed in logs or reports.

## Audit logging (§34)

`SellerEventLog` rows are written **inside the same transaction** as each mutation: price/stock/SKU/shipping/status changes, CSV start/import/reject, profile update — with actor, entity, ids, and safe `meta` deltas only (no secrets, no customer PII, no payment data). Admin oversight of seller data continues to work through the existing admin pages without weakening seller isolation.
