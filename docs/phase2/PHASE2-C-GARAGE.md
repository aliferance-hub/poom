# P2-C — Vehicle Garage

Date: 2026-09-14 · Status: implemented + verified

## Concurrency strategy (revised 2026-09-15 — race fix)

**Invariant:** for a given session, at most one `GarageVehicle` may be active,
**at any instant**, including mid-transaction under concurrent requests.

Two layers enforce it:

1. **DB backstop** — partial unique index
   `GarageVehicle_one_active_per_session` (`UNIQUE ("sessionId") WHERE
   "isActive"`). Even if the application layer is bypassed (raw SQL, two
   connections), a second active row is *impossible*: the insert/update that
   would create it is refused. Proven by test `DB backstop: unlocked
   concurrent activate can never produce 2 active (index refuses)`.
2. **Application serialization** — a **session-scoped advisory lock** taken as
   the FIRST statement of the mutation transaction:
   `SELECT pg_advisory_xact_lock(hashtext($1)) IS NULL` where the key is
   `poom_garage:<sessionId>`. Concurrent mutations of ONE user's garage
   queue behind the lock; other sessions are never blocked (no global lock).

### Root causes found in the original implementation

1. `pg_advisory_xact_lock('hashtext(...)')` bound the whole expression as a
   **text** parameter → PG error `22P02` on every activation (no text overload
   of the lock function). Fix: server-side `hashtext(${bind})` evaluated in the
   query.
2. Prisma cannot deserialize a **void**-returning column (the lock fn's
   result) → `Failed to deserialize column of type 'void'`. Fix: coerce to a
   boolean expression with `IS NULL` (canonical Prisma advisory-lock form).
3. `createSavedVehicle` read the garage **count outside any lock** — two
   concurrent first-adds both saw `count = 0` and both attempted to activate.
   Fix: count + create now run inside the same locked transaction; the index
   rejects the impossible loser with `P2002` → surfaced as `CONFLICT`.
4. The API routes **ignored the service result** — failures (including the
   22P02 crash above) redirected as success. Fix: every route now propagates
   `NOT_OWNER / NOT_FOUND / CONFLICT / INVALID` as `?error=` and the garage
   page renders a Persian message.

### Why READ COMMITTED, not SERIALIZABLE

An interim attempt used `SERIALIZABLE`. With SSI, a waiter's snapshot freezes
at the advisory-lock SELECT — **before the winner commits** — so every wake-up
ran on a stale snapshot, SSI flagged read-write dependencies and raised
`P2034` ("write conflict or deadlock"); under 10-way contention 5 retries
still failed. Under the advisory lock, writers are strictly serialized and
READ COMMITTED's per-statement fresh snapshots make such conflicts
structurally impossible — verified empirically.

### Retry policy

`withGarageLock` still retries on transient `P2034` / SQLSTATE `40001` /
`40P01` (5 attempts, lock re-acquired each attempt) as belt-and-braces for
future writers that share the same lock key.

### Proof

- `tests/p2c-garage-search.test.ts`:
  - 10 parallel `activateSavedVehicle` across 2 vehicles → all resolve, **1
    active** (×10 consecutive full-suite runs: **10/10 PASS**).
  - Unlocked raw-client race → rejections are unique-index refusals only,
    **1 active** (invariant holds even without the app layer).
- `scripts/spike-garage-race.mts` (real DB, outside app): 25 rounds of
  concurrent activate(A)+activate(B) → 25/25 rounds both OK, exactly 1 active,
  0 errors → **GARAGE RACE SPIKE PASS**.

## Data model

`GarageVehicle` (table existed since P2-A, unused until P2-C):

```prisma
model GarageVehicle {
  id        String
  sessionId String          // owner key (guest-safe)
  userId    String?         // reserved for future real auth
  vehicleId String?         // denormalized from variant
  variantId String → VehicleVariant (Cascade)
  year      Int?            // Gregorian build year, user-entered
  yearFa    Int?            // legacy Jalali display
  nickname  String?
  plate     String?         // DEMO only, never required
  isActive  Boolean         // ≤ 1 true per session (enforced below)
  createdAt / updatedAt
  @@index([sessionId]) @@index([userId])
}
```

## Service layer (`src/lib/vehicle.ts`)

All ownership checks are **server-side by sessionId** — a garage row is only
ever touched through `findFirst({ id, sessionId })`; a foreign id resolves to
`NOT_OWNER` and the mutation is refused (no leak, no error page).

| Operation | Guarantee |
|---|---|
| `createSavedVehicle` | validates variant exists; duplicate (variant, year, nickname) is idempotent; **first vehicle auto-activates** — count+create run under the session lock; index-refused races surface as `CONFLICT` |
| `activateSavedVehicle` | ownership pre-check → locked transaction: `updateMany({isActive:false})` then `update({isActive:true})` → **exactly one active**, serialized per session by advisory lock + unique-index backstop |
| `updateSavedVehicle` | year/nickname only; ownership enforced |
| `deleteSavedVehicle` | ownership enforced; deleting the active vehicle leaves none active |
| `getActiveVehicleContext` | resolves the active row into the shared `VehicleContext` |

## Transport

- **API form endpoints** (`/api/garage/add|activate|delete`, POST + 303
  redirect) — work from plain `<form method="post">` without JS; `back`
  parameter is guarded against open redirects (relative same-origin only).
- A `"use server"` actions file was removed in favor of these routes; the
  quick-select path reuses `/api/garage/add` + activate-on-add flag.

## UX

- `/account/garage` — خودروهای من: cards with فعال badge, add form (variant
  dropdown shows engine/transmission labels), year + nickname inputs.
- Header (all pages): `خودروی من: پژو ۲۰۶ تیپ ۵ ۲۰۱۰` or
  `خودروی خود را انتخاب کنید` → links to garage.
- Search + part pages read the active context automatically; the user can
  always change or remove vehicles (never trapped).

## Guest → account migration (documented strategy, not implemented)

The session cookie is the owner key, so a guest's garage survives login without
migration **as long as login keeps the same session id** (Phase 1 behavior).
When real user accounts land (TODO(AUTH) in demo-trust.ts), `userId` is already
modeled; the merge strategy should be: on first authenticated request with a
session that owns garage rows, attach them to `userId` (single UPDATE), keep
the newest active row, drop duplicates by (variantId, year).

## Security

- Cross-session access is tested: update/activate/delete from a foreign
  session all fail with `NOT_OWNER`.
- No client-trusted ids: variantId is re-validated server-side on create.
- Activation concurrency: 10 parallel activations → exactly 1 active (test);
  raw-client bypass race still cannot produce 2 active (index backstop test);
  25-round real-DB spike PASS (`scripts/spike-garage-race.mts`).
- Service failures are never swallowed: `/api/garage/*` propagate `?error=`
  and the garage page shows a Persian message.
