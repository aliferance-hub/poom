# P2-H — Baseline / Inventory (H0)

Date: 2026-09-26 · Baseline commit: `4403d8e` (branch `main`, clean tree)

Scope of this document: the state of the world **before** any P2-H change.
No secret values appear here — only variable names and scoping.

---

## 1. Hosting

| Item | Value |
| --- | --- |
| Platform | Vercel (git-integration auto deploy on `main` push) |
| Project | `poom` (`prj_38Edb88iPTKLhmlx3DYubl4VYUY5`), team `aliferance-hubs-projects` |
| Framework preset | Next.js (no `vercel.json`; no custom build/install/output config) |
| Build command | `prisma generate && next build` (set in `package.json`, commit `4403d8e`) |
| Node | 22.x (Vercel default for Next 15; exact runtime pinned by platform) |
| Latest verified deploy | `dpl_6mxNXaVkRtSANFg3JDmGWjrmBEg4` — READY for `4403d8e` |
| Public URL | https://poom-jet.vercel.app |

## 2. Database provider

| Item | Value |
| --- | --- |
| Provider | Supabase Postgres 17.6.1, region `ap-northeast-1` |
| Project ref | `xhfugrjoltoirjvbmdbq` (name `aliferance-hub-carip`) |
| Prisma client | 6.19.3; `datasource db` uses `env("DATABASE_URL")`, `directUrl = env("DIRECT_DATABASE_URL")` |
| Runtime connection | pooled (port 6543, pgbouncer transaction mode) |
| Migration connection | session pooler (port 5432) |
| Tables (`public`) | 37, all created by Prisma migrations |
| Extensions | plpgsql, pg_stat_statements, uuid-ossp, pgcrypto, supabase_vault |

## 3. Storage provider status

**NONE.** Supabase Storage is empty:

- `storage.buckets` → **0 rows** (no bucket has ever been created).
- No Supabase Storage SDK/REST usage anywhere in `src/`.

The de-facto asset store is the **local runtime filesystem**:

- Upload route `src/app/api/admin/assets/[assetId]/upload/route.ts`
  writes the file to `process.cwd()/public/<filePath>` at request time
  (`mkdir` + `writeFile` from `node:fs/promises`).
- `src/lib/asset-registry.ts` computes
  `filePath = uploads/assets/<assetId>/v<n>/<sanitized name>` and
  `fileUrl = /<filePath>` (web-root absolute; GLTFLoader requirement).
- The viewer resolves the ACTIVE version's `fileUrl` through
  `resolveContract()` (`src/lib/asset-registry.ts`).

**Why this is production-broken:** Vercel serves static files from the immutable
build snapshot. Files written to `public/` at request time are NOT served, and
the function filesystem is ephemeral. Today the only GLB on production is the
git-tracked placeholder (`public/models/peugeot-206-engineering-v1.glb`, 1.3 MB,
source `BUILTIN_PLACEHOLDER`). Any real admin upload silently vanishes on prod.

Git-tracked files under `public/` (2): the placeholder model and one demo
version file `public/uploads/assets/peugeot-206-main-v1/v2/...glb` (tracked from
local testing — candidate for removal in H5).

## 4. Asset storage behavior — current flow

```
POST /api/admin/assets/:assetId/upload
  → assertDemoTrust()            (admin session or demo gate)
  → formData()                   (size cap 25 MB, glTF magic check)
  → provenance fields (licenseType, creator, acquiredAt, intendedUsage, …)
  → createAssetVersion()         (DB row, status DRAFT, checksum, filePath computed)
  → mkdir + writeFile into process.cwd()/public/…   ← PRODUCTION BROKEN STEP
  → 201 { versionId, checksum, … }
```

Version lifecycle (unchanged by this phase): DRAFT → PROCESSING → READY →
ACTIVE (single-active invariant, archived predecessors; validateVersion rejects
uploads without complete provenance).

## 5. Environment variables (names + scoping only)

### Vercel — injected by Supabase↔Vercel integration (Production only, 16)

`SUPABASE_SECRET_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`,
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `POSTGRES_URL`, `POSTGRES_PRISMA_URL`,
`POSTGRES_URL_NON_POOLING`, `POSTGRES_USER`, `POSTGRES_HOST`,
`POSTGRES_PASSWORD`, `POSTGRES_DATABASE`.

### Vercel — manual project vars (Production + Preview, 8)

`DATABASE_URL` (pooled 6543), `DIRECT_URL` (session 5432), `DEMO_MODE`,
`MOCK_PAYMENTS`, `SESSION_TTL_DAYS`, `ADMIN_LOGIN`, `SELLER_LOGIN`,
`ALLOW_DEMO_IN_PRODUCTION` (Preview only — Production has no demo bypass and no
demo logins; auth fails closed in production).

### Committed env files

- `.env.example` — placeholders only (local `127.0.0.1:5433/poom`, demo phones).
- `.env*` — gitignored AND vercelignored (`.vercelignore`).
- Source scan: only `DATABASE_URL` / `DIRECT_DATABASE_URL` referenced via Prisma
  env block; **zero** `NEXT_PUBLIC_*` usages in `src/` (no server value leaks to
  the client bundle). `process.env` sites: `lib/prisma.ts`, `lib/auth/*`,
  `lib/demo-trust.ts`, `app/login/page.tsx` — all server-side.

## 6. Deployment commands

| Action | Command |
| --- | --- |
| Deploy (prod) | `git push origin main` → auto deploy |
| Deploy (CLI, fallback) | `node tools/vercel/.../index.js --prod` (outside repo; used in earlier phases) |
| Build locally | `npm run build` (= `prisma generate && next build`) |
| Tests | `npm test` (vitest, 191 tests / 16 files, `fileParallelism:false`) |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) |

## 7. Migration state — LOCAL vs REMOTE (prisma_migrations table)

Local `prisma/migrations/` has **15 migration dirs**. Remote `_prisma_migrations`
has **14 rows**.

| Migration | Local dir | Applied on prod |
| --- | --- | --- |
| 20260913230532_init … 20260923_p2g1_seller_trust_model (14) | ✅ | ✅ (all recorded) |
| **20260926_p31_part_inquiries** | ✅ | ⚠️ **DDL applied, NOT recorded** |

The P3.1 inquiry migration was applied to production via `psql -f` (P3.1
runbook) because the project runner timed out over WAN; `_prisma_migrations`
was never updated. Consequences: remote **schema** matches the Prisma schema,
but remote migration **bookkeeping** has drift → plain `prisma migrate deploy`
would attempt to re-apply `p31_part_inquiries` (its DDL is idempotent, but the
drift must be resolved properly — see PHASE2-H-MIGRATION-RUNBOOK).

`prisma migrate status` against prod is the next verification step (H2).

## 8. Security posture at baseline (carried findings)

- **RLS disabled on all 37 `public` tables** (Supabase advisor: critical). The
  app connects as the `postgres` role via server-side Prisma only, so RLS is not
  the current enforcement layer; but anon/authenticated roles hold full grants.
  P2-H documents this explicitly and evaluates least-privilege options (H10/H19).
- `eslint.ignoreDuringBuilds: true` in `next.config.ts`; no ESLint config or
  deps installed (H11 target).
- No CI (GitHub Actions: 0 workflows; `.github/` absent) (H10 target).
- No health endpoint (H16 target); no storage consistency checks (H8 target).
- Seed (`prisma/seed.mjs`) has no production guard (H14 target).
- Demo trust gate `assertDemoTrust()` throws `AUTH_REQUIRED` when
  `MOCK_PAYMENTS!=="1"` in production — fails closed; verified in P2-E.

## 9. Known limitations (baseline truth)

1. Asset uploads are not durable in production (local-FS write). **The only
   real GLB is NOT YET ACQUIRED** — the git-tracked model is a demo placeholder.
2. Migration bookkeeping drift for `p31_part_inquiries` (see §7).
3. RLS disabled on all public tables; app relies on server-side Prisma only.
4. No CI, no lint gate, no health endpoint, no backup verification.
5. README describes the old MVP (41 parts / 92 offers / 16 tests); actual prod
   data: 43 parts, 93 offers, 191 tests — H21 target.
6. GitHub fine-grained PAT cannot manage repo Actions settings (403); workflow
   files CAN be pushed and will run.

## 10. Reality status (unchanged by P2-H unless DB proves otherwise)

```
REAL SELLER: 1        VERIFIED SELLER: 0
REAL OFFER: 1         VERIFIED CATALOG: 0
REAL GLB: NOT YET ACQUIRED
DEMO DATA: present, clearly separated (DEMO prefixes, MVP footer)
```
