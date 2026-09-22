# Phase 2 — Baseline (recorded before any Phase 2 change)

Date: 2026-09-14 · Commit-less worktree (no git repo on this machine — file state is the baseline)

## Verification at baseline

| Check | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | 0 errors |
| Tests | `vitest run` | **18/18 passed** (2 files) — incl. amount-tamper abort, 8×-parallel settlement exactly-once, cart clearing, retry |
| Build | `npm run build` | ✓ Compiled successfully (dev server was restarted afterwards because a build while `next dev` runs corrupts the dev `.next` cache on Windows — known operational constraint) |
| Preview | `http://127.0.0.1:3010` | HTTP 200; golden path verified at end of Phase 1 (screenshot: 3D 206 renders) |
| DB | PostgreSQL 18.6 portable @127.0.0.1:5433, db `poom` | seeded: 41 parts / 92 offers / 3 sellers / 8 zone mappings / 5 part mappings |

## Route inventory (baseline)

```
/                                   home
/vehicles/peugeot/206               → redirect type-5
/vehicles/peugeot/206/[trim]        3D viewer + zones (type-2 | type-5)
/vehicles/peugeot/206/zone/[key]    zone → assemblies
/assemblies/[slug]                  assembly → parts
/parts/[slug]                       part detail + offers + JSON-LD
/search                             normalized search
/cart /checkout /checkout/mock-pay /checkout/result /account/orders
/seller                             seller panel (demo trust boundary)
/admin /admin/fitment /admin/zones  admin (demo trust boundary)
/api/cart                           cart summary
```

## Known limitations carried into Phase 2 (from MVP-AUDIT.md)

- Auth: demo trust boundary only (`assertDemoTrust`); guest cookie = identity.
- AssetVersion is minimal (no status lifecycle, no license/file metadata, no upload).
- Mappings are global per asset (not per version); no AssemblyMeshMapping; no hotspots/exploded/camera-preset data model beyond zone camera.
- No category tree, no garage, no seller CSV, no shipment model, no analytics events.
- Search is in-memory over ≤200 parts.
- H-1 TOCTOU still open (bounded, no reservation); H-3 partial indexes; H-4 ESLint not installed.

## Phase 1 acceptance flow that must stay green

`/vehicles/peugeot/206/type-5` → 3D zone click → cooling → radiator → offers → cart (multi-seller) → checkout → mock payment → PAID + 2 CONFIRMED SellerOrders → stock decremented → cart cleared → seller panel sees sub-order → admin sees order.

## Phase 2 execution order

P2-A (3D UX + Asset Registry + Mapping Studio) ← current
P2-B … P2-J per master prompt. P2-A must be verified before P2-B starts.
