# P2-B — Catalog 2.0 + Fitment Engine 2.0 (Implementation Notes)

Date: 2026-09-14 · Scope: `poom/` — catalog & fitment milestone. Built **on top of** the verified Phase-1 slice and P2-A asset registry; no architecture replaced.

---

## 1. Objective (as delivered)

> POOM can now answer, deterministically and explainably: **"Is this exact part compatible with this exact vehicle configuration?"** — via a single Fitment Engine, not title matching.

---

## 2. Architecture

```text
Vehicle ── VehicleVariant ── Fitment rules ── Part ── Offer
                │                 │
                │                 └── src/lib/fitment.ts  (the ONLY resolution logic)
                └── src/lib/catalog.ts (categories/parts/identifiers/related)

UI (part page, 3D flow, admin)  →  services  →  Prisma  →  PostgreSQL
```

Hard boundaries preserved:

- **One engine**: `resolveFitment()` in `src/lib/fitment.ts`. The part-detail page, the 3D-flow part page (same route), and admin all show engine verdicts. No compatibility logic exists in any React component, the viewer, or commerce code.
- **No seller authority over fitment**: only `/admin/fitment` actions mutate `Fitment`; seller portal and all customer surfaces are read-only. `assertDemoTrust()` + role check run server-side in every mutation.
- Money untouched: integer IRR everywhere; display-only Toman conversion unchanged.

## 3. Schema changes (migrations)

`20260914_p2b_catalog_fitment`:

- **Category** tree: `parentId` self-relation + `@@index([parentId])`, `slug` unique, `titleFa/descriptionFa/sortOrder/active`.
- **Brand**: `name/slug/logoUrl/active` (replaces free-text brand; demo brands only).
- **Part 2.0**: `dataStatus` enum `DEMO|VERIFIED|UNVERIFIED` (default `DEMO`), `specificationsJson Json?` (per-category spec bag — chose JSON over a normalized spec table: simplest model that avoids a schema per category), `categoryId` + index, `brandId` + index.
- **PartIdentifier**: `@@unique([partId, type, value])` + `@@index([value])`.
- **RelatedPart**: `partId → relatedPartId` with `type RELATED|REPLACEMENT|REQUIRES|OFTEN_PURCHASED_WITH`, `@@unique([partId, relatedPartId, type])` (no reverse duplicates), cascade delete both sides.
- **Fitment 2.0**: optional `variantId`, `engine`, `transmission`, `bodyType` constraints, inclusive `yearFrom/yearTo`, `fitmentStatus CONFIRMED|PARTIAL|REJECTED|PENDING_REVIEW`, `fitmentNote`; indexes `(partId, vehicleId, variantId)`, `fitmentStatus`, `vehicleId`.
- **Conflict guard**: `UNIQUE NULLS NOT DISTINCT (partId, vehicleId, variantId, engine, transmission, bodyType, yearFrom, yearTo)` — the same dimensions cannot carry both COMPATIBLE and INCOMPATIBLE rows. (PG18 syntax; applied via constraint because PG only supports `NULLS NOT DISTINCT` on constraints, not unique indexes.)
- `20260914_p2b_part_active`: `Part.active Boolean @default(true)` + partial-ish filter in queries.

`updatedAt` columns got `DEFAULT now()` backfills in the migration for existing rows.

## 4. Services (`src/lib/`)

| Service | Notes |
|---|---|
| `fitment.ts` | `resolveFitment(partId, ctx)`, `getFitmentForVehicle()`, `FITMENT_FA`, `FITMENT_BADGE`. Rules documented in **PHASE2-B-FITMENT-RULES.md**. |
| `catalog.ts` | `getCategoryTree()`, `getPartsForCategory()` (subtree-aware), `getPartBySlug()` (identifiers + related + specs), `getRelatedParts()`, `getBrands()`, breadcrumbs helper. |
| `persian.ts` | **Two normalization strategies**: `normalizePersianText` (ي→ی، ك→ک, digits, ZWNJ, whitespace) for titles/search; `normalizeIdentifier` (uppercase, unify `-`/`/`/space separators, Persian→ASCII digits, NO letter folding) for OEM/MPN/SKU — so `DEMO-206-001`, `ABC/206`, `MPN 206-01` stay matchable without destroying valid codes. |
| `demo-trust.ts` | extracted (a `"use server"` module may only export async functions). |

## 5. Routes added / changed

| Route | What |
|---|---|
| `/categories/[slug]` | category browsing: subtree children + parts; breadcrumbs; single-segment by design (children render on the parent page, not as deeper URL segments) |
| `/parts/[slug]` | fitment section (engine verdict + Persian explanation + note), breadcrumbs `خانه/دسته/زیر‌دسته/قطعه`, specs table, identifiers, related parts, `اطلاعات نمایشی` badge for DEMO data |
| `/admin/fitment` | CRUD + moderation queue (`PENDING_REVIEW`+`PARTIAL` count badge, filter by status) |
| `/admin/parts` | list/filter/search, activate/deactivate toggle, inspect identifiers+fitment counts |
| `/admin/categories` | tree view |
| `/admin/vehicles` | vehicle/variant inspector (production years, engine/transmission/bodyType labels marked DEMO) |
| `/admin/fitment/actions.ts` | Zod-validated create/update/delete/status actions; year validation `1300–1500` **disabled** (schema uses Gregorian in demo data — see rules doc); create-first + P2002 catch for the unique guard |

Seed (`prisma/seed.mjs`) rewritten: idempotent, hierarchical categories (25), brands (3), identifiers (86, all `DEMO-…` synthetic), related parts (4), and the fitment matrix: 83 CONFIRMED / 2 PARTIAL / 5 REJECTED. Matrix-case parts get their fitments deterministically reset per run.

## 6. Known limitations

- Engine/transmission are **free-text labels on variants** (e.g. `TU5 (DEMO)`), not normalized entities — the engine API already carries `engineId/transmissionId` slots for P2-C.
- Year values are Gregorian in demo data (matching `VehicleVariant.productionStart`); Persian-calendar display is not implemented.
- `dataStatus` is data-level only; per-field provenance (e.g. which spec value is verified) is not modeled.
- Related-part semantics are demo-labeled; nothing implies real interchangeability.
- Category pages are single-segment URLs; nested paths (`/categories/a/b`) 404 by design.
- Search is still Phase-1 text search (identifier index is ready but Search 2.0 is out of scope).
