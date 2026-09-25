# P2-G.1 — Seller Trust Model: Origin ⊥ Verification — Final Report

Date: 2026-09-23 · Scope: split seller trust into independent axes so the UI can never claim more trust than the database and the verification process actually prove. No new features beyond the trust model.

## 1. The old model (audited from code, not guessed)

| Field | Meaning it actually had | Who could change it | When it changed | Customer-facing effect |
|---|---|---|---|---|
| `Seller.isRealSeller` (bool) | Origin provenance: true only via `applyAsSeller` (onboarding); false for seed rows | SYSTEM (onboarding flow) / seed | At seller creation only | PDP offer line «فروشنده واقعی» vs «فروشنده نمایشی · داده‌ها DEMO هستند»; admin list badge |
| `Seller.verified` (bool) | **Nothing** — no writer existed anywhere in the codebase; dead column, always false | nobody | never | Two dead badges: PDP «فروشنده تأییدشده», order page «✓ فروشنده تأییدشده» (unreachable) |
| `Seller.sellerStatus` (enum) | Marketplace governance | ADMIN via `transitionSellerStatus` (state machine + row lock + audit + self-governance ban) | P2-E flow | Marketplace visibility gate (suspended/rejected offers vanish) |
| `Seller.status` (string) | Legacy Phase-1 display string | onboarding writes `PENDING_REVIEW` | creation | Admin UI text only |

Findings from the audit:
- `verified` was dead code that still powered two customer-facing badges — a latent overclaim waiting to be switched on by whoever first "fixed" the flag.
- **Live conflation bug found:** `cart/page.tsx:38` hardcoded `{sellerName} · DEMO` — the real seller's cart line claimed to be DEMO data.
- The audit sentinel seller row (`audit-system`, `status:"SYSTEM"`) was neither demo nor real; origin semantics had no value for it.
- `sellerStatus=ACTIVE` and `isRealSeller=true` had no verified/verification meaning at all — correct, and now enforced structurally.

## 2. The new model (three independent axes)

| Axis | Field | Values | Authority | Meaning |
|---|---|---|---|---|
| **ORIGIN** | `Seller.sellerOrigin` | `DEMO` · `REAL_ONBOARDING` · `SYSTEM` | SYSTEM (onboarding/seed/migration only) | *How the seller entered.* Never implies verification. `SYSTEM` = audit bookkeeping row, never displayed as a seller |
| **VERIFICATION** | `Seller.sellerVerificationStatus` | `UNVERIFIED` · `PENDING_REVIEW` · `VERIFIED` · `REJECTED` | ADMIN only, via `setSellerVerificationStatus` | *The admin-recorded decision in this system.* **NOT** a legal/business-registry claim |
| **GOVERNANCE** | `Seller.sellerStatus` | `PENDING` · `ACTIVE` · `SUSPENDED` · `REJECTED` | ADMIN only (P2-E state machine, unchanged) | Marketplace participation |

Invariants (machine-enforced, not convention):
1. `REAL_ONBOARDING` does **not** mean `VERIFIED`.
2. `sellerStatus = ACTIVE` does **not** mean `VERIFIED`.
3. `VERIFIED` means exactly what `setSellerVerificationStatus` recorded — scoped wording «تأیید شده در سیستم» everywhere, never «کسب‌وکار قانونی».
4. Verification state machine: `UNVERIFIED → {PENDING_REVIEW, VERIFIED, REJECTED}`; `PENDING_REVIEW → {VERIFIED, REJECTED, UNVERIFIED}`; `VERIFIED → {UNVERIFIED, REJECTED}`; `REJECTED → {UNVERIFIED, PENDING_REVIEW}`. `REJECTED → VERIFIED` directly is **impossible** (fresh review required).
5. Evidence (`verifiedAt`, `verificationActor`, `verificationNote`) is written only with a `VERIFIED`/`REJECTED` decision and cleared on revocation — no stale evidence, no fabricated timestamps.
6. Every verification mutation writes an audited `SellerEventLog` row (`seller_verification_changed`, meta: from/to/origin/note) inside the same transaction.
7. Legacy flags stay derived and in sync: `verified ≡ (sellerVerificationStatus = VERIFIED)`, `isRealSeller ≡ (sellerOrigin = REAL_ONBOARDING)`. Integrity probe asserts zero drift.

## 3. Migration details

`prisma/migrations/20260923_p2g1_seller_trust_model/migration.sql` (idempotent: `DO $$ … duplicate_object` guards, `IF NOT EXISTS`, guarded updates):

- Adds `SellerOrigin`, `SellerVerificationStatus` enums + `sellerOrigin`, `sellerVerificationStatus`, `verificationNote`, `verificationActor`, `verifiedAt` columns + 2 indexes.
- Backfill: `isRealSeller=true → REAL_ONBOARDING`, else `DEMO`; the `audit-system` sentinel explicitly `SYSTEM`. Verification: everyone `UNVERIFIED` except legacy `verified=true` rows (none exist — flag was dead). No evidence rows fabricated.
- Deploy-time discovery: the DB's `_prisma_migrations` ledger had drifted from reality — p2c/p2d/p2e/p2f/p2g migrations had been applied manually (documented in run.md) but three ledger rows were unfinished. Since `prisma migrate diff` proved the DB matched the pre-G.1 schema exactly (only delta = G.1 columns + two documented intentional-drift items), the ledger was repaired with `migrate resolve --applied` (truthful marking, no SQL execution) and `migrate deploy` then applied only the new G.1 migration. **The ledger now matches reality for the first time; `prisma migrate deploy` works on this DB.**
- Dev server held the pre-migration Prisma client → PDP briefly 500 until a documented runbook restart; not a data or code defect.

## 4. Findings and fixes

| # | Finding | Fix |
|---|---|---|
| F1 | `verified` dead column powering two unreachable overclaiming badges | Replaced by derived flag; badges rewritten from the authoritative axis with scoped wording |
| F2 | Cart hardcoded «· DEMO» on every line (real seller mislabeled) | `sellerOriginLabelFa()` derived label |
| F3 | Sentinel seller `audit-system` had no honest origin value | `SellerOrigin.SYSTEM` reserved value |
| F4 | No admin verification flow at all | `setSellerVerificationStatus` + `setSellerVerificationAction` + admin UI column (below) |
| F5 | Migration ledger drift blocked `migrate deploy` | Ledger repaired truthfully (see §3) |
| F6 | Seller profile page showed raw `verified` boolean («بله/خیر») | Shows origin + scoped verification + decision date, read-only |

## 5. Security results

- **P2-G adversarial probes: 13 PASS / 0 FAIL** (9 existing + 4 new: trust-axes-immune-to-profile-injection, forged-verification-value-denied, onboarding-cannot-smuggle-trust-fields, verification-audited-and-revocable).
- **P2-G commerce probes: 5/0** · **P2-E probes:** GUEST_IDOR SAFE, CANCEL_ATTACK SAFE.
- **DB integrity: 23 checks OK / 0 violations** (15 existing + 8 new: origin/verification missing, legacy-flag sync, demo-marked-verified, verified-without-evidence, verified-without-audit-event, stale evidence, sentinel origin).
- Authority map (server-enforced): `sellerOrigin` — no API writes it after creation; `sellerVerificationStatus` — only `setSellerVerificationStatus`, reached only via `requireAdmin` server action; `sellerStatus` — unchanged P2-E path. Profile updates are Zod-whitelisted; smuggled trust fields are ignored (probe-proven). `SELF_VERIFICATION` guard mirrors `SELF_GOVERNANCE`.
- **Accepted risk (unchanged, documented):** `governance.ts` services are trusted-internal APIs — the lib-level functions trust the `adminUserId` passed to them; the security boundary is `requireAdmin()` in the server actions. Lib-level hostile calls are probe-documented, not hidden.

## 6. Live Preview results (real browser, not just HTTP 200)

- **Customer:** home → PDP `radiator-assembly` → offers verified: demo offers «فروشنده نمایشی · داده‌ها DEMO هستند», real offer «فروشنده واقعی (ثبت‌نام از طریق پلتفرم)» with **no trust badge**; added real offer to cart (cart count 3→4); cart line truthful (F2 fix visible); checkout rendered all 3 sellers truthfully with fitment warnings intact. Payment deliberately NOT completed (would mutate the real offer's stock).
- **Admin:** login → `/admin/sellers` shows origin badges (سیستمی/نمایشی/ثبت‌نام واقعی) + verification state per seller; clicked «تأیید در سیستم» on the real seller → badge switched to «تأیید شده در سیستم», actions switched to [لغو تأیید]; audit row recorded with session-derived admin id; clicked «لغو تأیید» → state back to UNVERIFIED, evidence cleared, full trail (UNVERIFIED→VERIFIED→UNVERIFIED) in the log.
- **Seller:** login → `/seller/profile` shows «منشأ: … · وضعیت تأیید: …» as read-only system fields; only display fields editable. Forgery paths covered by probes/tests (server-side whitelists).
- Truth matrix probe (Case A–E + live combos): **6/6 PASS** — `scripts/probe-p2g1-truth-matrix.mts`.
- Browser console: clean (dev-log noise only). PDP/search/home HTTP 200 post-restart.

## 7. Final tests/build

```
TypeScript:        npx tsc --noEmit → 0 errors
Full suite:        191/191 (16 files) — includes 13 new P2-G.1 tests
Full suite ×2:     run 2: 191/191 · run 3: 191/191 (two consecutive clean passes)
                   (run 1 of the re-run had one transient failure — see §8 risk R1;
                    targeted loop of the new file: 3/3 PASS)
P2-G file loop:    tests/p2g1-seller-trust.test.ts → 3/3 PASS
Adversarial:       probe-p2g-adversarial 13/0 · probe-p2g-commerce 5/0 · P2-E probes SAFE
Truth matrix:      probe-p2g1-truth-matrix 6/0
DB integrity:      23 OK / 0 violations
Build:             ✓ Compiled successfully · 31/31 static pages
Preview:           restarted per runbook (new Prisma client) — PDP/search/home/cart/checkout/admin/seller all walked live
```

## 8. Remaining accepted risks

- **R1 — one transient test failure in one of three full-suite runs** (file not captured before re-run; targeted 3× loop of every new-file test passed, and two subsequent consecutive full runs were 191/191). Likelihood low; DB-timing flake suspected, not reproduced.
- **R2 — demo auth remains phone-allowlist-based** (P2-G known limitation; real credential provider is a future auth milestone).
- **R3 — verification is a recorded admin decision only.** The system proves an admin reviewed the seller *in this system*; it does not verify legal identity or business registration, and no UI string claims it does.
- **R4 — governance/verification services are trusted-internal APIs** (documented since the P2-G audit); action-layer `requireAdmin` is the boundary.

## 9. Exact truth status of the current seller

| Item | Value |
|---|---|
| Real seller | «لوازم یدکی البرز (واقعی)» — Karaj, owner `cmu41kwka0003txbohgm6ax4u` |
| Origin | `REAL_ONBOARDING` (onboarding 2026-09-21, audited) |
| Verification | `UNVERIFIED` — no verification decision stands (the walkthrough's verify+revoke round-trip is fully audited in `SellerEventLog`) |
| Governance | `ACTIVE` (admin-approved 2026-09-21, audited) |
| Real offer | 1 (real part `radiator-assembly`, REVIEW_REQUIRED catalog data; price/stock placeholders entered by the seller through the real form) |
| Demo data | 41 parts · 3 demo sellers (DEMO origin, UNVERIFIED) · audit sentinel `SYSTEM` origin |
| Real GLB | NOT YET ACQUIRED (unchanged) |
| Verified catalog | 0 (12 REVIEW_REQUIRED) (unchanged) |

> **One sentence:** origin says how a seller arrived, verification says what an admin decided in this system, sellerStatus says whether they may sell — no field implies another, and no customer-facing string claims more than the database proves.
