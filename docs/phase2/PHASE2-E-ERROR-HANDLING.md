# P2-E — Error-Handling Audit (§10 of the adversarial brief)

Method: mechanical sweep (`grep` for empty catches, `.catch(() => …)`, `void` async) + manual classification of every hit against the business-criticality rubric. Nothing changed without reading the surrounding flow.

## Classification rubric

| Class | Meaning | Action |
|---|---|---|
| Business-critical failure | A swallowed failure would corrupt money/stock/order state | Must fail loudly / roll back |
| Observability failure | Audit/log write fails; the mutation itself is correct | May degrade, must not break the mutation |
| Cache/revalidation failure | `revalidatePath` hiccup | May degrade |
| Non-critical telemetry | `lastSeenAt` touch, prefetch | Fire-and-forget acceptable |

## Sweep results (all hits classified)

### Acceptable — non-critical telemetry / cache

- `src/lib/auth/session.ts:53` — `void prisma.session.update(lastSeenAt).catch(() => undefined)` — telemetry only; auth resolution is already complete. OK.
- `src/lib/cart.ts:62` — dropping a dead cart line (stock 0) with `.catch(() => {})` — the authoritative `getCartView` already excludes the line; the delete is a convergence nicety. OK.
- `src/app/account/page.tsx:14`, `src/app/page.tsx:12`, `src/app/parts/[slug]/page.tsx:58`, `src/app/layout.tsx:18-19` — `getActiveVehicleContext/getCartView .catch(() => null)` — header/badge decorations; a failure renders the neutral state instead of a 500. OK.
- `src/components/cart-badge.tsx:19,23` — client-side prefetch `.catch(() => {})` — pure UI. OK.
- `src/app/admin/fitment/actions.ts` `safeRevalidate` — documented cache-failure isolation; the mutation result is already committed. OK.
- `src/app/api/seller/inventory/import|export/route.ts` — `req.json().catch(() => null)` then explicit 400. Correct rejection path.

### Business-critical paths verified NOT swallowing

- **Settlement** (`src/lib/checkout.ts`): the transaction either commits fully or throws; the catch records `SETTLEMENT_FAILED`/`ORDER_NOT_PAYABLE` on the attempt + audited event, never a fake success. Verified by tests (`SETTLEMENT_FAILED` semantics + C1 race test).
- **Cancel** (`src/app/account/order-actions.ts`): post-fix, a lost cancel/settle race throws inside the tx and rolls back — the catch only redirects to the (now PAID) order; no partial teardown. Audited.
- **Seller/governance/return transitions**: `P2025/P2034` are mapped to typed domain results; everything else rethrows — no silent 500s, no swallowed corruption.
- **Audit write inside settlement** (`logAuditTx(tx, …)`): intentionally NOT wrapped in its own catch — an audit failure must roll back the settlement (audit completeness is part of the §43 contract). The Phase-1 pool-deadlock fix already made this path safe under concurrency.
- **Login failure audit** (`user_login_failed`): awaited before redirect; if it throws, login fails loudly — acceptable for an auth surface (fail-closed).

### Fixed during this audit

- `cancelCustomerOrder` previously updated the order unconditionally inside the tx; combined with settlement lacking a payable-guard this allowed CANCELLED→PAID resurrection (Critical C1). Both sides now use conditional writes; the loser rolls back. See PHASE2-E-ADVERSARIAL-AUDIT.md.

### Remaining accepted risks

1. `revalidatePath` failures in seller actions are not isolated (`seller/seller-actions.ts`) — a revalidation error would surface as an action error *after* a committed mutation. Cosmetic (data is correct; refresh fixes the view). Left as-is deliberately — wrapping every action in a revalidate-shim adds noise; candidate for a shared `safeRevalidate` helper in P2-F.
2. In-memory rate limiter resets on process restart — abuse damping only, never correctness (documented in SECURITY.md).
