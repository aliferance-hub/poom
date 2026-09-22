# P2-F — Real-Data Plan (execution record)

Vehicle scope: **Peugeot 206 only**. Execution order F0 → F1/F2 → F3/F4 → F5/F6 → F7 → F8/F9 → F10/F11 → F12, exactly as executed below. Principle: *real ≠ many* — 12 traceable real rows that work end-to-end prove more than hundreds of semi-fabricated ones.

## Sub-phase plan and status

| Sub-phase | Goal | Status |
|---|---|---|
| F0 | No-regression baseline of P2-E (112/112), DB/tooling state, baseline doc | ✅ `PHASE2-F-BASELINE.md` |
| F1 | Real-asset pipeline: provenance-complete `AssetVersion`, validator gates, GLB layer in viewer w/ placeholder fallback | ✅ code + tests (real GLB file itself **PENDING** — see Asset Report) |
| F2 | Real 206 zone/mesh mapping through the existing Mapping-Studio data model | ✅ 8 zone + 5 part mappings; 3 meshes re-pointed to real parts |
| F3 | First real 206 catalog rows (12, provenance-complete) | ✅ via the F5 pipeline itself |
| F4 | Fitment for real rows through the central Fitment Engine + regression tests | ✅ 13 rules incl. TU3/TU5 head-gasket negative |
| F5 | RAW → normalize → validate → review → approve → commit pipeline + admin UI | ✅ `/admin/imports`, all-or-nothing commit |
| F6 | Seller-data readiness (synthetic sellers stay; canonical/seller separation) | ✅ no model change needed — Offer already references Part only |
| F7 | End-to-end real path: 3D mesh → part → fitment → offer → cart → checkout | ✅ `tests/p2f-end-to-end.test.ts` |
| F8 | Admin data-quality view | ✅ `/admin/data-quality` |
| F9 | Search/PDP/UX validation on real data (incl. `titleEn` Latin search) | ✅ `tests/p2f-search-real.test.ts` + live walkthrough |
| F10 | Real-data integrity audit (queries + dataset tests) | ✅ 7 integrity queries = 0, `tests/p2f-data-integrity.test.ts` 8/8 |
| F11 | Performance check (placeholder-asset baseline, real-GLB requirements) | ✅ honest dev-mode measurements; production numbers only after real GLB |
| F12 | Suite ×2, build, spikes, probes, preview, reports | ✅ this report set |

## Truthfulness rules applied

1. Never fabricate OEM numbers, claims, verification, or licensing. Unverified ⇒ `REVIEW_REQUIRED`, never `VERIFIED`.
2. Real rows live beside synthetic rows with explicit `dataStatus` labels surfaced in UI (`DEMO` vs `در انتظار تأیید`/`تأیید شده`).
3. Real-world dependency missing (a licensed 206 GLB, a licensed 100–300-row catalog source) ⇒ build the boundary, document the requirement, **do not** fake the data.
4. Verification is a separate admin act — import never grants it.
