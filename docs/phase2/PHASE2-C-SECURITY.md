# P2-C — Security Notes

Date: 2026-09-14 · Scope: surfaces added in P2-C

## Ownership model

The garage owner key is the **httpOnly session cookie** (`poom_sid`, issued by
middleware / `src/lib/session.ts`). Every garage read/write goes through
`src/lib/vehicle.ts`, which scopes all queries by `sessionId`:

- `findFirst({ id, sessionId })` before any update/activate/delete → foreign
  ids return `NOT_OWNER` (refused, no data echoed).
- `getMyVehicles` / `getActiveVehicleContext` filter `where: { sessionId }`.

There is no client-trusted user id anywhere in the garage path.

## Authorization tests (tests/p2c-garage-search.test.ts)

| Attack | Expected | Status |
|---|---|---|
| Foreign session updates a garage row | `NOT_OWNER` refused | ✓ test |
| Foreign session activates another's vehicle | refused | ✓ test |
| Foreign session deletes another's vehicle | refused | ✓ test |
| 10 parallel activations, 2 vehicles | exactly 1 active, all requests resolve | ✓ test (×10 runs green) |
| Raw-client activate race (app layer bypassed) | unique index refuses 2nd active row; invariant holds | ✓ test |
| Real-DB race spike (25 rounds, external process) | both activations OK, exactly 1 active | ✓ `scripts/spike-garage-race.mts` PASS |
| Fitment mutation from customer/seller path | no such server action exists (admin-actions only, admin guard) | ✓ inherited P2-B |

## Input validation

- All garage mutations validate inputs server-side (`z`od in the API routes'
  service layer): variant must exist (`createSavedVehicle` re-checks the DB),
  year must be an integer in [1300–2100], nickname ≤ 60 chars. UI ids are never
  trusted.
- Service failures propagate: `/api/garage/*` routes set `?error=`
  (`NOT_OWNER`/`NOT_FOUND`/`CONFLICT`/`INVALID`) instead of redirecting as
  success; the garage page renders the corresponding Persian message.
- `back` redirect parameter on `/api/garage/*` is restricted to same-origin
  relative paths (`/^\/(?!\/)[^\\\s]*$/`) — open-redirect safe.

## Search surfaces

- `/search` accepts only `q/vehicle/compat/cat/sort/page`; `vehicle` is
  re-resolved against the DB (`findFirst({ id, active: true })`) — arbitrary ids
  yield a variant-less valid context or nothing, never an error page or an
  injection vector (all Prisma-parameterized).
- `/api/suggest` is read-only, parameterized, rate-bound by dataset size; on
  failure returns `503` rather than leaking stack traces.
- Compatibility cannot be spoofed: `compatibleOnly` filtering happens
  server-side through the Fitment Engine; no query parameter can mark a part
  compatible.

## Analytics

`SearchEvent` stores only: random session id, event type, user-typed query
text, result count, vehicle id. No PII, no IPs, no credentials. Logging is
fire-and-forget (failures swallowed — observability must not break flows).

## Inherited boundaries (unchanged)

- Fitment CRUD remains admin-only via the demo trust boundary
  (`src/lib/demo-trust.ts`, fail-closed outside demo mode).
- Money remains integer IRR server-authoritative; P2-C touched no commerce
  code.

## Honest gaps (pre-existing, NOT introduced by P2-C)

- Real authentication is still the documented TODO(AUTH) (MVP-AUDIT §3).
  The demo trust boundary means admin/seller mutations are unauthenticated *by
  design in demo mode*. Garage is session-scoped and therefore already safe.
- No rate limiting on public endpoints (search/suggest) — acceptable for MVP
  demo scale, revisit before production.
