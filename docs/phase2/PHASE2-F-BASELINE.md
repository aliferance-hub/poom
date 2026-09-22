# P2-F — Baseline / No-Regression Gate (F0)

Date: 2026-09-20 · Recorded before any P2-F change. Machine had restarted since P2-E, so the environment (PostgreSQL, dev server) was restored from `.freebuff/run.md` first.

## Environment restoration (this session)

1. `scripts/pg-start.ps1` initially blocked by Windows PowerShell execution policy → run with `-ExecutionPolicy Bypass` (run.md updated).
2. PostgreSQL first refused connections with `57P03 the database system is starting up` — crash recovery from the unclean OS shutdown; resolved itself after ~30 s. (No full logoff/reboot was needed this time; the run.md note about the DSM bug did not trigger.)
3. Dev server started detached via `scripts/start-dev.cmd` (pid 3536), HTTP 200 on port 3010, Preview re-registered.

## Baseline verification results

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | 0 errors |
| Full suite | `npx vitest run` | **112/112 passed** (8 files) |
| Settlement spike ×10 | `npx tsx scripts/spike-concurrency.mts` | PASS — exactly 1 settled, stock exact |
| Garage activation race | `npx tsx scripts/spike-garage-race.mts` | PASS — exactly 1 active |
| Seller concurrency | `npx tsx scripts/spike-seller-concurrency.mts` | PASS — 10/10 rounds |
| Cancel-attack probe (C1) | `npx tsx scripts/probe-cancel-pay.mts` | `CANCEL_ATTACK: SAFE` (`ORDER_NOT_PAYABLE`, stock untouched) |
| IDOR probes | `probe-or-idor.mts` / `probe-or-idor2.mts` | `GUEST_IDOR: SAFE` / `USER_IDOR: SAFE` |
| Production build | `npm run build` | green (dev server stopped first per runbook, restarted after) |
| Preview | registered `http://127.0.0.1:3010/` | HTTP 200, renders |

**P2-E is green. No unexplained regressions. P2-F work may begin.**

## Current schema & migration state

- Single linear migration history under `prisma/migrations/` (latest: `20260916_p2e_production_hardening`). All later phases hand-apply DDL via `scripts/apply-sql-file.mjs` and keep `migration.sql` in sync (P2-C/D/E pattern).
- Key models for P2-F (read in full from `prisma/schema.prisma`):
  - `DataStatus` enum: `DEMO | VERIFIED | UNVERIFIED` (catalog-wide provenance flag).
  - `Part`: no seller-owned fields; provenance via `dataStatus` + `specificationsJson`; identity via `sku` (unique), `slug` (unique), `PartIdentifier` (OEM/MPN/CROSS_REFERENCE/GTIN/BARCODE/SELLER_SKU, unique per part+type+value).
  - `Fitment`: separate table (part×vehicle×variant + engine/transmission/bodyType/yearFrom/yearTo constraints, `FitmentStatus`, NULLS-NOT-DISTINCT conflict guard).
  - `Asset` (`assetId` unique, `source`, `licenseNote`) → `AssetVersion` (unique per asset+version, `status` DRAFT/PROCESSING/READY/ACTIVE/ARCHIVED/REJECTED, `filePath`/`fileUrl`, `checksumSha256`, **licensing metadata already present**: `licenseType`, `licenseUrl`, `sourceUrl`, `creator`, `attributionText`, `commercialUse`) → `MeshMapping` (unique per version+meshName, targets exactly one of zone/assembly/part, camera/hotspot/exploded JSON).
  - Import pipeline: **does not exist yet** (F5 will add `CatalogImportBatch/Row`).

## Current 3D architecture (verified from code + DB)

- Services: `src/lib/asset-registry.ts` (create/activate/rollback versions), `src/lib/registry3d.ts` (version-scoped mapping resolution with fallback), Mapping Studio `src/components/studio/mapping-studio.tsx` + `src/app/studio-actions.ts` (admin-gated since P2-E H2 fix), upload route `src/app/api/admin/assets/[assetId]/upload/route.ts` (admin-gated, 400 on bad input).
- Flow: Vehicle → Asset → ACTIVE AssetVersion → MeshMapping(kind zone|assembly|part) → VehicleZone/Assembly/Part → Fitment → Offer. No 3D→price/stock/seller coupling anywhere (grep-verified in P2-E audit).

## Current 206 vehicle configuration (DB)

- Vehicle: Peugeot 206 (slug `peugeot-206`), 2 variants (تیپ ۲ / تیپ ۵) with engine+transmission refs.
- 8 `VehicleZone` (engine, cooling, braking, suspension, body, interior, electrical, transmission) × 1 assembly each; zone keys are the stable semantic IDs.

## Current catalog / asset state (DB counts)

| Table | Count | Notes |
|---|---|---|
| Asset | 1 | `peugeot-206-main-v1`, source `DEMO_PRIMITIVES` |
| AssetVersion | 1 | v1, `filePath: builtin:placeholder-206`, no licensing fields set (nothing to claim) |
| MeshMapping | 13 | version-scoped zone/assembly/part mappings |
| Part | 43 | incl. test fixtures (`test-conc-r/p`); all `dataStatus=DEMO` |
| Offer | 94 | across 4 sellers (3 demo + audit system seller) |
| Category / Brand | 25 / 3 | demo taxonomy |
| Fitment | 90 | demo matrix |
| Zone / Assembly | 8 / 8 | stable keys |

## Synthetic / demo data boundaries

- Everything in the catalog today is `dataStatus=DEMO` and must remain visibly labeled; P2-F will never relabel demo data as real.
- Sellers are synthetic (`DEMO_UNVERIFIED` legacy string + governed `sellerStatus`); no real sellers will be invented in P2-F (F6 is readiness only).
- Orders/payments/returns/audit rows are test artifacts; P2-F does not touch historical commerce data (immutable snapshots preserved).

## Known P2-F entry risks (carried deliberately)

1. No licensed real 206 GLB exists in the repo → F1 must build the pipeline + verify with an honestly-labeled in-house asset and document exact real-asset requirements. No fabricated licenses.
2. No licensed parts-data source (TecDoc-style) is available offline → F3 will verify a seed set through public sources with per-row provenance, and document the scale-out path rather than mass-importing unverifiable rows.
3. Portable PG 18.6 DSM instability after long uptime (run.md note) — spikes re-run before final gate.
