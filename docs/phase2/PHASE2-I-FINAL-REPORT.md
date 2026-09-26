# P2-I — FINAL REPORT

Phase: Real Catalog Verification & Production Data Promotion
Date: 2026-09-27 · Head at close: see git log (P2-I commits on `main`, CI green)
Scope guard: no P2-J work (no GLB), no auth/payment/VIN/AI/mobile/AR changes.

## P2-I RESULT

STATUS: PASS

## A. Implementation summary

Files changed / created:
- `prisma/schema.prisma` — new `CatalogEventLog` model (part lifecycle audit: verified / reopened / deprecated / promoted / evidence-corrected) + `catalogEvents` relation on `Part`.
- `prisma/migrations/20260926_p2i_catalog_event_log/migration.sql` — additive table + 2 indexes + FK (RESTRICT) + anon/authenticated REVOKE (extends the P2-H RLS baseline). Applied to production via `prisma migrate deploy` (canonical H3 path); fresh-DB replay verified locally.
- `src/lib/catalog-import.ts` — `verifyRealPart` hardening: evidence URL REQUIRED, DEMO records refused (`DEMO_PART`), missing provenance refused (`NO_SOURCE_REF`), every attempt audited in `CatalogEventLog` (success, refusal-by-caller, re-verification); `reopenVerification` no longer erases history (log-first) and accepts a note.
- `src/app/admin/imports/import-actions.ts` — `verifyPartAction` rejects empty evidence (`EVIDENCE_REQUIRED`) before touching the lib; `deprecatePartAction` writes `catalog_deprecated` audit events in a transaction.
- `src/components/admin/part-verify-button.tsx` — evidence-URL input is now part of the verification act (server re-validates).
- `src/lib/catalog-promotion.ts` (NEW) — promotion engine: `buildManifest` (source snapshot, VERIFIED-only, carries verification metadata), `classifyTargets` (PROMOTE / SAME / SKIP_NOT_VERIFIED / CONFLICT with classified reasons), `promoteCatalog` (conflict-blocking, idempotent, audited, verification metadata travels), `reconcile` (EXPECTED vs ACTUAL).
- `scripts/promote-real-catalog.mts` (NEW) — CLI: `build | classify | execute | reconcile`; non-local targets require explicit `ALLOW_PROD_PROMOTION=1`; never prints secrets.
- `src/lib/fitment.ts` — I5 truthfulness: VERIFIED records now get an evidence-scoped sentence (`FITMENT_VERIFIED_RULE_FA`) instead of the engine's bare «… سازگار است.» claim; unverified behavior unchanged.
- `prisma/seed.mjs` — removed the unconfirmable OEM identifier `1109.AX` (with audit rationale), removed the placeholder `sourceUrl` (absence is honest), seed no longer fabricates a citation.
- Tests: `tests/p2i-verification-promotion.test.ts` (12), updated `p2f-catalog-import`, `p2f-fitment-real`, `p2f1-provenance-fitment`, `p2g-seller-onboarding` to encode the P2-I truth rules.
- Docs: `docs/phase2/PHASE2-I-EVIDENCE-MATRIX.md` (I1/I2/I3), this report, `.freebuff/run.md`.

Schema changes: 1 additive table (`CatalogEventLog`) — no existing model touched.
Promotion mechanism: manifest-based (build → classify → execute → reconcile), idempotent upserts on stable SKU keys, conflict-classified, audit-logged, demo-safe.

## B. Real catalog verification report

| SKU | Part | Evidence | Fitment | Verification | Production |
| --- | ---- | -------- | ------- | ------------ | ---------- |
| 206-OFL-001 | فیلتر روغن پژو ۲۰۶ | OE 1109 A9 family documented by 3 independent sources (spareto OE listing, trodo/QFL0271 cross-ref, made-in-china MANN W712/75 listing); TU3JP 206 fitment via autodoc catalog | vehicle-level CONFIRMED (evidence-plausible; TU-family spin-on documented) | **VERIFIED** (verifiedBy=`p2i-verification-20260927`, evidence=https://spareto.com/oe/1109a9, audited) | **PROMOTED** |
| 206-RAD-001 | رادیاتور آب | identity only; no OE/brand/years evidence | family-level CONFIRMED | REVIEW_REQUIRED | not promoted |
| 206-FAN-001 | فن رادیاتور | identity only | generic claim | REVIEW_REQUIRED | not promoted |
| 206-THR-001 | ترموستات | identity only; opening temp unknown | generic claim | REVIEW_REQUIRED | not promoted |
| 206-WPM-001 | پمپ آب | identity only | generic claim | REVIEW_REQUIRED | not promoted |
| 206-AFL-001 | فیلتر هوا | identity only | generic claim | REVIEW_REQUIRED | not promoted |
| 206-TMB-001 | تسمه تایم | identity only; TU3/TU5 claim unproven | generic claim | REVIEW_REQUIRED | not promoted |
| 206-HGS-001 | واشر سرسیلندر | identity + TU3≠TU5 gasket difference documented | TU3 CONFIRMED / TU5 REJECTED (evidence-supported negative) | REVIEW_REQUIRED | not promoted |
| 206-BPF-001 | لنت ترمز جلو | identity only; material claim unproven | generic claim | REVIEW_REQUIRED | not promoted |
| 206-BDF-001 | دیسک ترمز جلو | identity only; diameter unproven | generic claim | REVIEW_REQUIRED | not promoted |
| 206-SHF-001 | کمک فنر جلو | identity only; gas claim unproven | generic claim | REVIEW_REQUIRED | not promoted |
| 206-ALT-001 | دینام | identity only; "70A" unproven | generic claim | REVIEW_REQUIRED | not promoted |

Evidence corrections applied this phase (audited, CatalogEventLog `catalog_evidence_corrected`):
- `OEM 1109.AX` removed — cross-reference indexes tie it to the Boxer-class W9142 family; no source confirms it for the 206.
- Brand «تولیدی ایران» cleared from all 12 records — no manufacturer evidence exists.
- Placeholder `sourceUrl` (`https://example.org/evidence`) cleared — a fake citation proves nothing.

## C. Promotion manifest

`manifestId = p2i-20260927-prod` (source: golden DB snapshot, 2026-09-27)

| Field | Value |
| --- | --- |
| records | 1 — `206-OFL-001` (فیلتر روغن پژو ۲۰۶) |
| record state | VERIFIED (evidence-backed) |
| provenance carried | sourceRef `public-206-maintenance-documentation`, sourceUrl `https://spareto.com/oe/1109a9`, verifiedBy `p2i-verification-20260927`, verifiedAt 2026-09-26T21:22:11.698Z |
| fitment rules | 1 (vehicle-level CONFIRMED, note-cited) |
| identifiers | none (OE removed by evidence audit) |
| sellers | NOT promoted (§7: separate decision — seller readiness not established) |
| offers | NOT promoted (no verified real offer meets production criteria; price/stock are seller data, not catalog data) |
| expected resulting counts | verified_parts=1, fitment_rules=1, promotion_events=1 |

## D. Production reconciliation report

```text
entity            expected  actual  match
verified_parts           1       1  YES
fitment_rules            1       1  YES
promotion_events         1       1  YES

RECONCILIATION: MATCH
```

Direct DB verification (production, post-promotion):
- `Part 206-OFL-001`: state=VERIFIED, verifiedBy=p2i-verification-20260927, sourceRef + sourceUrl present, intact.
- Fitment rule present (CONFIRMED, note-cited). CatalogEventLog row `catalog_promoted` actor=`promotion:p2i-20260927-prod-…`, meta.manifestId set.
- Demo data untouched: 43 DEMO parts remain exactly as before (44 total parts = 43 + 1).
- Production totals: real=1, verified=1, demo=43.

## E. Test report

- TypeScript: clean.
- ESLint: clean (0 errors).
- Unit/integration tests: **224/224, 18 files — PASS, twice consecutively** (I10 run 1 + run 2; 212 pre-existing + 12 new P2-I).
- Security tests: 8-case adversarial pass (demo-verify bypass, whitespace evidence, tampered manifest faking VERIFIED on a demo SKU → hard-blocked, non-VERIFIED manifest record skipped+nothing written, reopen-missing refused, demo rows untouched, no audit rows for refused attempts) — all PASS. Authorization (anonymous/unauthorized verify+promote) remains enforced server-side (`requireAdmin` gate + lib gates; P2-E suite green).
- Database integrity: `probe-p2g-db-integrity` (23 checks) OK; `probe-p2g1-truth-matrix` 6/6.
- Build: production `next build` PASS.
- Production smoke: `/` 200, `/api/health` 200 `{"status":"ok"}`, `/search?…` finds the promoted part, PDP `/parts/oil-filter` 200 with «تأیید شده» badge, demo PDP still shows «اطلاعات نمایشی» (no demo/real confusion), auth gates unchanged.

## F. Remaining REVIEW_REQUIRED records (11)

All carry identity-level plausibility and a note-cited vehicle-level rule, but lack:
1. a real citable source URL (per record) supporting the specific product claims;
2. OE/manufacturer identity (or an explicit "unbranded, no OE claim" decision);
3. per-variant/per-engine/per-year evidence for any stronger compatibility claim.

List: 206-RAD-001, 206-FAN-001, 206-THR-001, 206-WPM-001, 206-AFL-001, 206-TMB-001, 206-HGS-001, 206-BPF-001, 206-BDF-001, 206-SHF-001, 206-ALT-001.
Each becomes promotable the moment its evidence chain exists — the pipeline (verify with evidence → build manifest → execute) requires zero code changes.

## G. Remaining risks

- GLB pending: none of the real records has a real 3D asset (P2-J scope); PDP for the promoted part shows the demo/placeholder model, labeled as such.
- Automatic backup/PITR still not configured; manual `pg_dump` pre-promotion export was taken and verified (160 KB) — durability still depends on operator discipline.
- Region/performance: Vercel functions in `iad1` vs DB in Tokyo (P2-H accepted risk, unchanged) — SSR TTFB remains high.
- Real production authentication pending: demo phone-login remains the trust boundary; verification actions are admin-gated by that boundary (P2-H fail-closed), so "admin" is as strong as demo auth — the known accepted risk.
- Catalog evidence gaps: 11 records remain REVIEW_REQUIRED by design; a future OEM-number claim must carry a real source (the `1109.AX` incident shows why).
- Seller/offer readiness: the real seller and real offer stay in the golden DB, unpromoted, until identity/trust/operational criteria are met (§7 separation preserved).

## STOP CONDITION check

No hard-stop condition triggered: identity established for all 12 (evidence depth varies and is honestly reflected), no fitment conflict, no destructive overwrite (promotion is additive; pre-promotion export exists), provenance preserved end-to-end, seller/offer decisions separated, verification/prompting cannot be bypassed (server-side, audited, adversarially tested), demo data cannot silently become real (DEMO refuse paths + conflict classification), promotion idempotent, customer UI scoped to evidence.

P2-I STATUS: PASS
