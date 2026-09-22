# P2-E — Seller & Admin Governance (§14–20, §18, §42, §47–48)

## Seller status lifecycle

`sellerStatus`: `PENDING → ACTIVE → SUSPENDED → (reactivate) ACTIVE`,
`PENDING → REJECTED`. Only `ACTIVE` sellers may log in to the portal,
mutate offers/inventory, or appear as purchasable offers. Transitions are
pure functions (`canTransitionSellerStatus` in src/lib/governance.ts) and
enforced with conditional updates in the transaction.

- Seller cannot self-verify or change `verified`, `rating`, `sellerStatus`,
  or reputation fields — the seller mutation surface never touches those
  columns (re-checked by the "seller cannot change verified/rating/status"
  test).
- Admin-only: `approveSeller`, `suspendSeller`, `rejectSeller`,
  `reactivateSeller` — each starts from `requireAdmin()` (session ⇒ role
  ADMIN ⇒ user.status ACTIVE) and writes a `seller_status_changed` audit row
  with safe metadata (old → new).

## Admin surfaces

- `/admin/sellers` — list with status filter + search, approve/suspend/
  reject/reactivate actions, per-seller offers & orders counts, links to
  inspect their offers/orders. All mutations are server actions guarded by
  `requireAdmin()`; the page itself also 404s for non-admins.
- `/admin/audit` — AuditEvent stream with filters (action prefix, actor,
  entity). Read-only; secrets never enter AuditEvent metadata (audit.ts
  strips `password|token|secret|authority|cookie` keys defensively).

## Customer-facing trust (§20, §42, §71)

`getOffersForPart` selects seller `verified`, `sellerStatus`, `rating`,
`ordersCount`. The offer card shows «فروشنده تأییدشده ✓» **only** when
`verified === true && sellerStatus === "ACTIVE"` — a verified-but-suspended
seller shows no badge; suspended sellers' offers are excluded from purchase
entirely. Rating is displayed only when `ordersCount > 0` (no fake
"امتیاز" from nothing). No claim is rendered from seller existence alone.

## Suspension semantics

Suspending a seller hides their offers from customer-facing queries
(status ACTIVE filter) but leaves historical orders/payments untouched —
order evidence stays intact (§41).
