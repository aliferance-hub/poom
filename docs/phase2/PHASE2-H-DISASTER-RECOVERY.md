# P2-H — Disaster Recovery (H15)

Status markers: **VERIFIED** (actually executed) / **NOT VERIFIED** (designed,
never tested) / **NOT CONFIGURED** / **UNKNOWN** (cannot inspect).
Honesty rule: nothing here is claimed verified unless it was executed in P2-H.

---

## 1. Verified backup & restore evidence (2026-09-26)

| Step | Result |
| --- | --- |
| Full logical export of prod `public` schema (`pg_dump` → SQL, 145 KB) | **VERIFIED** |
| Restore into a fresh scratch local database (created `poom_dr_proof`) | **VERIFIED** |
| Post-restore integrity: 37 tables; Part 43 / Offer 93 / Seller 3 / AssetVersion 2 / PartInquiry 0 — matches prod exactly | **VERIFIED** |
| Scratch DB dropped afterwards | **VERIFIED** |
| Destructive restore **against the live prod DB** | deliberately **NOT TESTED** (and must not be) |

## 2. Export / restore procedure (the one that is proven)

Export (note: on this Windows/MSYS environment, `-f` produces an empty file —
use shell redirection; tooling quirk documented in `.freebuff/run.md`):

```bash
PGPASSWORD='…' pg_dump -h aws-0-ap-northeast-1.pooler.supabase.com -p 5432 \
  -U postgres.xhfugrjoltoirjvbmdbq -d postgres \
  --schema=public --no-owner --no-privileges \
  > poom-prod-$(date +%Y%m%d).sql
```

Restore into a fresh scratch database (never into prod interactively):

```bash
createdb poom_restore && psql -d poom_restore -q -f poom-prod-YYYYMMDD.sql
# verify row counts vs the pre-disaster figures above, then switch over
```

Practical rules:

- Export via the **session pooler :5432** (transaction pooler :6543 is for OLTP;
  long-running dump sessions are inappropriate there).
- The direct DB host (`db.<ref>.supabase.co`) is **IPv6-only** and unreachable
  from this Windows workstation (no IPv6 route) — the pooler is the only path.
- A dump file restores only the `public` schema; roles/extensions/vault live in
  Supabase-managed schemas and are re-created by the platform.

## 3. Platform backup posture (Supabase)

| Capability | Status | Notes |
| --- | --- | --- |
| Supabase managed backups | **UNKNOWN / NOT VERIFIED** | Backup schedule/retention is a plan-level dashboard setting; the MCP toolset here exposes no backup inspection. Assumption: **none configured** until the owner confirms in the Supabase dashboard. |
| Point-in-time recovery (PITR) | **UNKNOWN / NOT CONFIGURED** | Same visibility limit; PITR requires a paid add-on. |
| Self-managed export (§2) | **VERIFIED** | Repeatable today; the only guarantee that actually exists. |

**Action item for the owner:** confirm backup schedule/retention in the
Supabase dashboard (Database → Backups). Until then, treat §2 as the entire
recovery capability and schedule the export (e.g. weekly) manually.

## 4. What is and is not covered

Covered by the verified procedure: all application data (catalog, offers,
inquiries, sessions, asset metadata).

NOT covered (and why):

- **Supabase Storage objects** (post-P2-H: uploaded GLB binaries). They are
  backed up only by re-exporting from Storage; DB rows reference keys, not
  bytes. Storage assets are derivable from provenance (license/source metadata)
  only by re-downloading the source — not automatic. A full DR cycle after H5
  must include a Storage `list/GET` pass (NOT YET APPLICABLE — bucket is empty).
- **Supabase auth users** — none exist (no Supabase Auth usage).
- **Secrets** — Vercel/Supabase tokens are external to this procedure.

## 5. Recovery targets (declared, not contractual)

| Metric | Target today | Basis |
| --- | --- | --- |
| RPO | ≤ 7 days (manual export cadence) | one successful export exists |
| RTO | < 1 hour | fresh Postgres anywhere + `psql -f` + `prisma generate` + redeploy |

These are honest engineering targets for a pre-GA dataset, not SLAs.

## 6. Failed-restore drill checklist (repeatable)

1. `createdb` scratch → restore → count tables/rows (§2) → drop scratch.
2. `prisma migrate status` against the restored DB → up to date.
3. Point local `DATABASE_URL` at the restored DB → `npm run dev` → home, PDP,
   `/api/health` all 200.
