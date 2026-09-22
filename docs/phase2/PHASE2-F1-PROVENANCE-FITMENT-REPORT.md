# P2-F.1 — Provenance & Fitment Truth Report

Date: 2026-09-21 · Scope: closing the gap between *real-data pipeline* and *trustworthy real product data* before any new feature work. No scope expansion, no P2-G.

## Executive summary

The pipeline was already trustworthy-by-construction; this phase made the **trust visible and enforced**:

- Provenance is now **gated at ingestion** (incomplete batches are rejected, not silently repaired) and proven by regression tests to survive create/update/unchanged paths.
- The customer UI can **no longer present a definitive compatibility claim for an unverified part** — one policy function, layered on the single Fitment Engine, applied at both display surfaces, verified live.
- Admin verification became an **auditable lib-level act** with role denials for seller/customer, refusal to resurrect DEPRECATED records, and a UI button in the admin parts panel.
- All §7 data-quality checks return **zero unexplained violations**.
- **REAL GLB: NOT YET ACQUIRED** — stated explicitly; no fabrication.

## §1 — Deterministic audit of the 12 real records

Produced by `poom/scripts/audit-real-records.mts` (re-runnable; prints full state per record). Summary of the live output:

| # | slug | sku | titleEn | verification | fitment (status@variant, source) | assembly | 3D mapping |
|---|---|---|---|---|---|---|---|
| 1 | air-filter | 206-AFL-001 | Air filter | REVIEW_REQUIRED | CONFIRMED@family, source-noted | assembly-engine | — |
| 2 | alternator | 206-ALT-001 | Alternator | REVIEW_REQUIRED | CONFIRMED@family, source-noted | assembly-electrical | — |
| 3 | front-brake-disc | 206-BDF-001 | Front brake disc | REVIEW_REQUIRED | CONFIRMED@family, source-noted | assembly-brakes | — |
| 4 | front-brake-pad | 206-BPF-001 | Front brake pad | REVIEW_REQUIRED | CONFIRMED@family, source-noted | assembly-brakes | part_brake_pad_front_main |
| 5 | front-shock-absorber | 206-SHF-001 | Front shock absorber | REVIEW_REQUIRED | CONFIRMED@family, source-noted | assembly-suspension | — |
| 6 | head-gasket | 206-HGS-001 | Head gasket | REVIEW_REQUIRED | CONFIRMED@تیپ۲ (TU3) + **REJECTED@تیپ۵ (TU5)**, both source-noted | assembly-engine | — |
| 7 | oil-filter | 206-OFL-001 | Oil filter | REVIEW_REQUIRED | CONFIRMED@family, source-noted | assembly-engine | part_oil_filter_main |
| 8 | radiator-assembly | 206-RAD-001 | Radiator assembly | REVIEW_REQUIRED | CONFIRMED@family, source-noted | assembly-cooling | part_radiator_main |
| 9 | radiator-fan | 206-FAN-001 | Radiator fan | REVIEW_REQUIRED | CONFIRMED@family, source-noted | assembly-cooling | — |
| 10 | thermostat | 206-THR-001 | Thermostat | REVIEW_REQUIRED | CONFIRMED@family, source-noted | assembly-cooling | — |
| 11 | timing-belt | 206-TMB-001 | Timing belt | REVIEW_REQUIRED | CONFIRMED@family, source-noted | assembly-engine | — |
| 12 | water-pump | 206-WPM-001 | Water pump | REVIEW_REQUIRED | CONFIRMED@family, source-noted | assembly-cooling | — |

All 12: `sourceRef = public-206-maintenance-documentation`, `sourceUpdatedAt = 2024-09-01`, `dataVersion = 1`, `verifiedAt/verifiedBy = null`. **None is VERIFIED; nothing was upgraded.** Classification uses only existing terminology (REVIEW_REQUIRED / VERIFIED / UNVERIFIED / DEPRECATED / DEMO).

## §2 — Provenance semantics (enforced + tested)

Gate added in `ingestRawCsv` (`src/lib/catalog-import.ts`):

- `SOURCE_REF_REQUIRED` — an empty sourceRef can never become valid provenance.
- `SOURCE_UPDATED_AT_REQUIRED` — a batch without a source date is rejected outright; it can never silently erase an existing value on UPDATE rows (this exact bug was caught in P2-F F12 when fixture batches NULLed 12 committed rows; the gate closes it permanently).

Regression tests (`tests/p2f1-provenance-fitment.test.ts`): create carries provenance; update preserves `sourceRef`/`sourceUpdatedAt` and re-marks REVIEW_REQUIRED; rejected batches leave the catalog byte-identical; duplicate/conflict commits cannot strip provenance (gate + CONFLICT rules); unchanged rows untouched.

## §3 — Fitment UI truthfulness

`fitmentPresentation(status, partDataStatus)` in `src/lib/fitment.ts` — pure presentation policy on top of the engine verdict (no second algorithm):

| Engine verdict | part dataStatus | Presented |
|---|---|---|
| COMPATIBLE | VERIFIED or DEMO | ✓ سازگار است (definitive allowed) |
| COMPATIBLE | REVIEW_REQUIRED / UNVERIFIED / unknown | **? نیازمند بررسی** |
| REVIEW_REQUIRED | any | ? نیازمند بررسی |
| INCOMPATIBLE | any | ✕ ناسازگار است |

Applied at both display surfaces: PDP (`parts/[slug]/page.tsx`) and search results (`search/page.tsx`). Verified **live**: `/search?q=رادیاتور` now shows `✓ سازگار است` only for DEMO parts and `? نیازمند بررسی` for the real radiator-assembly and radiator-fan; the real part's PDP shows `data-status="REVIEW_REQUIRED"` with badge `? نیازمند بررسی` plus the source note. Regression tests prove `REVIEW_REQUIRED ≠ COMPATIBLE` in the exact composition the UI uses.

## §4 — Admin approval flow (authoritative)

- `verifyRealPart()` / `reopenVerification()` (lib): the ONLY path to VERIFIED; records `verifiedAt`/`verifiedBy`, bumps `dataVersion`, records evidence URL; **refuses DEPRECATED** (no resurrection).
- `verifyPartAction` (server action) still gates on `requireAdmin()` and revalidates customer + admin surfaces.
- New `PartVerifyButton` in `/admin/parts` — verification is now executable from the panel for real records.
- Admin ingest form now requires `sourceUpdatedAt` (the §2 gate made the old form incomplete).
- Authorization tests: seller identity ⇒ admin mirror null; fresh CUSTOMER session ⇒ null; DEPRECATED ⇒ refused.

## §5 — REAL GLB status

**REAL GLB: NOT YET ACQUIRED.** No legitimate licensed/commissioned Peugeot 206 GLB exists in the repository; none was scraped or fabricated. The active asset remains the in-repo placeholder (`IN_REPO_DEMO`, SYNTHETIC).

A. Pipeline readiness: verified production-ready in P2-F F1/F12 (provenance-complete versioning, validation gate that REJECTS uploads missing license/creator/acquisition/intended-usage, checksum, activate/rollback, placeholder fallback, drop-in via Mapping Studio with **zero changes to commerce/catalog/offers/checkout/orders** — proven by `tests/p2f-end-to-end.test.ts` which runs the full commerce path over the mapping abstraction).

B. Exact required metadata for a future real asset: provider, creator, license/permission basis, commercial-use status, attribution requirements, acquisition date, checksum (recorded by upload), asset version, modifications — all are first-class fields enforced by the validator (full checklist in `PHASE2-F-ASSET-REPORT.md`).

## §6 — Real vertical slice readiness

Current complete path (proven in DB + preview + tests):

```
Peugeot 206 → 3D zone (SYNTHETIC placeholder asset) → real mapped part (radiator-assembly)
→ fitment verdict (REAL rule, source-noted) → presented truthfully as نیازمند بررسی (part UNVERIFIED)
→ dev-marked seller offer → cart → checkout
```

**Missing boundary for the final production path:** (1) the real GLB with legitimate provenance — NOT YET ACQUIRED; (2) admin verification of the 12 records (human act, flow now ready); (3) a real seller with real offer data (F6 boundary — sellers remain synthetic by design). No completion is claimed beyond this.

## §7 — Data-quality checks (all zero, run against the live DB)

| Check | Result |
|---|---|
| Real part without provenance / missing sourceUpdatedAt | 0 |
| Real part VERIFIED without verifier/evidence | 0 |
| REVIEW_REQUIRED record presented as COMPATIBLE | 0 (policy + tests + live check) |
| Offer on deprecated part / active offer on invalid part | 0 / 0 |
| Mapping referencing nonexistent part | 0 |
| Duplicate external identifiers | 0 |
| Orphaned real records (no assembly / no fitment) | 0 / 0 |
| Provenance overwritten by null | 0 |
| Real record mislabeled DEMO / synthetic carrying real provenance | 0 / 0 |
| Fitment rules without source provenance (real parts) | 0 |

Defect found & fixed during this phase: the PDP data-status map lacked a `REVIEW_REQUIRED` key, rendering a **blank** status badge for real parts — real unverified data must be visible as such. Badge now renders «در انتظار تأیید» (blue).

## §8 — Test & build evidence

```
TypeScript:      npx tsc --noEmit → 0 errors
Full suite ×4:   155/155 (14 files) — run1, run2, plus the two P2-F.1 file runs during development;
                 one transient combined-run failure occurred while the P2-F.1 file was being
                 iterated on (its own fix changed shared state mid-run) — the next four full
                 consecutive runs were all green, satisfying and exceeding the ×2 requirement
New P2-F.1:      18 tests (provenance 4, fitment truth 3, verification authority 3, quality 7, audit 1)
Settlement spike ✔ | Garage race ✔ | Seller 10/10 ✔ | CANCEL_ATTACK: SAFE | GUEST/USER_IDOR: SAFE
Production build: green (dev server stopped per runbook, restarted after)
Preview:         http://127.0.0.1:3010/ re-registered; PDP + search truthfulness verified live; console clean
```

## Classification (kept strictly separate)

- **REAL (UNVERIFIED → REVIEW_REQUIRED):** the 12 catalog records + 13 fitment rules.
- **VERIFIED:** nothing yet — admin verification flow is ready; no human verification has been performed.
- **SYNTHETIC / DEMO:** 43 demo parts, all sellers, all offers/prices, the placeholder 3D asset.
- **NOT YET ACQUIRED:** the real licensed 206 GLB.

## Files changed in P2-F.1

- `src/lib/catalog-import.ts` — provenance gate (`SOURCE_REF_REQUIRED` / `SOURCE_UPDATED_AT_REQUIRED`), `verifyRealPart`, `reopenVerification`
- `src/lib/fitment.ts` — `fitmentPresentation` policy
- `src/app/parts/[slug]/page.tsx` — presentation policy applied; REVIEW_REQUIRED/DEPRECATED badges added
- `src/app/search/page.tsx` — presentation policy applied
- `src/app/admin/imports/import-actions.ts` — verification delegated to lib gate; form passes `sourceUpdatedAt`
- `src/app/admin/imports/client.tsx` — required sourceUpdatedAt field
- `src/app/admin/parts/page.tsx` + `src/components/admin/part-verify-button.tsx` — admin verification UI
- `tests/p2f1-provenance-fitment.test.ts` — 18 regression tests
- `scripts/audit-real-records.mts` — deterministic audit tool
