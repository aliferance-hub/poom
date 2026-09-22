# P2-C — Search 2.0

Date: 2026-09-14 · Status: implemented + verified

## Architecture

```
SearchInput { query, vehicleContext?, categoryId?, brandId?,
              compatibleOnly?, page?, pageSize?, sort? }
        │
        ▼
SearchProvider (interface)          ← swap point (FTS / Meilisearch later)
        │  PostgresSearchProvider (the only implementation)
        ▼
1. Retrieval  — indexed candidate query (take 300)
2. Scoring    — deterministic, in-memory (weights below)
3. Fitment    — rules JOINed in the SAME part query, resolved through
                resolveFitmentFromRules (the ONE engine, pure core)
4. Filtering  — compatibleOnly: only COMPATIBLE survive
5. Grouping   — compatible → review-required → rest (incompatible demoted)
6. Paging     — slice(page*pageSize)
```

**Hard rule honored:** search never decides compatibility. The provider
batch-fetches fitment rows (one JOIN — `prisma.part.findMany` with
`fitments.include`) and feeds them to `resolveFitmentFromRules`, the exact pure
function `resolveFitment` wraps. Test-proven: a search issues **1 part query,
0 separate fitment queries** (no N+1), and flipping a fitment rule flips both
the engine verdict and the search verdict (consistency test).

## Ranking weights (deterministic, code: `src/lib/search.ts`)

| Signal | Points |
|---|---|
| Exact identifier match (normalized) | +1000 |
| Identifier substring | +400 |
| Exact title match | +500 |
| Title token hit | +2·len·10 |
| Other-field token hit (sku/category/brand/ids) | +len·5 |
| Vehicle has any fitment rows | +25 |
| Popularity | NOT IMPLEMENTED (no reliable data — honest omission) |

Ties break by title for stable ordering. No AI, no randomness.

## Vehicle-aware semantics (documented behavior)

- **No vehicle context** → plain text search, `fitment: null` on hits; UI shows
  «برای بررسی دقیق سازگاری، خودروی خود را انتخاب کنید.»
- **Context present** → every hit carries an engine verdict; groups ordered
  compatible → review → incompatible; **incompatible hits are demoted to the
  tail by default** (visible, honest) and **removed entirely by
  `compatibleOnly`** (the filter's verdict comes from the engine only).
- `?vehicle=<vehicleId>` deep link creates a *variant-less* context — deep
  links cannot prove a variant, so none is inferred (uncertainty stays
  uncertainty).

## Normalization

Two strategies, unchanged from P2-B:
- **Text** (`normalizeFa`): ي→ی, ك→ک, digit folding, ZWNJ→space, punctuation→
  space — «لنت ۲۰۶» ≡ «لنت 206» ≡ «لنت پژو 206».
- **Identifier** (`normalizeIdentifier`): Persian→English digits only, unify
  `-/space/_/./` → `-`, uppercase. `DEMO-206-001`, `ABC/206`, `MPN 206-01`
  stay matchable and distinct.

## Autocomplete + recent searches

- `GET /api/suggest?q=` → grouped JSON: `parts`, `categories`, `brands`,
  `identifiers`, `vehicles` (5 parallel indexed queries, each take ≤6).
  Backend failure → `503 {error:"SEARCH_UNAVAILABLE"}` — never a fake empty.
- `SearchBox` (client): 250 ms debounce, AbortController, combobox/listbox ARIA,
  outside-click close. Recent searches live in `localStorage`
  (`poom_recent_searches`, max 6) with «پاک کردن جستجوها» — guest-scoped by
  design; nothing sensitive is stored.

## Zero-result semantics

`NO_RESULTS` (nothing matched) vs `NO_COMPATIBLE_RESULTS` (candidates existed
but none COMPATIBLE under the active filter) are distinct flags rendered as
distinct Persian states with recovery actions (remove filter / change vehicle /
simpler query).

## Performance notes

- Measured dataset (43 parts): search ≈ single 2–5 ms DB query + in-memory
  scoring; autocomplete ≈ 5 indexed queries in parallel. Numbers are
  dataset-bound, NOT production-scale claims.
- `take: 300` caps candidate scan; pagination applied after grouping.
- When the catalog grows past in-memory scoring comfort, the provider interface
  accepts a Postgres FTS/tsvector implementation behind the same `SearchProvider`
  contract — no business-logic rewrite.
