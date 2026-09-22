# P2-E — Returns & Refund foundation (§34–38, §61)

## Models

- `ReturnPolicy`: configurable global policy — `returnWindowDays`,
  `allowOpenedItems`, `requiresOriginalPackaging`, `nonReturnableAssemblies[]`,
  `policyTextFa`. Seeded via `prisma/seed-returns-policy.mjs` (defaults flagged
  as needing legal verification — NOT VERIFIED against any jurisdiction).
- `ReturnRequest`: `orderItemId + userId` (ownership snapshot at creation),
  `reason`, `status`, `notes`, timestamps, `refundAmountIrr` snapshot.
  Partial unique index: one open request per order item (states other than
  REJECTED/CANCELLED block a duplicate).

## Eligibility (§36)

`evaluateEligibility` derives a structured verdict from DB state only:

- order must be DELIVERED (or SHIPPED ⇒ NOT_YET_DELIVERED),
- `ReturnPolicy.returnWindowDays` from deliveredAt (fallback updatedAt),
- opened/non-returnable assembly rules,
- an existing open request ⇒ DUPLICATE_REQUEST.

Nothing is hard-coded as "7 days for everything"; the window is data.

## State machine (§35)

```
REQUESTED → UNDER_REVIEW → APPROVED → RECEIVED → REFUND_PENDING → REFUNDED
                     ↘ REJECTED          ↘ REJECTED   ↘ CANCELLED
REQUESTED/UNDER_REVIEW → CANCELLED (customer)
```

`canTransitionReturn` guards every mutation; customer cancel is only valid from
REQUESTED/UNDER_REVIEW; refunds only from APPROVED+RECEIVED. All transitions
audited (`return_created`, `return_state_changed`).

## Refund foundation (§38)

`Refund` row (returnRequestId unique, amountIrr, status
REFUND_PENDING|REFUNDED|REFUND_FAILED, provider placeholders). `markRefunded`
closes the loop: Refund → REFUNDED, ReturnRequest → REFUNDED, Order → REFUNDED
(transition explicitly permitted for terminal-order refund), audited
`refund_state_changed`. No external gateway call — the real integration is a
future adapter.

## Ownership (§61)

`createReturnRequest` resolves the user from the session and asserts the
orderItem belongs to one of that user's orders; the "user A requests on user
B's item" and "duplicate request" paths are covered in
`p2e-production-hardening.test.ts`.
