# P2-F — Final Report

Date: 2026-09-21 · Scope: transition from synthetic demo foundation to the first real, traceable Peugeot 206 dataset, without regressing P2-E.

## Verification gate (exact results)

```
TypeScript:            npx tsc --noEmit        → 0 errors
Tests run 1:           npx vitest run          → 137/137 passed (13 files)
Tests run 2:           npx vitest run          → 137/137 passed (13 files)   [consecutive]
Settlement spike:      spike-concurrency.mts   → SPIKE PASS ✔
Garage race spike:     spike-garage-race.mts   → GARAGE RACE SPIKE PASS ✔
Seller spikes:         spike-seller-concurrency.mts → 10/10 rounds passed
Cancel-attack probe:   probe-cancel-pay.mts    → CANCEL_ATTACK: SAFE (stock untouched)
IDOR probes:           probe-or-idor.mts / probe-or-idor2.mts → GUEST_IDOR: SAFE / USER_IDOR: SAFE
Production build:      npm run build           → green (dev server stopped first, restarted after)
Preview:               registered http://127.0.0.1:3010/ (pid recorded in .freebuff/run.md)
Console:               no application errors during walkthrough (two logged errors were
                       self-inflicted probe artifacts: GET on a POST-only route → 405,
                       and a raw fetch following the logout 303 — not app defects)
```

P2-E suite grew 112 → 137 (new: catalog import ×4, real fitment ×4, end-to-end ×4, search ×5, data integrity ×8, asset-lifecycle provenance hardened).

## Acceptance checklist

| Gate | Result |
|---|---|
| P2-E remains fully green | ✅ all spikes/probes re-run PASS |
| TypeScript = 0 errors | ✅ |
| Suite ×2 consecutive | ✅ 137/137 twice |
| Build | ✅ |
| First real 206 3D asset integrated **or** pipeline fully verified | ✅ pipeline fully verified; the GLB file itself is **PENDING** (see Asset Report) — no license-fabrication |
| Asset provenance documented | ✅ Asset Report + schema-level enforcement |
| Real 206 mappings functional | ✅ 8 zones + 5 part meshes, 3 re-pointed to real parts |
| Real catalog imported & validated | ✅ 12 rows via the F5 pipeline itself |
| No fabricated identifiers/claims | ✅ no OEM numbers; rows born REVIEW_REQUIRED; statuses surfaced in UI |
| Fitment = central engine | ✅ no second algorithm; REVIEW_REQUIRED on missing rules |
| Real part reachable from 3D | ✅ mesh → mapping → part (test + preview) |
| Real part shows offer data | ✅ PDP offer + cart + checkout exercised |
| Search works on real dataset | ✅ Persian/Latin/identifier, vehicle-aware filter |
| Admin-only approval enforced | ✅ /admin/imports + /admin/data-quality behind requireAdmin |
| Seller cannot mutate canonical data | ✅ P2-D/P2-E authz suites green |
| Data integrity checks clean | ✅ 7 queries = 0 + 8/8 dataset tests |
| Payment/order/security behavior green | ✅ probes + Phase-1 suites |
| Preview customer/admin/seller flows | ✅ walkthrough below |
| No new console errors | ✅ (see gate) |
| Documentation complete | ✅ PLAN / ASSET / CATALOG / FINAL / BASELINE |
| No P3 features | ✅ |

## Preview walkthrough (live)

- `/vehicles/peugeot/206/type-5` — 8 zones, 3D canvas with honest 2D fallback (webview has no WebGL), reset/fullscreen/exploded controls.
- zone cooling → assembly page → **real** radiator among demo parts, badges now data-driven (`DEMO` vs `در انتظار تأیید`) — hardcoded DEMO label bug fixed during walkthrough.
- `/parts/radiator-assembly` — fitment «✓ سازگار است» with rule explanation + source note, specs, offer card (Toman), add-to-cart → cart reflects 3 items with correct Persian totals.
- `/admin/imports` (49 batches) and `/admin/data-quality` render real diagnostics; seller portal requires login, works after demo login, logout revokes session (POST-only; GET→405 is correct).

## Fixes made during F12 (defects found by the suite, not hidden)

1. **Parallel-file DB races** — `asset-registry` lifecycle temporarily swaps the ACTIVE version; e2e reading the contract mid-swap failed nondeterministically. Fixed with `fileParallelism: false` (DB-backed suite must be sequential; documented).
2. **`sourceUpdatedAt` silently stripped** — dup/conflict fixture batches without the date NULLed provenance on committed rows via the UPDATE path. Fixed: pipeline now REJECTS batches missing `sourceRef`/`sourceUpdatedAt` (`SOURCE_UPDATED_AT_REQUIRED`); fixtures corrected; one-time backfill `sourceUpdatedAt = createdAt` applied (12 rows).
3. **Stale P2-A expectations** — lifecycle/contract tests still expected `radiator-206`; part_radiator_main now maps to the real `radiator-assembly` (intentional F2 change — tests updated, not weakened).
4. **Hardcoded DEMO badge** — assemblies page labeled real imported parts "DEMO"; badge now derives from `dataStatus`.

## Remaining limitations (explicit)

1. **No real licensed GLB** — placeholder remains ACTIVE; drop-in is a Mapping-Studio data operation once an asset with complete provenance exists.
2. **12 real rows, not 100–300** — growth requires a licensed/verifiable source dataset; the pipeline, provenance gates, and conflict rules are ready and tested for it.
3. Real rows are `REVIEW_REQUIRED` until an admin verifies them (by design; verification flow exists in admin).
4. Performance numbers are dev-mode; production bundle/GLB measurements are only meaningful after the real asset lands (F11 documented the budget and technique list).
5. Offers on real parts are dev-marked data, not real sellers (F6).

## Classification summary

- **REAL (UNVERIFIED):** 12 catalog rows + 13 fitment rules, fully traceable.
- **SYNTHETIC/DEMO:** 43 parts, all sellers, all offers/prices, the 3D asset and its geometry.
- **VERIFIED:** nothing in the real dataset yet — admin verification is the next human act.
