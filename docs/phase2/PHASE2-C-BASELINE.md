# P2-C Baseline — Vehicle Config + Garage + Search (recorded before any P2-C change)

Date: 2026-09-14 · Inspected before any modification. No git history on this machine (file-state baseline).

## Verification at baseline

| Check | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | 0 errors |
| Tests | `vitest run` | **45/45 passed** (4 files: persian, asset-registry, fitment-engine, checkout+cart lifecycle) |
| Migrations | `prisma migrate status` | 6 migrations, "Database schema is up to date!" |
| Build | — | green as of P2-B final report (21 routes, 103 kB shared JS) |

## Current vehicle model (schema.prisma)

- `Vehicle { make, model, displayName, generation?, bodyType String?, active }` — one row: Peugeot 206, `bodyType: "Hatchback"` (free text), generation `NF`.
- `VehicleVariant { vehicleId, trim, engine String?, transmission String?, productionStart?, productionEnd? }` — rows: `تیپ ۲` (TU3 (DEMO), دستی ۵ سرعته, 2002–2012), `تیپ ۵` (TU5 (DEMO), دستی ۵ سرعته, 2003–2015). Years **Gregorian**.
- No `Engine`/`Transmission` entities — engine/transmission are free-text labels on variants (P2-B known limitation; `VehicleContext.engineId/transmissionId` slots already reserved).
- `Fitment.bodyType` is a free-text rule constraint; **0 rows** currently use it.

## Garage state

- `GarageVehicle` table **already exists** (created in migration `20260914_p2a_assets_mesh_garage`): `{ id, sessionId, userId?, variantId (FK cascade), yearFa Int?, plate?, isActive, createdAt, vehicleId? }`, index on `sessionId`. **Zero application code references it** — schema-only today. No one-active guarantee, no `year` (Gregorian) column, no nickname. `yearFa` is unused by any code.

## Session/auth model

- Cookie session: `middleware.ts` issues `poom_sid` (httpOnly, lax, 30d); `getSessionId()` (lib/session.ts) reads/falls back. **No login/auth** — `User` rows exist only for demo orders. Guest context is session-scoped; login-merge is future work (documented).
- Cart/checkout are sessionId-authoritative (server-side).

## Current search behavior

- `searchParts(q, vehicleId?)` in `lib/catalog.ts`: loads up to 200 parts (+includes), ranks **in memory** on `normalizeFa(title+sku+slug+identifiers)`, token-substring scoring, top 40. No vehicle-aware ranking, no fitment states, no compatible-only, no autocomplete, no recent searches, no categories/brands/vehicles grouping.
- `/search` page: text input + flat result cards; zero-result message. No vehicle context.
- Normalization: `normalizeFa` (aggressive text) + `normalizeIdentifier` (conservative) — both in place from P2-B.
- Indexes: `Part.slug` unique, `PartIdentifier @@index([value])`, `Category.parentId`, `Fitment(partId, vehicleId, variantId)` — adequate for the candidate-filtering approach below.

## Vehicle context today

- Part page (`/parts/[slug]`): fitment resolved via **the** engine with context from `?variant=<trim>&year=` URL params, else `poom_variant`/`poom_year` cookies (set nowhere in current code — dead fallback from the 3D-flow era; the 3D flow actually uses `?variant=` links). `vehicle` is hard-coded `make=peugeot,model=206`.
- Header: static text `خودروی من: ۲۰۶` (hard-coded, no real context).

## Current fitment API (authority)

- `resolveFitment(partId, ctx)` — fetches rules per call then resolves in memory. No batched entry point yet (search would N+1 without one).

## Known limitations entering P2-C

1. No saved vehicles/garage UX at all (table idle).
2. Engine/transmission free-text (P2-B limitation #1).
3. Vehicle.bodyType free text; Fitment.bodyType constraint unused.
4. Search is catalog-internal, vehicle-blind, no states, no autocomplete/recents.
5. No analytics events.
6. Persian vs Gregorian year mismatch: variant ranges Gregorian; Iranian users enter Jalali years. P2-C decision recorded in PHASE2-C-VEHICLE-CONFIG.md.
