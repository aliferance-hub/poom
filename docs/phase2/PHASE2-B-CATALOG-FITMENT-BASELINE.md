# P2-B Baseline — Catalog + Fitment (recorded before any P2-B change)

Date: 2026-09-14 · File-state baseline (no git repo on this machine)

## Verification at baseline

| Check | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | 0 errors |
| Tests | `vitest run` | **25/25 passed** — one transient failure of an asset-registry test on the very first run of the session, then 7 consecutive all-green runs; treated as a timing flake and monitored |
| Build | P2-A final build | ✓ (21 routes, 103 kB shared JS) |
| Preview | `http://127.0.0.1:3010` | healthy; 3D viewer + Mapping Studio verified in P2-A |
| DB | PostgreSQL 18.6 @127.0.0.1:5433, db `poom` | 41 parts / 92 offers / 3 sellers / 8 zones / 13 mesh mappings / 82 fitments |

## Current schema (catalog/fitment relevant)

- `Vehicle { make, model, displayName, generation?, bodyType? }` + `@@unique([make, model])`
- `VehicleVariant { vehicleId, trim, engine?, transmission?, productionStart?, productionEnd? }` + unique per vehicle
- `Part { sku, title, slug, technicalDescription?, assemblyId?, condition, authenticityNote?, isDemoData, mainImage?, gallery }`
- `PartIdentifier { partId, type (OEM|MPN|CROSS_REFERENCE|GTIN|BARCODE|SELLER_SKU), value }` + `@@unique([partId, type, value])`
- `Fitment { partId, vehicleId, variantId?, engine?, yearFrom?, yearTo?, fitmentStatus (CONFIRMED|PARTIAL|REJECTED|PENDING_REVIEW), fitmentNote? }` — index `[partId, vehicleId, variantId]` only
- **No Category model. No Brand model. No RelatedPart. No specifications. No transmission/year constraints in Fitment.**

## Current routes

```
/ , /vehicles/peugeot/206 (+ [trim]) , /vehicles/peugeot/206/zone/[key]
/assemblies/[slug] , /parts/[slug] , /search
/cart /checkout* /account/orders
/seller ; /admin /admin/fitment /admin/zones /admin/assets/[assetId]
/api/cart ; api/admin/assets/[assetId]/upload
```

## Current catalog behavior

- `src/lib/catalog.ts`: vehicle+variants lookup, zone/assembly browsing, `getPartBySlug` (includes identifiers+fitments), in-memory `searchParts` (normalizeFa scoring over ≤200 parts), `listVehicles`.
- No category tree anywhere; assembly (3D zone structure) is the only grouping.

## Current fitment behavior

- **There is no Fitment Engine.** Pages read `part.fitments` rows directly and render badges:
  - part page lists fitment rows with `سازگار` for CONFIRMED (no vehicle-context resolution, no precedence, no negative fitment semantics, no explainability).
  - admin `/admin/fitment`: filter by status + a status `<select>` mutation only (no create/edit/variant/engine/year fields).
- `updateFitmentStatusAction` (admin-actions.ts) validates status enum + demo trust gate only.
- Seed: 82 fitment rows, all vehicle-level (variantId mostly null) CONFIRMED/PARTIAL for both trims.

## Known limitations carried into P2-B

1. No category hierarchy → no category navigation/breadcrumbs beyond 3D zone/assembly.
2. Part model lacks structured specs + `dataStatus` presentation; `isDemoData` exists but is barely surfaced.
3. Fitment has no transmission/bodyType/year semantics beyond nullable year columns; no explicit negative-fitment flow; no conflict prevention (DB or app level).
4. No `resolveFitment` service; UI would need to duplicate logic.
5. No RelatedPart structure (part page fakes "related" from same assembly).
6. Fitment admin cannot create/edit rows.
7. Indexing gaps for identifier lookup (`PartIdentifier.value` unindexed), `Fitment.status`, `Part.categoryId` (future), `Category.parentId` (future).

## P2-B plan (per master prompt)

Schema: Category tree, Brand, Part 2.0 (specificationsJson + dataStatus + brandId + categoryId), Fitment v2 (+transmission/bodyType +status semantics +conflict-unique constraint +indexes), RelatedPart. Engine service `resolveFitment(partId, vehicleContext)` with deterministic precedence. Seed upgrade. Part page fitment section. Admin fitment CRUD + moderation queue + /admin/parts /admin/categories /admin/vehicles. Tests A–J + integration + authz. Docs + final report.
