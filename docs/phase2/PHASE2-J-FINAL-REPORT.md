# P2-J — FINAL REPORT

Phase: Real 206 GLB + Asset Validation + Storage + 3D Mapping
Date: 2026-09-27 · Commits on `main`: `ca34f7c` (P2-J), `981f7f9` (test determinism fix) — CI green on `981f7f9`
Scope guard: no P2-K work, no auth/payment/seller-onboarding, no catalog expansion, no VIN/AI/AR/mobile, no UI redesign. No synthetic asset was relabelled as real.

## P2-J STATUS: BLOCKED

Single external blocker: **no rights-documented Peugeot 206 file ever reached the
pipeline.** `poom/.freebuff/asset-inbox/` is still empty (`inbox` command confirms).
Every real-asset gate that requires a file is therefore unexercised, and the
honest answer to "is there a real 206 in the viewer?" is **no** — the viewer says
so itself, on production.

## Flags

| Flag | State | Evidence |
| --- | --- | --- |
| REAL GLB | **NO** | No file was downloaded or delivered; inbox empty; candidates C1–C4 documented but not obtained (download requires a logged-in Sketchfab account — see PHASE2-J-ASSET-SOURCE-REPORT.md) |
| LICENSE VERIFIED | **NO** (for a real asset) | License review machinery implemented and probed (allowlist, NC/ND/editorial/Free-Standard refusal); no real record exists to verify |
| PROVENANCE | **IMPLEMENTED, NOT EXERCISED ON A REAL ASSET** | `provenance.ts` + registry derive size/sha from bytes (caller cannot claim a checksum); 16 provenance probes pass |
| TECHNICAL | **IMPLEMENTED, NO REAL FILE AUDITED** | `glb/structure/inventory/compare`; 43 validation tests; hostile inputs refused (P1–P10) |
| SECURITY | **VERIFIED (no findings on the code paths)** | 27/27 adversarial probes; rejected artifacts are never uploaded; keys immutable; admin file route reads the object key from the DB row only; `AssetEventLog` RLS enabled |
| OPTIMIZATION | **NOT PERFORMED** (correctly) | Optimizer (gltf-transform prune/dedup/weld/simplify/quantize + sharp textures + meshopt) is wired with measured before/after gates; there is no real file to optimize |
| SUPABASE STORAGE | **PARTIAL** | adapter `download()` added; immutable-versioned keys; prod bucket backfill of the tracked v2 object still pending (service key is runtime-only) — viewer falls back to the tracked static path, verified HTTP 200 in production |
| ASSET REGISTRY | **DONE** | `Asset.kind`, 9-state lifecycle, 14 promotion gates, `AssetEventLog`; canonical asset untouched (SYNTHETIC, both versions PLACEHOLDER) |
| ZONE MAPPING | **DEMO ONLY** | 8 zone mappings on the placeholder version, all `MAPPING_NEEDS_REVIEW` (`FINGERPRINT_NOT_RECORDED` / `NO_INVENTORY_FOR_VERSION`); no real zone mapping exists |
| PART MAPPING | **DEMO ONLY (J10 not performed)** | 5 part mappings on the placeholder; every part page reports `DEMO_ONLY` or `UNAVAILABLE`, never `MAPPED` |
| R3F RENDER | **PLACEHOLDER VERIFIED, REAL NOT AVAILABLE** | Production: viewer canvas renders, `/uploads/.../peugeot-206-engineering-v1.glb` → 200, availability block reports PLACEHOLDER |
| BROWSER VERIFICATION | **DONE (placeholder state) on production** | Vehicle page `data-vehicle3d="PLACEHOLDER"`, zones AVAILABLE (experimental), part mapping UNAVAILABLE; part page `DEMO_ONLY` copy verified on `poom-jet.vercel.app` |
| PRODUCTION PROMOTION | **NOT PERFORMED — correctly refused** | No REAL asset exists; `REAL_ASSET` gate fails by construction and `PLACEHOLDER` is terminal for customers (probed: P23/P26/P27) |

## A. What was built

* **Validation layer** `src/lib/asset-validation/` — container parse, structure,
  security, self-containment, mesh inventory + structural fingerprints, metrics,
  provenance/rights, raw-vs-optimized comparison (documents:
  `PHASE2-J-ASSET-VALIDATION.md`).
* **Lifecycle** `src/lib/asset-lifecycle.ts` — states, forward-only transitions,
  mapping health, 14 promotion gates, delivery budget, availability contract.
* **Registry rewrite** `src/lib/asset-registry.ts` — audit-before-store ingestion,
  validate/optimize/stage/verify/promote/rollback/retire/reject, event log,
  contract resolver v3 (per-mapping health/trusted).
* **Schema + migration** `prisma/migrations/20260927_p2j_asset_lifecycle/` —
  `Asset.kind`, `AssetVersionState`, raw-artifact + provenance + evidence columns,
  `MeshMapping` fingerprints/health, `AssetEventLog` (+RLS). **Additive by design**
  (phase 1 of 2): the legacy `status` column survives, nullable.
* **Operators' surfaces** — Mapping Studio (real-file inspection via admin route,
  inventory, per-version evidence, pipeline buttons, event feed), admin asset page,
  upload route with tri-state provenance, operator CLI
  `scripts/p2j-asset-pipeline.mts` (inbox/ingest/validate/inventory/optimize/stage/
  verify/status/promote/rollback/retire/reject/health/reconcile/report; non-local
  DB writes require `ALLOW_PROD_PROMOTION=1`).
* **Truthfulness** — `car-scene.tsx` availability block
  (`data-vehicle3d` / `data-zone-display` / `data-part-mapping`) and
  `parts/[slug]` `MAPPED | DEMO_ONLY | UNAVAILABLE` copy.
* **Deleted** the old unguarded `scripts/register-206-glb.mjs` and corrected the
  seed's stale v2 size/checksum (`1294156` B / `8c5c11e1…`, verified against the
  tracked bytes on disk).

## B. Asset source status (J0/J1)

Recorded in `PHASE2-J-ASSET-SOURCE-REPORT.md`: rights framework, four accepted
acquisition paths, rejected categories (AI-generated free-standard, no-license,
no-redistribution), provenance record schema, and candidates
C1 `f342081c…` (CC-BY, 5.4k tris, body+wheels split — preferred), C2 `b2ef11bf…`
(CC-BY, 87.7k), C3 `dc25a117…` (CC-BY, 491.9k, variant tag ambiguous),
C4 `242e861b…` (backup). **User decision taken in this phase: the user downloads
the file themselves into `.freebuff/asset-inbox/`; the pipeline after that is
automated.** Nothing has been downloaded yet, so no license claim was made and no
variant (تیپ ۵) was inferred anywhere.

**Update 2026-09-29 (J1 re-run):** the owner rejected C1 on visual fidelity; a fresh
candidate sweep re-ranked the accepted set to C10 `2a41b3b9…` (rank 1), C5 `44ac8a85…`
(rank 2, likely duplicate of C10), C2 (rank 3), C3 (rank 4), C4 (rank 5, backup) —
all Sketchfab CC-BY; C11–C13 were inspected and rejected (low fidelity / no license
stated / non-standard WRC photogrammetry). See `PHASE2-J-ASSET-SOURCE-REPORT.md` §6.1.

## C. Verification performed

* **Suite**: 19 files / 272 tests green (local golden DB), incl.
  `p2j-asset-validation` 43, `asset-registry` 10, `p2h-storage-security` 21.
  `tsc --noEmit`, `eslint src prisma tests`, `next build` all clean. **CI green on
  `981f7f9`** (the first CI run caught a real test-determinism bug: `ORDER BY
  activatedAt DESC` is NULLS-FIRST in Postgres and could select the builtin
  version; fixed by selecting the version that carries the tracked artifact).
* **Adversarial probes** (`poom/.freebuff/p2j-adversarial.mts`, report under
  `.freebuff/p2j-reports/`): **27/27 pass** — stub/.gltf/ZIP refused, external
  reference + traversal + script marker + embedded MZ + accessor bomb refused,
  NC/Free-Standard/missing licence refused, checksum mismatch refused, hostile and
  NC files REJECTED with **zero objects uploaded**, pipeline-skip/unverified
  promotion/fake rollback refused, synthetic asset fails `REAL_ASSET` even with
  perfect fabricated evidence, `local-dev` render evidence does not count, live
  contract reports PLACEHOLDER with no mapped parts.
* **Migration dry run** (scratch DB built from the pre-P2-J migrations + legacy
  rows, then the P2-J migration applied): `status` preserved and made nullable,
  `ACTIVE`/`READY` → `PLACEHOLDER`, old `status` queries still work, new inserts
  without `status` work, `AssetEventLog` created with RLS on. Scratch DB dropped.
* **Production migration** (canonical P2-H runbook path, session pooler): applied
  2026-09-27, `prisma migrate status` → *up to date*. Before: v1 `ARCHIVED`, v2
  `ACTIVE`. After: `kind = SYNTHETIC`, `state = PLACEHOLDER` for both versions,
  legacy `status` retained, `AssetEventLog` present + RLS enabled, 26 mappings
  (fingerprints pending by design).
* **Production browser verification**: viewer renders the placeholder GLB (HTTP
  200) with the availability block
  `data-vehicle3d="PLACEHOLDER" data-zone-display="AVAILABLE" data-part-mapping="UNAVAILABLE"`;
  `/parts/oil-filter-206` (mapped part) reports `DEMO_ONLY` with the copy «…یک
  نگاشت آزمایشی روی نمونهٔ جایگزین است و مکان واقعی قطعه نیست»; an unmapped part
  reports `UNAVAILABLE`; no console errors.

## D. What customers can and cannot see now (production)

Can: the labelled synthetic 206 with zone navigation, explicitly marked as a
stand-in ("سه‌بعدی خودرو: موجود، ولی نمونهٔ جایگزین (مدل واقعی ثبت نشده است)").

Cannot: any claim that a real Peugeot 206 model is shown, or that a part has an
exact 3D location. Both claims require `kind = REAL` **and** `state = PRODUCTION`
**and** a `MAPPING_VALID` mapping — none of which can exist while no real file has
been delivered, and none of which can be faked through the UI (all writes go
through the registry, and every gate is evaluated from stored evidence).

## E. Phase-2 migration and remaining production work

1. **Drop the compatibility column** in a later release: `DROP INDEX
   "AssetVersion_assetId_status_idx"`, `ALTER TABLE "AssetVersion" DROP COLUMN
   "status"`, `DROP TYPE "AssetVersionStatus"` (commented in the migration file;
   `prisma migrate diff` currently reports exactly this difference plus pre-existing
   drift noted below).
2. **Backfill the v2 object into the Supabase bucket** from an environment that
   has the service-role key (currently the viewer is served by the tracked static
   file).
3. **Ingest the first real file** when the user drops it in
   `.freebuff/asset-inbox/`; then run inventory → mapping (J10) → optimization →
   stage → verify → promote, which is exactly the automated path built here.

## F. Pre-existing drift observed (out of P2-J scope, not touched)

`prisma migrate diff` also reports differences that predate this phase: missing
`Seller_sellerOrigin_idx` / `Seller_sellerVerificationStatus_idx`, `updatedAt`
defaults on `Fitment`/`Part`, and `CatalogEventLog_partId_fkey` declared
`ON DELETE RESTRICT` in the migration while the schema declares `CASCADE`. None of
these affect P2-J behaviour; they are recorded so the next phase can reconcile
them deliberately rather than by accident.

## STOP CONDITION check

No forbidden work was done: no auth/payment/seller/region/backup changes, no
catalog expansion, no VIN/AI/AR/mobile, no UI redesign, no fake asset, no
inference of a 206 variant, no blind renaming, no `public/` runtime writes, no
promotion of anything. The pipeline fails closed everywhere it cannot verify, and
the one thing this phase cannot do — attach a real Peugeot 206 to the viewer — is
blocked on a file only the user can obtain, not on missing code.

**P2-J STATUS: BLOCKED** (blocker: no rights-documented real GLB delivered).
