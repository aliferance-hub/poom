# P2-E — Commerce Hardening (checkout, order totals, snapshots)

## Server-authoritative totals (§24)

`createCheckout` (`src/lib/checkout.ts`) computes the order total **only** from
`getCartView()` — which reads current Offer prices from the DB. No `amount`,
`total`, `shipping`, or `discount` value is ever accepted from the browser.
The Payment row amount is the same server-computed value; settlement
re-asserts `payment.amount === order.total` before touching stock.

## State machine (explicit)

```
CART → validate → ORDER: PENDING_PAYMENT + PAYMENT: PENDING (+ PaymentAttempt: PENDING)
     → gateway success → settlement tx:
         claim attempt (updateMany … status: PENDING → SUCCEEDED)
         → conditional stock decrement (stock >= qty, per item, inside tx)
         → PAYMENT: SUCCEEDED → ORDER: PAID → SellerOrders: CONFIRMED
         → cart emptied (claimed attempt guarantees exactly once)
     → gateway failure → PAYMENT: FAILED (attempt FAILED, order retryable)
```

- `canTransitionOrder` / `canTransitionSellerOrder` (`src/lib/audit.ts`) gate
  every status mutation; terminal states (`DELIVERED`/`CANCELLED`/`RETURNED`,
  `FULFILLED`/`CANCELLED`) have no outgoing edges (§22).
- Customer cancellation is permitted only in `PENDING_PAYMENT` (§49); seller
  cancellation only via the SellerOrder map (P2-D hardening retained).

## Retry (§27)

`retryPayment(orderNumber)` refuses non-`PENDING_PAYMENT` orders and creates a
**new** Payment row + PaymentAttempt with a fresh authority. Old FAILED
attempts are never mutated into success.

## Snapshots (§39–41)

- `OrderItem.unitPrice/total` are copied at checkout — later offer price or
  SKU edits do not rewrite history (P2-D tests re-verify this each run).
- Order shipping references the buyer's address snapshot fields on the Order,
  not a mutable FK presentation.

## Concurrency invariants (re-proven)

- `scripts/spike-concurrency.mts` — 8 parallel `settleMockPayment` on one
  authority: **exactly 1** `ok:true`, stock decremented once, cart cleared
  once, order PAID. 10/10 consecutive PASS after the P2-E audit fix.
- The loser/replay path returns `{ ok:false, idempotent:true,
  reason:"ALREADY_SETTLED" }` — the caller renders the DB state
  (`/checkout/result` renders strictly from `order.status`), never a fabricated
  outcome (§52).
- Settlement audit rows are written with the **same transaction client** (`tx`)
  — using the global client inside the tx caused a pool deadlock at 8 parallel
  settlements (fixed in P2-E; see FINAL-REPORT).
