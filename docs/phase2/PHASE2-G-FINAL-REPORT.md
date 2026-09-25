# P2-G — Real Seller Onboarding + Real-Offer Pipeline — Final Report

> **P2-G.1 follow-up (2026-09-23):** seller trust semantics were split into independent
> axes — `sellerOrigin` (DEMO/REAL_ONBOARDING/SYSTEM) ⊥ `sellerVerificationStatus`
> (UNVERIFIED/PENDING_REVIEW/VERIFIED/REJECTED) ⊥ `sellerStatus` (governance).
> REAL_ONBOARDING does not mean VERIFIED; VERIFIED means exactly what the admin
> verification workflow (`setSellerVerificationStatus`, audited, evidence-backed)
> proves. Full report: `PHASE2-G1-SELLER-TRUST-REPORT.md`.

Date: 2026-09-21 · Scope: closing the F6 boundary ("real seller data readiness") via the first non-DEMO seller lifecycle: public apply → admin approval → authenticated seller portal → real offer on a canonical part → customer purchase.

## What was built

| # | Capability | Where | Notes |
|---|---|---|---|
| G1 | Seller onboarding service | `src/lib/seller/seller-onboarding.ts` | `applyAsSeller` (public, CUSTOMER-only, PENDING + `isRealSeller=true`), `approveSeller`, `rejectSeller` — admin-only, `SellerEvent` audit rows, admin self-approval denied (`ADMIN_CANNOT_SELF_APPROVE`) |
| G2 | Real offer creation | `src/lib/seller/seller-onboarding.ts` (`createSellerOffer`) + `NewOfferForm` | Only ACTIVE sellers; real sellers can only list **real** parts (`dataStatus` REVIEW_REQUIRED/VERIFIED); DEMO sellers keep legacy edit-only flow |
| G3 | Truthful seller labeling | `parts/[slug]/page.tsx` + `isRealSeller` column | PDP now distinguishes «فروشنده واقعی» vs «فروشنده نمایشی · داده‌ها DEMO هستند» — driven by data, not a hardcoded label |
| G4 | E2E vertical slice | `tests/p2g-seller-onboarding.test.ts` | apply → admin approve → publish offer → customer checkout → SellerOrder created → stock decremented — through the exact production code paths |
| G5 | Security/concurrency tests | same file | seller-ownership IDOR on offer edit (403), customer→seller mutation deny, seller→admin action deny, admin self-approval deny, seller A cannot approve, concurrent same-part offers |

## Gate results

```text
TypeScript:        npx tsc --noEmit → 0 errors
Full suite ×2:     165/165 (15 files), two consecutive runs after the final schema/migration state
Build:             ✓ Compiled successfully, 31/31 static pages
Preview:           http://127.0.0.1:3010/ registered (pid 12020)
Console:           clean (only dev-only Fast Refresh info + one benign ERR_ABORTED from a canceled prefetch during form redirect)
```

## Live preview walkthrough (post-restart verification)

- Login page → admin login → `/admin/sellers`: PENDING queue (۱) → **تأیید** → ACTIVE (۵) — live through the real UI.
- Seller portal as a real seller: dashboard «لوازم یدکی البرز (واقعی)» renders; «آفرهای من (۱)» with the real offer.
- PDP (radiator-assembly): DEMO seller offers carry «فروشنده نمایشی · داده‌ها DEMO هستند»; Alborz's offer shows «فروشنده واقعی» — the label is now **data-driven** via `Seller.isRealSeller`.
- Customer cart still holds 3 items and checkout path untouched (G4 test covers it).

## Data honesty statement

- The first **real seller** record («لوازم یدکی البرز (واقعی)», Karaj) exists with `isRealSeller=true`, admin-approved via the real UI.
- The first **real offer** exists: real part `radiator-assembly` (REVIEW_REQUIRED catalog data) × real seller → ۷۲۰,۰۰۰ تومان, stock 5, shipping 1 day.
- Its **price/stock are placeholder values entered through the real form** — they are NOT verified market prices; they carry no OEM provenance. Real price/stock must come from a real seller.
- Catalog data remains REVIEW_REQUIRED pending admin verification (P2-F.1 flow, unchanged).
- **REAL GLB: NOT YET ACQUIRED** (unchanged from P2-F.1).

## Known limitations

1. Demo login remains phone-allowlist-based (`SELLER_LOGIN`/`ADMIN_LOGIN` + real-seller phone recognition added in this phase); a real credential provider replaces it in the auth milestone.
2. Real-seller verification is identity-level (PENDING→ACTIVE); business/legal profile (license, tax ID) is not modeled yet.
3. The real offer's price/stock are placeholders pending a real seller's data entry.
4. `fileParallelism: false` remains in vitest config (DB-backed suite); revisit when per-worker DB isolation is added.

## Verification commands

```bash
cd poom
npx tsc --noEmit                      # 0 errors
npx vitest run                        # 165/165 (×2 consecutive)
npm run build                         # green (dev server stopped first per runbook)
node scripts/spike-garage-race.mts    # PASS (existing concurrency guarantee intact)
```

---

# ADDENDUM — Adversarial audit (2026-09-22)

Full report: `PHASE2-G-ADVERSARIAL-AUDIT.md`. The audit re-derived every P2-G authority path
from the code and re-probed the live DB; it did not rely on the suite being green.

## Result: P2-G is safe to close — 0 CRITICAL, 0 HIGH open

| Severity | Finding | Status |
|---|---|---|
| HIGH | The fitment **explanation** asserted «… سازگار است.» on `REVIEW_REQUIRED` catalog data while the badge beside it said «نیازمند بررسی» (PDP sentence, search paragraph, search tooltip) | **FIXED** — `fitmentPresentationReason()` in `src/lib/fitment.ts`, applied to all three surfaces |
| MEDIUM | `seller_sku` uniqueness unenforced → CSV import (which matches by `seller_sku`) could update the wrong listing; `DUPLICATE_OFFER` was dead code | **FIXED** — unique index `Offer(sellerId, sellerSku)` (+ migration `20260922_p2g_offer_sku_unique`), pre-check + `P2002` → `DUPLICATE_OFFER` / `STALE_SKU` |
| LOW | `STALE_SKU` declared but unreachable | **FIXED** (same change) |
| LOW | No self-governance guard in `transitionSellerStatus` | **FIXED** — `SELF_GOVERNANCE` on session-derived identity |
| LOW | CSV file repeating a `seller_sku` applied both rows to one listing | **FIXED** — duplicate rows now `INVALID` |

Accepted risk (documented, unchanged behaviour): `governance.ts` is a trusted-internal API
gated by `requireAdmin` at the action; `isRealSeller` denotes *origin* (onboarded + admin-approved),
not legal/business verification — no UI string claims the stronger meaning.

## Gate after the fixes

```text
TypeScript:        0 errors
Full suite ×2:     178/178 (15 files) — two consecutive runs from the frozen final state
P2-G file ×5:      5/5 consecutive runs PASS (incl. the new SKU-race test)
Spikes:            settlement PASS · garage-race PASS · seller 10/10
P2-E probes:       CANCEL_ATTACK SAFE · GUEST_IDOR SAFE
P2-G probes:       adversarial 9/0 · commerce 5/0 · DB integrity 15 OK / 0 violations
Build:             ✓ Compiled successfully, 31/31 static pages
Preview:           http://127.0.0.1:3010/ (pid 16924) — PDP & vehicle-aware search verified
Console:           clean (dev log: 0 error/unhandled/exception)
```

## Additions in this pass

- `poom/docs/phase2/PHASE2-G-ADVERSARIAL-AUDIT.md` (new)
- Tests: 9 new — `M-1` ×4 (SKU uniqueness/race/`STALE_SKU`/index), `L-2`, `L-3`, `H` (fitment
truthfulness), onboarding injection, historical `OrderItem` immutability
- Probes: `probe-p2g-adversarial.mts` now asserts the SKU race (`created=1/4`) and the index;
`probe-p2g-db-integrity.mts` gained the duplicate-SKU and admin-owned-seller checks
- `poom/scripts/preview-search-session.mts` — mints an active-vehicle session for live search walks
