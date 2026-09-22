# P2-D — Seller Orders

## Visibility & authorization (§24, §27)

`getSellerOrders` / `getSellerOrder` / `updateSellerOrderStatus` all take the **session-derived** sellerId and enforce it in the WHERE clause (detail also takes a `FOR UPDATE` row lock). A foreign `sellerOrderId` is indistinguishable from a nonexistent one (`NOT_FOUND` → 404 in UI). There is no "query all, filter in browser" path.

## State machine (§26)

Entry states come from Phase-1 settlement: `PENDING` (checkout) → `CONFIRMED` (payment success). The seller workflow:

```text
PENDING      → CONFIRMED | CANCELLED
CONFIRMED    → SHIPPED   | CANCELLED
SHIPPED      → DELIVERED | RETURNED
DELIVERED / CANCELLED / RETURNED  → terminal
```

- Transitions are an explicit map (`TRANSITIONS` in `seller-orders.ts`); arbitrary jumps return `INVALID_TRANSITION` with a Persian message.
- `PROCESSING` / `READY_TO_SHIP` are **defined** in `SELLER_WORKFLOW_STATUSES` for the future, but the DB enum migration is deliberately deferred; until then `CONFIRMED → SHIPPED` is the direct path (documented decision, not a silent gap).
- A `CANCELLED` target on a payment-succeeded suborder is refused (`ORDER_NOT_PAID`) — post-payment reversal is the RETURNED flow.
- Payment state itself is never writable by sellers.

## Snapshot immutability (§25, §28–29)

Order detail renders `OrderItem.unitPrice` / `OrderItem.total` — the checkout snapshot. Current `Offer.price` never appears in order views. Test: seller raises the price after checkout → OrderItem still holds the original value (verified in suite + live page note «قیمت لحظه‌ی خرید»).

## Idempotency & side effects (§35, §38)

- Duplicate submit of the same target (`SHIPPED` while `SHIPPED`) → `ok, idempotent: true`, **no** second audit row.
- Concurrent duplicates serialize on the SellerOrder row lock (`FOR UPDATE` — same strategy as the P2-C garage fix): the loser re-reads the committed status and becomes a no-op or a clean `INVALID_TRANSITION`. Exactly one `seller_order_status_changed` audit row per real change (spike: 10/10 rounds with `audit=1`).
- No shipment records exist yet, so there is nothing to duplicate; the audit log is the side-effect surface and it is deduplicated by design.

## Customer integration (§69)

The same SellerOrder rows drive both views: seller detail page (`/seller/orders/[id]`) and the customer's pages (`/account/orders`, `/checkout/result`) now render the suborder status with Persian labels (added in P2-D). Live-verified: seller set `SHIPPED` in the portal → customer order page (own session) shows «ارسال شده».
