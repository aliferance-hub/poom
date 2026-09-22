# P2-E — Orders (state machines, shipment, snapshots, timeline)

## Order transitions (§21–22, §49–50)

`canTransitionOrder` (src/lib/commerce/order-state.ts) allows exactly:

```
PENDING_PAYMENT → PAID | CANCELLED
PAID            → PROCESSING | CANCELLED
PROCESSING      → SHIPPED | CANCELLED
SHIPPED         → DELIVERED
DELIVERED       → (terminal; refund via ReturnRequest flow)
CANCELLED       → (terminal)
REFUNDED        → (terminal, set only from return settlement)
```

`canTransitionSellerOrder` allows exactly:

```
CONFIRMED → PROCESSING | CANCELLED
PROCESSING → READY_TO_SHIP | CANCELLED
READY_TO_SHIP → SHIPPED | CANCELLED
SHIPPED → DELIVERED
DELIVERED / CANCELLED → (terminal)
```

Both are pure functions, unit-tested for valid and invalid pairs. Every
transition attempt that hits the DB is guarded by a conditional
`updateMany({ where: { id, status: from } })` so a concurrent writer cannot
slip an invalid state past the check (lost-update safe). Invalid attempts are
audited.

## Shipment (§32–33)

`Shipment` (1–1 SellerOrder): `carrier, trackingCode, shippingMethod,
shippingCostIrr, status, estimatedDeliveryFrom/To, shippedAt, deliveredAt`.
Seller sets READY_TO_SHIP/SHIPPED + tracking via `setSellerOrderShipment` —
ownership (sellerId from session) and state transition are both enforced in
the service; the seller actions file (`src/app/seller/shipment-actions.ts`)
contains no authorization logic of its own beyond calling it. No real carrier.

## Snapshots (§39–41)

Order shipping snapshot is captured at checkout (`shippingName, shippingPhone,
shippingAddress` on Order); editing the address book later cannot rewrite
historical orders. OrderItems snapshot `title, sku, unitPrice, sellerName` —
verified in the P2-E test that renames a part/offer after checkout and asserts
the order detail still shows the original values.

## Customer-facing semantics

- Order detail (`/account/orders/[orderId]`) renders an explicit timeline
  ثبت سفارش → پرداخت → تأیید/آماده‌سازی → ارسال → تحویل with per-seller
  progress for multi-seller orders (§51).
- Result messaging (§52) is driven by DB status: paid ⇒
  «پرداخت با موفقیت انجام شد», PENDING_PAYMENT ⇒ «پرداخت انجام نشد…» — never
  from the callback query param alone.
- Cancellation is only offered for `PENDING_PAYMENT` orders
  (`cancelMyOrder` re-checks state server-side); later stages go through the
  return workflow instead (§49).
