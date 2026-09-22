# P2-G — Adversarial Audit (Security · Integrity · Ownership · Truthfulness)

Date: 2026-09-22 · Auditor: adversarial review pass (independent of the P2-G build)
Method: static authority tracing of every P2-G mutation + live probes against the real
PostgreSQL DB + HTTP walkthrough of the running dev server. Nothing was accepted because a
test suite was green.

Scope: the P2-G surface — seller onboarding, seller identity/session, seller governance
(approve/reject/suspend), offer creation/ownership, the catalog & fitment and 3D boundaries,
the seller↔customer commerce boundary, CSV inventory, seller orders, rate limiting, error
handling, DB integrity, environment safety.

Out of scope (not started): P2-H, a second real seller, more catalog rows, real GLB sourcing,
new marketplace features.

---

## 1. Executive summary

| Severity | Found | Fixed | Remaining |
|---|---|---|---|
| CRITICAL | 0 | 0 | 0 |
| HIGH | 1 | 1 | 0 |
| MEDIUM | 1 | 1 | 0 |
| LOW | 3 | 3 | 0 |
| Accepted risk (documented) | — | — | 4 |

One HIGH finding was real and customer-facing: **the fitment explanation could assert
definitive compatibility («… سازگار است.`) for a catalog record whose data status is
`REVIEW_REQUIRED`**, directly contradicting the «نیازمند بررسی» badge rendered beside it.
The P2-F.1 presentation policy had been applied to the *badge* only; the sentence underneath
(and the search tooltip + search paragraph) still rendered the raw Fitment Engine sentence.

No CRITICAL finding was found. Seller authentication, seller ownership, the catalog/fitment/3D
boundaries, historical order truth, and the P2-E payment/order protections all held under
probing.

**P2-G is safe to close.** No CRITICAL/HIGH finding remains open.

---

## 2. Findings

### H-1 — HIGH — Definitive compatibility claim shown for `REVIEW_REQUIRED` catalog data

- **Severity:** HIGH (a customer-facing claim stronger than the stored data supports, on a
  purchase path). A reviewer could argue CRITICAL under "customer-facing false claim with
  material commerce consequence"; treated as HIGH and fixed either way.
- **Affected code:**
  - `poom/src/app/parts/[slug]/page.tsx:117` — `<p>{result.reasonFa}</p>`
  - `poom/src/app/search/page.tsx:131` (badge `title` tooltip) and `:148` (result paragraph)
  - policy layer: `poom/src/lib/fitment.ts`
- **Root cause:** `resolveFitment()` returns, for a `COMPATIBLE` verdict, the literal sentence
  `بر اساس قانون ثبتشده برای پژو ۲۰۶ سازگار است.` The P2-F.1 policy
  (`fitmentPresentation`) softened the *verdict badge* to `REVIEW_REQUIRED` when the part's
  `dataStatus` is not `VERIFIED`/`DEMO`, but the *explanation string* kept using the raw engine
  `reasonFa`. Two presentations of one verdict drifted apart: badge = "needs review",
  sentence = "is compatible".
- **Exploit / observable evidence (before the fix):** rendering
  `/parts/radiator-assembly?variant=تیپ ۲` (real part `206-RAD-001`, `dataStatus=REVIEW_REQUIRED`)
  produced, in the same card:

  ```text
  سازگاری با خودرو   ? نیازمند بررسی   🚗 پژو ۲۰۶ تیپ ۲
  بر اساس قانون ثبتشده برای پژو ۲۰۶ سازگار است. یادداشت: public-206-maintenance-documentation
  ```

  A shopper reads the definitive claim; the catalog record is unverified and the engine's
  rule note is a single public maintenance doc reference.
- **Fix:** centralised the presentation in the policy layer (no second compatibility
  algorithm — the Fitment Engine verdict remains the only authority):

  ```ts
  // src/lib/fitment.ts
  export function fitmentPresentationReason(status, partDataStatus, reasonFa) {
    return fitmentPresentation(status, partDataStatus) === "REVIEW_REQUIRED"
      ? FITMENT_REVIEW_FA            // «… هنوز توسط ادمین تأیید نشده است؛ تأیید نهایی نیازمند بررسی است.»
      : reasonFa;
  }
  ```

  Applied to all three surfaces (PDP sentence, search paragraph, search badge tooltip).
  Deterministic rows (`VERIFIED`, `DEMO`) are untouched; non-`COMPATIBLE` verdicts pass through
  unchanged.
- **Regression test:** `tests/p2g-seller-onboarding.test.ts` →
  `"H: the fitment explanation can never assert «سازگار است» for unverified catalog data"`
  (asserts the softened sentence for `REVIEW_REQUIRED`/`UNVERIFIED`/`null`/`undefined`/unknown,
  and that it does **not** contain `سازگار است`; passes `VERIFIED`/`DEMO` through; leaves
  `INCOMPATIBLE`/`REVIEW_REQUIRED` engine sentences untouched).
- **Verified after the fix (live):**

  ```text
  PDP  : badge «? نیازمند بررسی» + «قانون سازگاری برای این خودرو با قطعه مطابقت دارد، اما
         دادهی کاتالوگ این قطعه هنوز توسط ادمین تأیید نشده است؛ تأیید نهایی نیازمند بررسی است.»
  SEARCH: DEMO rows «✓ سازگار است» (deterministic) · real row «? نیازمند بررسی» + policy sentence
  ```

---

### M-1 — MEDIUM — `seller_sku` uniqueness unenforced; CSV import could update the wrong listing

- **Severity:** MEDIUM (bounded data-integrity: a seller can corrupt their *own* listing's
  price/stock, not another seller's; can lead to oversell from a wrong stock figure).
- **Affected code:** `prisma/schema.prisma` (`Offer`), `src/lib/seller/seller-csv.ts`
  (`previewSellerInventoryImport` — `bySku` map), `src/lib/seller/seller-onboarding.ts`
  (`createSellerOffer`), `src/lib/seller/seller-offers.ts` (`updateSellerOffer`).
- **Root cause:** the domain allows several listings per `(sellerId, partId)` — the seed
  deliberately creates two radiator listings for `demo-seller-2` distinguished by
  `DEMO-SKU-S2-RADIATOR-02/04`. But the CSV inventory import matches rows to listings **by
  `seller_sku`**, and nothing prevented two of a seller's own listings from sharing a SKU. The
  import built a `Map` keyed by SKU (`bySku`), so a duplicate silently resolved to whichever row
  the map kept last — a non-deterministic wrong-listing update. The `createSellerOffer` contract
  even declared a `DUPLICATE_OFFER` outcome that no code path could produce.
- **Exploit / evidence (before the fix):** the adversarial probe created 3 concurrent offers on
  one `(sellerId, partId)` and confirmed `rows in DB=3` with no DB-level constraint; a CSV row
  with a duplicated `seller_sku` then matched ambiguously.
- **Fix (DB-level, not application-only):**
  - `@@unique([sellerId, sellerSku])` on `Offer` + migration
    `20260922_p2g_offer_sku_unique` → `CREATE UNIQUE INDEX "Offer_sellerId_sellerSku_key"`.
    PostgreSQL treats NULLs as distinct, so SKU-less listings remain unlimited while non-null
    SKUs are unique per seller (this preserves the intentional `(sellerId, partId)` multiplicity).
  - `createSellerOffer` now pre-checks the SKU inside the transaction and maps `P2002` →
    `DUPLICATE_OFFER` (the declared outcome is now reachable — no dead contract).
  - `updateSellerOffer` maps `P2002` → the already-declared `STALE_SKU`.
- **Regression tests:** `M-1: the DB enforces one listing per seller_sku`,
  `M-1: a duplicate seller_sku … is rejected (DUPLICATE_OFFER …)`,
  `M-1: concurrent create with the same SKU yields exactly one offer`,
  `M-1: re-labelling an existing offer onto a SKU already used … (STALE_SKU)`.
- **Verified after the fix (live probe):**
  `created=1/4, rows in DB=1, losers=DUPLICATE_OFFER/DUPLICATE_OFFER/DUPLICATE_OFFER`,
  plus the DB-integrity check `duplicate-seller-sku-per-seller: 0` and
  `offer-sku-unique-index present: 1`.

---

### L-1 — LOW — `STALE_SKU` declared but unreachable

- **Affected code:** `src/lib/seller/seller-offers.ts` (`UpdateSellerOfferResult`).
- Root cause: the reason was declared in the union and never raised — a misleading contract.
- Fix: raised on the SKU unique-index conflict (same change as M-1).
- Regression: the `STALE_SKU` test above.

### L-2 — LOW — No self-governance guard in `transitionSellerStatus` (defence in depth)

- **Affected code:** `src/lib/governance.ts`.
- Root cause: the only thing preventing an admin from approving a seller they own was
  `applyAsSeller` rejecting `ADMIN` applicants. The governance transaction itself never compared
  the seller's owner with the acting admin identity, so a legacy/seeded seller row owned by an
  admin user was approvable by that same admin. Not reachable through the UI today (no role
  promotion path exists), so LOW.
- Fix: the transaction now compares `Seller.userId` with the **session-derived** `adminUserId`
  and returns `SELF_GOVERNANCE` (never a form field). Identity-based, not a blanket block.
- Regression test: `L-2: an admin cannot change the governance status of a seller they own
  (SELF_GOVERNANCE)` — asserts denial **and** that a different admin still can approve.
- DB check: `admin-owned-real-seller-active: 0`.

### L-3 — LOW — A CSV file repeating a `seller_sku` applied both rows to one listing

- **Affected code:** `src/lib/seller/seller-csv.ts` (`parseSellerInventoryCsv`).
- Root cause: no in-file duplicate detection; both rows resolved to the same listing and the
  last one silently won.
- Fix: duplicate non-empty `seller_sku` rows within one file are marked `INVALID` with a Persian
  reason (all-or-nothing commit then aborts, as designed).
- Regression test: `L-3: a CSV file repeating a seller_sku is rejected per-row instead of
  silently last-wins`.

---

## 3. Verified controls (probed, no finding)

| Area | Question | Server-side fact that stops abuse | Evidence |
|---|---|---|---|
| A | Can a caller force ACTIVE/verified/`isRealSeller` at onboarding or profile update? | `applyAsSeller` hardcodes `sellerStatus=PENDING`, `verified=false`; profile schema whitelists 5 fields and strips injected keys | probe `profile-injection` PASS; tests "onboarding ignores injected authority fields", "profile update cannot escalate" |
| C | Can a forged cookie grant a seller/admin identity? | Identity resolves **only** through the `Session` store (`poom_session`, sha256-hashed); `poom_uid` is dead | `src/lib/seller/seller-auth.ts`; P2-E probes |
| B | Can a non-admin approve/reject? Can an admin self-approve? | `requireAdmin()` on the action; `ROLE_NOT_ALLOWED` at onboarding; `SELF_GOVERNANCE` in the transition | `admin-p2e-actions.ts`; L-2 test |
| D | Cross-seller offer read/write/toggle by id? | Ownership is in the `WHERE` clause (`sellerId` from identity) → `NOT_FOUND`, no existence leak | probe `offer-idor` PASS (B→A `NOT_FOUND`, A ok), `offer-toggle-idor` PASS, IDOR regression test |
| E | Can a PENDING/REJECTED/SUSPENDED seller publish? | `seller.sellerStatus !== "ACTIVE"` → `NOT_ACTIVE`; suspended sellers lose portal identity | probe `seller-status-gate` PASS |
| E | Can a real seller list synthetic rows, or a deprecated part? | `sourceRef` required + `dataStatus !== DEPRECATED` → `PART_NOT_ELIGIBLE` | M-2 / M-2b tests |
| F | Can a seller mutate canonical catalog / fitment / 3D? | The seller path writes `Offer` rows with explicit scalar fields only — no nested `part`/`fitment`/mapping writes exist | static trace of `createSellerOffer` / `updateSellerOffer`; `src/lib/offers.ts` |
| H | Are seller trust labels stronger than the DB state? | `getOffersForPart` filters `seller: { sellerStatus: "ACTIVE" }`; suspended/rejected sellers' offers vanish; label driven by `isRealSeller` | `active-offer-suspended-seller: 0`, `active-offer-rejected-seller: 0`; suspension test |
| I | Can a seller rewrite past order truth? | `OrderItem.unitPrice` is a settlement snapshot | probe `historical-orderitem-immutable` PASS; test "post-sale offer price/stock change never rewrites historical OrderItem snapshots" |
| I | Cart price tampering / replay / double settlement? | Server-side repricing at settlement; payable guard + idempotent attempt | probes `cart-price-tamper-immune`, `settlement-replay-storm` (ok=1/10, stock 4, sellerOrders 1) |
| E/G | Concurrent governance approve/suspend? | `SELECT … FOR UPDATE` on the `Seller` row; idempotent same-status no-op | governance transaction; suspend revokes owner sessions (`suspend-revokes-sessions` PASS) |
| P | Orphans, negative stock, wrong-owner rows? | 15 integrity checks | `probe-p2g-db-integrity.mts` → 15 OK, 0 VIOLATION |
| — | Environment safety | `.env` gitignored (`.env`, `.env*.local`); `.env.example` placeholders only; `DATABASE_URL` = `127.0.0.1:5433`; `isDemoAuthEnabled()` throws when `DEMO_MODE` is on under `NODE_ENV=production` | `.gitignore`, `.env.example`, `identity.ts` |

---

## 4. Accepted risk / remaining limitations

1. **`governance.ts` is a trusted-internal API.** Calling `transitionSellerStatus({ adminUserId: "anything" })`
   at lib level succeeds — the authorization boundary is `requireAdmin()` in
   `admin-p2e-actions.ts`. This is deliberate (service-level tests need it) and is probed and
   recorded by `governance-lib-trusts-caller`. **Accepted risk:** any *future* caller must gate
   with an admin check. Mitigation today: only the admin action imports it.
2. **`isRealSeller` means "origin", not "legally verified business".** The flag says the seller
   arrived through `/seller/apply` (rather than the demo seed). The customer UI renders
   «فروشنده واقعی» only for sellers whose offers are visible, and offers are only visible for
   `sellerStatus=ACTIVE` (i.e. an admin approved the application) — so a human gate does exist.
   The *stronger* claim (license/tax/company verification) is **not** modelled and no UI element
   asserts it. Recommended for a later phase: move to an explicit `origin` enum +
   `verificationState`, rather than a boolean.
3. **Demo authentication** is phone-allowlist based (`SELLER_LOGIN`/`ADMIN_LOGIN`), extended in
   P2-G to recognise a real-seller owner's own phone. It is `DEMO_MODE`-gated and fails closed in
   production; a real credential provider replaces it in the auth milestone.
4. **Real-seller business data is self-declared** (business name, owner, phone, city, address) and
   the price/stock of the first real offer are placeholder figures entered through the real form —
   **not market-verified**.
5. **REAL GLB: NOT YET ACQUIRED** — unchanged. The asset integration pipeline is verified; no
   legitimately licensed 206 GLB exists in the repository.
6. Catalog real rows remain **REVIEW_REQUIRED** (12 rows) pending the admin verification flow.
7. Probe runs leave named artifacts in the dev DB (probe sellers such as «پروب فروشنده الف»,
   probe parts). They are isolated from demo/catalog data and pass all integrity checks; a
   production DB would never carry them.

---

## 5. Environment incident during the audit

The first full-suite run after the fixes failed **one** test
(`tests/p2c-garage-search.test.ts:139`, "Can't reach database server at `127.0.0.1:5433`") — a
transient PostgreSQL backend refusal (the portable Windows PG 18.6 DSM issue documented in
`.freebuff/run.md`), not a code regression. Evidence it is environmental, not a flake label:

- the postmaster never exited (`pg_ctl status` → running, same pid) and connectivity resumed;
- the file passed in isolation immediately after (20/20);
- the full suite then passed **178/178 twice consecutively** from the frozen final code state;
- the P2-G file passed 5/5 consecutive runs;
- no code in the failing path touches P2-G.

---

## 6. Final gate (after all fixes)

```text
TypeScript          : npx tsc --noEmit → 0 errors
Full suite ×2       : 178/178, 15 files — two consecutive runs from the frozen final state
P2-G file ×5        : 5/5 runs PASS
Concurrency spikes  : settlement PASS · garage-race PASS (finalActives=1) · seller 10/10 rounds
P2-E probes         : CANCEL_ATTACK: SAFE · GUEST_IDOR: SAFE
P2-G probes         : adversarial 9 PASS / 0 FAIL · commerce 5 PASS / 0 FAIL
DB integrity        : 15 checks OK, 0 VIOLATION
Build               : ✓ Compiled successfully, 31/31 static pages
Preview             : http://127.0.0.1:3010/ registered (pid 16924); HTTP walks 200
Console/dev log     : 0 error/unhandled/exception matches; only Next.js Fast Refresh info and a
                      dev-only cross-origin `_next/*` warning (see run.md)
Env safety          : .env ignored · .env.example placeholders only · local DB URL · demo auth
                      fails closed in production
```

---

## 7. Truthfulness statement (seller · catalog · asset)

| Concept | Status |
|---|---|
| REAL SELLER | **1** — «لوازم یدکی البرز (واقعی)», `isRealSeller=true`, created via `/seller/apply`, admin-approved to ACTIVE. "Real" = *onboarded through the real flow and admin-approved*, **not** legally verified. |
| REAL OFFER | **1** — real part `radiator-assembly` (REVIEW_REQUIRED) × that seller. Price/stock are **placeholder, not market-verified**. |
| VERIFIED SELLER | **0** — no business/legal verification state exists in the model. |
| VERIFIED CATALOG DATA | **0 rows** — the admin verification flow is ready but nobody has verified a row. |
| REVIEW_REQUIRED CATALOG DATA | **12** real rows (+13 real fitment rules), all with provenance, none silently upgraded — and now **impossible to display as definitively compatible**. |
| REAL GLB | **NOT YET ACQUIRED** (pipeline verified; no licensed asset in the repo). |
| DEMO DATA | 41 seeded parts, 3 demo sellers, demo categories/brands — labelled «اطلاعات نمایشی» / «فروشنده نمایشی». Never presented as real. |
