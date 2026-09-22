# P2-B Final Report — Catalog 2.0 + Fitment Engine 2.0

Date: 2026-09-14 · Method: source implementation + 45 automated tests + live Preview walk (rendered behavior, not status codes) + production build. Nothing below is claimed without evidence; unverified items are labeled.

---

## Executive Summary

P2-B is **complete and verified**. POOM now answers *"does this exact part fit this exact vehicle configuration?"* deterministically and explainably through a single Fitment Engine (`src/lib/fitment.ts`), backed by an explicit catalog (category tree, brands, identifiers, related parts) and an admin moderation surface. The Phase-1 golden path and P2-A 3D flow are preserved end-to-end (the 3D part panel uses the same engine — verified live).

**Quality gate: tsc 0 errors · 45/45 tests · production build green · all routes 200 · preview console clean.**

## Catalog Changes

- Category hierarchy: 25 categories in a real tree (`parentId`), browsable at `/categories/[slug]`, breadcrumbs on part pages.
- Part 2.0: `dataStatus (DEMO|VERIFIED|UNVERIFIED)`, `specificationsJson` per-category spec bag, `active` toggle, `Brand` relation, structured `PartIdentifier`s (86 rows, all clearly synthetic `DEMO-…`), `RelatedPart` (4 demo rows, typed RELATED/REPLACEMENT/…).
- Seed rewritten to be idempotent and matrix-driven; existing Phase-1 data (parts, offers, sellers, zones, 3D mappings) intact.

## Fitment Engine

- `resolveFitment(partId, ctx)` with 6-level specificity precedence, explicit negative-fitment override, optional engine/transmission/bodyType constraints, inclusive open-ended year ranges, nesting-based conflict resolution, and `CONFLICTING_RULES` escalation.
- Status mapping: CONFIRMED→COMPATIBLE, PARTIAL/PENDING_REVIEW→REVIEW_REQUIRED, REJECTED→INCOMPATIBLE, no-rule→REVIEW_REQUIRED (uncertainty is never downgraded).
- Persian explanation (`reasonFa`) + note surfaced on the part page for all three verdicts.

## Schema Changes

Migrations `20260914_p2b_catalog_fitment` (tree/brand/part2.0/identifiers/related/fitment2.0 + indexes + `UNIQUE NULLS NOT DISTINCT` conflict guard) and `20260914_p2b_part_active`. Money model untouched (integer IRR).

## Admin Changes

`/admin/fitment` CRUD with Zod validation + moderation queue (`PENDING_REVIEW`+`PARTIAL` badge, status filter); `/admin/parts` (search, activate/deactivate), `/admin/categories` (tree), `/admin/vehicles` (variant inspector). `assertDemoTrust` extracted to `src/lib/demo-trust.ts` (`"use server"` modules may only export async functions).

## UI Changes

`/parts/[slug]`: fitment section with live engine verdict, breadcrumbs, specs, identifiers, related parts, demo-data badge. `/categories/[slug]`: new category browsing page. All new surfaces RTL/Persian.

## Test Results

**45/45 passed** (baseline 25 → +20). New: `tests/fitment-engine.test.ts` matrix cases A–J + K/L/M (nested negative, span retry, non-nested conflict); extended lifecycle tests: fitment CRUD authorization, seller-cannot-mutate-fitment, customer-cannot-mutate-fitment, 3D-flow-part uses the same engine, conflicting-rule handling, P2002 on the DB guard.

## Regression Results

- `npx tsc --noEmit` → 0 errors (strict, `noUncheckedIndexedAccess`).
- `vitest run` → 45/45 (two consecutive runs after the last engine fix).
- `npm run build` → ✓ all 21 routes, 103 kB shared JS (dev server stopped first per run.md).
- Live smoke: `/`, `/categories/*`, `/parts/radiator-206`, `/parts/demo-part-002`, `/parts/brake-pad-front-206`, `/admin/fitment`, `/admin/parts`, `/admin/categories`, `/admin/vehicles`, `/search`, `/cart`, `/api/cart` → all **200**; `preview_logs` → no console errors.

## Security Results

- Fitment mutations: admin-only, server-side (role check + `assertDemoTrust` in every action); tested negative for seller and customer.
- All fitment inputs Zod-validated server-side (ids, year ordering `from ≤ to`, status enum, variant belongs to vehicle).
- No compatibility logic client-side; engine runs only on the server.
- Demo identifiers are never presented as OEM (DEMO labeling + `اطلاعات نمایشی` badge).

## Performance Results

- Fitment resolution is a single indexed query (`(partId, vehicleId, variantId)`) + in-memory resolution; part page does fixed query counts (no N+1: related parts and identifiers are batched includes).
- Part page First Load JS unchanged vs P2-A baseline (103 kB shared); new pages are server-rendered with no new client bundles beyond shared.
- No Lighthouse run performed — **NOT VERIFIED** (not claimed).

## Known Limitations

1. Engine/transmission are free-text variant labels (demo), not normalized entities — `engineId/transmissionId` slots exist in `VehicleContext` for P2-C.
2. Gregorian years in demo data; Persian-calendar display deferred (documented in rules doc).
3. `dataStatus` is part-level, not per-field provenance.
4. Category URLs are single-segment (nested segments 404 by design).
5. Search 2.0 / autocomplete, Vehicle Garage, bulk CSV, VIN decoder — out of scope, not built.
6. One transient vitest flake observed at session start (1 run of 8); 7 consecutive all-green runs followed — monitored, not reproduced.

## Recommended P2-C

1. Normalize `Engine`/`Transmission` entities + wire `engineId` into the engine precedence table (levels already reserved).
2. Persian year picker with one central calendar conversion + verified production-year data.
3. Search 2.0 on the identifier index (`@@index([value])` is ready).
4. Vehicle Garage (per-user saved vehicles feeding `VehicleContext`).

---

## Definition of Done — checked

- [x] Category hierarchy works (browsed live, 25 nodes)
- [x] Richer part details / identifiers / related parts / breadcrumbs
- [x] Dedicated Fitment Engine, explicit states, deterministic precedence, negative fitment, year ranges, optional constraints, conflict handling, explainable result, admin moderation
- [x] Seller cannot modify fitment (tested) · Customer cannot modify fitment (tested) · Admin authorization works (tested)
- [x] TypeScript clean · all tests green · build green · regression green · Preview verified · no runtime errors
- [x] Architecture + fitment rules + final report documented
