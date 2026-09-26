# P2-H — FINAL REPORT

Phase: Production Infrastructure + Vercel/SUPABASE Hardening
Date: 2026-09-26 · Head at close: `267998e` (main, deployed)
Scope guard: no new features, sellers, catalog rows, GLB, P2-I work.

## P2-H RESULT

STATUS: PASS WITH ACCEPTED RISKS

## INFRASTRUCTURE

Vercel:
- Git auto-deploy verified end-to-end (`main` push → build → READY, 5 deploys this phase, latest `267998e` promoted to production alias `poom-jet.vercel.app`).
- Build = `prisma generate && next build` (fixes the Vercel no-postinstall gap); ESLint no longer ignored during builds (H11 closed).
- Runtime: Next.js functions in `iad1` (verified via response headers); DB in `ap-northeast-1` — latency gap measured (see H18 note / accepted risks).
- Env scoping verified via API: Production has no demo-login vars (fails closed); Preview only.

Supabase Postgres:
- PG 17.6, region `ap-northeast-1`; 37 public tables, 36 + RLS baseline applied.
- Migration history reconciled non-destructively: P3.1 bookkeeping (`resolve --applied`) + RLS baseline applied via psql then resolved; `prisma migrate status` = "up to date".
- **`prisma migrate deploy` now replays the FULL chain on a fresh database** (proven on scratch DB: 16 migrations, zero errors) — production migration path is standard again.

Supabase Storage:
- Storage adapter implemented (`src/lib/storage/`: `AssetStorage` contract + `LocalDevelopmentStorage`, `InMemoryStorage`, `SupabaseStorage`), configuration-driven, no new dependencies (plain `fetch` on `/storage/v1`).
- Bucket `assets` provisioned in production (SQL DDL for bucket creation; all object ops via Storage API per H8 rule).
- **Object backfill PENDING** (accepted risk #1): the v2 GLB object upload requires `SUPABASE_SERVICE_ROLE_KEY`, which is runtime-only in this environment; until backfilled, `resolveContract` falls back to the tracked static file path (site renders correctly).

GitHub CI:
- `.github/workflows/ci.yml`: `npm ci → prisma generate → migrate deploy (ephemeral DB) → seed → tsc → eslint (0 errors) → tests → build`, Node 22, Postgres 17 service container, no production credentials, no prod migrations.
- **PASS** on `267998e` (after two fixture-parity fixes: `c747ee8`, `a8966cd`).

## SECURITY

Secrets:
- Repo scans clean (no PATs, tokens, DB passwords, service keys tracked); `.env.example` placeholders only.
- Vercel sensitive env values are not even readable via API (verified — provisioning script pulls runtime keys only at runtime).
- No `NEXT_PUBLIC_*` leaks of server secrets (sweep); service-role key never reaches the browser (client only ever receives a public/derived URL).

Auth boundary:
- Root cause fix in `src/lib/demo-trust.ts`: with `MOCK_PAYMENTS=1` in production, `assertDemoTrust()` previously admitted anonymous mutations across 14+ call sites. Now fail-closed: production requires a real admin/seller session unless `ALLOW_DEMO_IN_PRODUCTION=1` is explicitly set (it is not, in Production).
- Demo logins (ADMIN_LOGIN/SELLER_LOGIN) exist only in the Preview environment; Production fails closed (verified via env API).

Admin:
- `/admin*` → 307 redirect for anonymous (live probe); admin mutations behind `requireAdmin`/demo-trust root gate; P2-E suite green.

Seller:
- Cross-seller IDOR/isolation suite green (p2d + P2-G probes); seller role mirrors reject suspended users; seller cannot touch fitment/catalog/3D surfaces.

Asset upload:
- Server-side only: session/admin gate → DB asset must exist → deterministic 400/401/404/413/415 mapping → 25 MB cap (documented rationale) → GLB magic-byte + extension/MIME validation → safe object key (traversal/absolute/encoded/null-byte/Unicode rejected) → immutable versioned path (no overwrite).
- Live prod probes: anonymous POST → 401; malformed JSON garage action → 400 (was 500).
- 21 dedicated adversarial tests (`tests/p2h-storage-security.test.ts`) green.

Storage access:
- Public-read model chosen for public 3D assets (customer rendering), admin-managed writes; private/signed-URL support present in the adapter for future restricted classes (documented in PHASE2-H-STORAGE.md).

## DATABASE

Schema sync:
- Local ≡ remote for application objects; 16/16 migrations in history; fresh-DB replay proven.
- Noted honestly: production DATA is 100% DEMO (43 parts / 93 offers / 3 sellers); the P2-F/G real records (12 real parts, real seller, real offer) exist only in the local golden dev DB and were deliberately NOT pushed to production in this phase.

Migration workflow:
- `docs/phase2/PHASE2-H-MIGRATION-RUNBOOK.md` — connection modes, canonical flow, allowed commands, reconciliation rules, rollback/forward-fix, authoring rules (incl. alphabetical-order dependency rule learned via `p99_rls_baseline`).

Backup/recovery:
- `docs/phase2/PHASE2-H-DISASTER-RECOVERY.md`.
- VERIFIED: full logical export of prod + restore into scratch DB + row-count parity + teardown (end-to-end).
- NOT CONFIGURED: automated backups/PITR on the current plan (visibility limited; restore capability = the verified manual procedure).
- Destructive restore against live prod: deliberately not tested.

Integrity:
- `probe-p2g-db-integrity` (23 checks) green after all changes; F10 dataset invariants green on fresh DB.

## TESTS

TypeScript: `tsc --noEmit` clean (every change batch).

Tests run 1: **212/212** (17 files).
Tests run 2: **212/212** (17 files).
Additional CI-parity evidence: 212/212 on a brand-new scratch DB (migrate deploy + seed) — proves the suite no longer depends on untracked local state.

Security probes:
- `probe-p2g-adversarial` 13/13, `probe-p2g-commerce` 5/5, `probe-p2g1-truth-matrix` 6/6, `probe-p2g-db-integrity` 23 checks OK, plus 21 new H7/H8 tests and live prod probes (H19/H20).

Concurrency: payment settle/cancel race, stock races, duplicate delivery races — all green (suite + probes).

Build: production `next build` green locally AND in CI.

Production smoke (H20, rerun on `267998e`):
- 200: `/`, `/search`, `/inquiry`, `/cart`, PDP (browser session verified: search → PDP → add-to-cart → cart shows item, counter=1), `/api/health` `{"status":"ok","checks":{"db":true}}`.
- Gates: `/admin`, `/seller` → 307; anonymous upload POST → 401; malformed garage POST → 400.

## FILE STORAGE

Old filesystem path: `process.cwd()/public/...` written at request time (silent no-op risk on Vercel static snapshot) — removed from the production flow; a `LocalDevelopmentStorage` provider keeps `npm run dev` behavior.
New storage: Supabase Storage (`assets` bucket) through the `AssetStorage` adapter, selected by env (`STORAGE_PROVIDER`/`SUPABASE_STORAGE_*`), object keys immutable per AssetVersion.
Migration status: adapter + registry + route migration DONE; object backfill PENDING (risk #1); reconciliation checks shipped (`asset_versions_without_storage`, `storage_objects_without_asset_version`, `active_asset_without_storage`).

## DEPLOYMENT

Preview: deploys READY; demo-logins env present here by design; `ALLOW_DEMO_IN_PRODUCTION=1` restricted to Preview.
Production: `267998e` READY + promoted to `poom-jet.vercel.app`.
Known environment limitations:
- Function region `iad1` vs DB `ap-northeast-1` → measured TTFB 9–17 s for SSR pages (PDP worst). Fix is a single region setting — deliberately deferred (recorded, not guessed).
- WAN pooler transient `P1001`s during long CLI sessions; `pg_dump -f` quirk on MSYS (use shell redirection) — documented in runbook/DR.

## REALITY STATUS

REAL SELLER: 1 (P2-G onboarding record) — exists ONLY in the local golden DB; production has 0.
VERIFIED SELLER: 0
REAL OFFER: 1 — local golden DB only; production has 0.
VERIFIED CATALOG: 0
REVIEW_REQUIRED: 12 real catalog rows — local golden DB only; production has 0 real rows.
REAL GLB: NOT YET ACQUIRED (tracked engineering placeholder served as v2; v1 demo archived).
DEMO DATA: 100% of production rows (43 parts / 93 offers / 3 sellers), clearly marked DEMO / DEMO_UNVERIFIED; separation enforced by origin fields and truth-matrix probes.

## ACCEPTED RISKS

1. **Storage backfill pending**: `assets` bucket exists but the v2 GLB object was not uploaded (service key is runtime-only here). Site renders via tracked-static fallback; reconciliation marks the pending backfill. Run the provided backfill from any environment holding the service key.
2. **No verified automated backups/PITR** on the current Supabase plan; recovery = verified manual `pg_dump` procedure. Data durability currently depends on running it.
3. **Cross-region latency** (iad1 ↔ Tokyo): 9–17 s TTFB SSR. Measured, documented; remedy (function region) deferred by decision, not oversight.
4. **Demo auth is still the production trust boundary** (explicitly NOT production-ready): demo-phone login flow remains; mitigated by preview-only scoping and the fail-closed root gate. Real auth provider remains a future phase.
5. **RLS deny-by-default with zero policies**: intentional (server-only data plane). Supabase advisor reports 36 INFO findings (`rls_enabled_no_policy`) — accepted by design; any future client-side Postgres access requires explicit policies first; new tables must extend the baseline.
6. **Resumable/TUS large-asset upload is designed, not implemented** (no real GLB exists yet); threshold (≥20 MB or ≥15 s) documented with rationale.
7. **Test hermeticity approach**: p2f* pipeline tests are written idempotent against existing state and were validated on a fresh DB (probe), but the canonical guarantee is "migrate+seed then run", as CI does.

## BLOCKERS FOR P2-I

None hard-blocking. Prerequisites to schedule:
1. Run the v2 GLB backfill (then flip env to Storage delivery).
2. Decide + apply Vercel function region (single setting; biggest UX lever).
3. Enable/confirm Supabase automated backups or put the manual export on a schedule.
4. Provision a service-role key channel for ops scripts (backfill/reconciliation) outside the workstation.
