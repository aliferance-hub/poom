# ADR-001 — Stack & Toolchain

Date: 2026-09-14 · Status: accepted

## Versions (resolved against npm registry, not blind "latest")

| Package | Chosen | Why not latest |
|---|---|---|
| next | **15.5.25** | latest 16.x is a new major; plan pinned Next 15 App Router |
| react / react-dom | **19.2.8** | 19.3.0 breaks @react-three/fiber peer (`>=19 <19.3`) |
| @react-three/fiber | 9.7.0 | compatible with react 19.2 |
| @react-three/drei | 10.7.8 | peer `fiber ^9, react ^19, three >=0.159` ✓ |
| three | 0.186.0 | — |
| prisma + @prisma/client | **6.19.3** (matched pair) | 8.0.0-rc.14 is RC; 7.x client/CLI mismatch |
| typescript | 5.9.3 | TS 7 = native preview toolchain, not for production |
| tailwindcss | 4.3.3 (+@tailwindcss/postcss) | v4 `@utility` syntax, no config file needed |
| vitest | 3.2.7 | latest 5.x requires vite 6/7/8 line not otherwise needed |
| zod / zustand | 4.6.4 / 5.0.15 | latest stable, no conflicts |

## Toolchain (this machine)

- **Portable Node v22.23.2** in `tools/node` (C: is 100% full; no admin install; npm cache/TMP redirected into workspace via `scripts/env.sh`).
- **Portable PostgreSQL 18.6** in `tools/pgsql`, cluster `.pgdata/` on **127.0.0.1:5433**, trust auth, db `poom`.
- **Critical:** postgres must be launched with a native Windows parent (`powershell Start-Process` on `pg_ctl`). Under the MSYS bash runtime its children die with shared-memory error 487. `psql.exe` also hangs in the MSYS console — admin SQL goes through `scripts/sql.mjs` (node-pg).
- App env: `poom/.env` → `postgresql://postgres@127.0.0.1:5433/poom`; payments mocked via `MockPaymentAdapter` (`MOCK_PAYMENTS=1`).

## Architecture invariants (from the PRD, enforced in code)

- Catalog ≠ Commerce ≠ 3D: `lib/catalog.ts`, `lib/cart.ts`+`lib/checkout.ts`, `lib/registry3d.ts` are independent; `Mesh → Mapping → Part → Fitment → Offer` chain lives in DB (`Asset/AssetVersion/ZoneMeshMapping/PartMeshMapping`) — swapping the demo GLB for a licensed one touches data only.
- Money: canonical integer IRR in DB; Toman only at display (`lib/persian.ts`).
- Cart: PostgreSQL is source of truth; Zustand only mirrors the count (`store/cart-count.ts`), never authoritative.
- Payments: `PaymentService` interface + `MockPaymentAdapter`; state machine `PENDING → SUCCEEDED/FAILED` with transactional stock decrement only after success; retries create a new payment attempt.
- All data DEMO (`DEMO-206-*` SKUs, `isDemoData` flag, unverified sellers) — no fabricated OEM codes/prices/certifications.
