# P2-H — Production Migration Runbook (H3)

Canonical, reviewed process for every schema change from now on.
Established after reconciling the P3.1 bookkeeping drift (2026-09-26, see §6).

---

## 1. Connection modes (non-negotiable)

| Purpose | Endpoint | Why |
| --- | --- | --- |
| **Runtime** (Vercel functions, Prisma client) | pooled :6543 + `?pgbouncer=true&connection_limit=1` (`DATABASE_URL`) | Transaction-mode pooling matches serverless; many short-lived lambdas |
| **Migrations / CLI** (any `prisma migrate *`, `db pull`) | session pooler :5432 (`DIRECT_DATABASE_URL` → `directUrl` in `schema.prisma`) | DDL and advisory locks need a real session; pgbouncer transaction mode breaks locks/`CONCURRENTLY` |

`schema.prisma` wiring (already in place):

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_DATABASE_URL")
}
```

## 2. The canonical flow

```
Developer change
  → ① prisma migrate dev --name <change>   (LOCAL :5433 only)
  → ② review generated migration SQL        (non-destructive? additive?)
  → ③ commit migration + schema + code
  → ④ CI (tsc + tests + build)              (NO migration against prod in CI)
  → ⑤ merge → CI green
  → ⑥ production migration  (§4 command)
  → ⑦ verify  (§5 checklist)
  → ⑧ deploy / auto-deploy picks up code
```

Order matters: **schema first, then deploy the code that uses it.**
`migrate deploy` runs before the new code is live → old code keeps working on
the extended schema (additive changes are backward compatible).

## 3. Commands — what is allowed where

| Command | Local dev | Production | Notes |
| --- | --- | --- | --- |
| `prisma migrate dev` | ✅ | ❌ **NEVER** | Creates/rewrites history; shadows DB |
| `prisma migrate deploy` | ⚠️ (ok) | ✅ **the only prod migration command** | Applies pending migrations in order, no reset |
| `prisma migrate resolve` | — | ✅ (bookkeeping only, no DDL) | See §6 |
| `prisma db push` | ❌ | ❌ **NEVER** | Bypasses migration history |
| `prisma migrate reset` | local only | ❌ **NEVER** | Destroys data |

## 4. Production migration — exact procedure

Run from the repo root with the session-pooler URL. Never against a tunnel;
never through pgbouncer transaction mode.

```bash
# Linux/macOS/CI shell
DATABASE_URL="$PROD_POOLED" DIRECT_DATABASE_URL="$PROD_DIRECT" \
  npx prisma migrate deploy
```

Verification: `npx prisma migrate status` must end with
`Database schema is up to date!`.

## 5. Post-migration verification checklist

1. `prisma migrate status` → up to date.
2. Application smoke: `/`, `/api/health` (H16), one PDP, one server action.
3. `get_advisors(type=security)` / `type=performance` (Supabase MCP) after DDL.
4. If the change adds fields used by code → local `tsc --noEmit` + `npm test`
   must be green before the deploy that ships that code.
5. Record the migration in the phase log (`.freebuff/run.md`).

## 6. Drift detection & reconciliation (what happened with P3.1)

**Detection:** `prisma migrate status` reports pending migrations that you know
were applied by other means (manual `psql`, prior phase tooling).

**Diagnosis:** compare intended DDL with actual remote DDL
(`information_schema.columns`, `pg_indexes`, `pg_type/pg_enum`) or
`pg_dump --schema-only` of the affected objects.

**Reconciliation rules (non-destructive, in order of preference):**

1. **DDL identical** → record bookkeeping only:
   `prisma migrate resolve --applied <migration_name>`.
   This inserts the `_prisma_migrations` row; it executes **no DDL**.
   *Used 2026-09-26 for `20260926_p31_part_inquiries` after confirming the
   remote table/enum/indexes matched the migration file exactly.*
2. **DDL differs / missing** → author a new, corrective migration (additive)
   and `migrate deploy` it. Never fake-mark a migration applied when the
   objects do not match.
3. **Never** rewrite/delete existing migration files to "make status green".

**Emergency manual-apply path** (only when the Prisma CLI cannot reach the DB,
e.g. WAN timeouts): apply the file with `psql -f`, then immediately
`migrate resolve --applied` it. Every manual apply MUST be resolved in the same
session — that is exactly the drift this runbook exists to prevent.

## 7. Rollback / forward-fix strategy

Prisma has no down-migrations. Policy:

- **Forward-fix only**: a new migration that corrects the previous one.
- **Two-phase destructive changes**: phase 1 additive (new column/table, dual
  write), deploy; phase 2 removal after confirmation. Never DROP in the same
  release that stops using the object.
- **Before risky DDL**: note the backup posture (see
  PHASE2-H-DISASTER-RECOVERY.md) and verify a recent export exists.
- `migrate resolve --rolled-back <name>` is bookkeeping for a failed apply
  (its transaction rolled back); the fix is always a new migration.

## 8. Rules for migration authoring

1. Non-destructive by default: `ADD COLUMN` (nullable or with default),
   `CREATE INDEX`, `CREATE TABLE`.
2. One logical change per migration; reviewable SQL.
3. Enum creation uses the `DO $$ … EXCEPTION WHEN duplicate_object` pattern so
   the file stays safely re-runnable in the manual-apply path.
4. `CREATE INDEX CONCURRENTLY` cannot run inside a Prisma migration transaction
   — if ever needed, apply it via the emergency path (session psql, autocommit)
   and `resolve --applied`, documenting why.
5. Migration names carry the phase prefix (`p2x_…`, `p31_…`) for traceability.
6. Migration execution order is **alphabetical by folder name**. Every new
   migration must sort AFTER the migrations it depends on
   (`20260926_p99_…` was renamed from `_p2h_…` for exactly this reason —
   its RLS statements reference the `PartInquiry` table created by `p31_…`).
7. Supabase hardening migrations: the RLS baseline
   (`20260926_p99_rls_baseline`) enables row-level security with an empty
   policy set and revokes the blanket `anon`/`authenticated` grants. Any
   FUTURE table must be added to this baseline (or get its own RLS+grants
   migration), because Supabase default privileges re-grant to new tables.
   If client-side PostgREST access is ever introduced, explicit per-table
   policies are mandatory before shipping.
