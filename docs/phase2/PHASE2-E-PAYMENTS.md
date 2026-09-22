# P2-E — Payments (attempts, verification, idempotency)

## PaymentAttempt ledger (§23)

Each attempt is an immutable row (`PaymentAttempt`): `paymentId`,
`attemptNumber`, `provider`, `amountIrr`, `authority` (unique), `idempotencyKey`,
`status PENDING|SUCCEEDED|FAILED`, `referenceId`, `failureCode`,
`failureMessage`, `createdAt`, `completedAt`. Historical attempts are never
overwritten — a retry creates a new row, and `attemptNumber` is derived
server-side.

## Amount authority (§24–25)

- Amount recorded at creation = server-computed order total.
- Verification (before settlement) re-reads both rows and rejects on
  `payment.amount !== order.total` → `AMOUNT_MISMATCH` (audited). A tampered
  Payment row is inert — proven by `checkout-lifecycle.test.ts` and the P2-E
  "amount mismatch" test.
- The mock adapter does not verify a cryptographic signature (nothing to
  verify in mock); the verify hook is the seam where the real adapter must do
  it (`src/lib/payments.ts` note).

## Duplicate callback / replay (§26)

- Success replay after settlement: the claim `updateMany … WHERE status =
  'PENDING'` affects 0 rows → no stock decrement, no second order, no second
  cart clearing, no duplicate audit. Returns
  `{ ok:false, idempotent:true, reason:"ALREADY_SETTLED" }`.
- The adapter's `verifyPayment` treats a success callback for an
  already-SUCCEEDED payment as `ok` (gateway semantics), but the commerce
  layer short-circuits — settlement itself can run at most once, enforced by
  the claim inside the transaction.
- Failure replay for a FAILED attempt: no-op (attempt is not re-mutated).

## Retry & failed payments (§27, §52)

- Failure path marks the attempt FAILED (with `failureCode`) and the payment
  FAILED only if it was PENDING; the order stays `PENDING_PAYMENT` and is
  retryable via `retryPayment` (new attempt, new authority).
- A success callback arriving for a FAILED attempt is rejected
  (`ATTEMPT_FAILED`) — old attempts are never resurrected.

## Settlement-failure representation (§29)

If the settlement transaction throws (e.g. `STOCK_CONFLICT`), the attempt is
updated with `failureCode = "SETTLEMENT_FAILED"` (never SUCCEEDED), the order
stays `PENDING_PAYMENT`, and a `settlement_failed` audit event is recorded.
The customer-facing result page reads the **DB order status**, so it will show
"پرداخت انجام نشد. می‌توانید دوباره تلاش کنید." — no fake success. The
`settlement_started` / `settlement_completed` / `settlement_failed` events
give the auditable trail for an external-payment-success-but-settlement-failed
case.

## Provider-agnostic boundary (§55–56)

`PaymentService` interface (create/verify/getStatus) → `MockPaymentAdapter`
today; a real gateway is a new adapter. Commerce code calls
`paymentService()` only — no provider SDK anywhere in UI/actions.
