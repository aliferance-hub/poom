# P2-F — Catalog Report (F3–F7)

## Dataset classification (current DB, `poom`)

| Dataset | Count | dataStatus | sourceRef | Classification |
|---|---|---|---|---|
| Synthetic 206 parts (P1/P2-B seed) | 43 | `DEMO` | — | SYNTHETIC/DEMO |
| **Real imported 206 rows** | **12** | `REVIEW_REQUIRED` | `public-206-maintenance-documentation` | **REAL — UNVERIFIED (awaiting admin verification)** |
| Fitment rules on real rows | 13 | family-level CONFIRMED + engine-level negative | sourced in `fitmentNote` (`source: public-206-maintenance-documentation`) | REAL, engine split explicit |
| Offers on real parts | 1 (dev-marked) + cart/checkout flows exercised | — | — | DEV data, clearly labeled |
| Sellers | unchanged | — | — | SYNTHETIC (per F6, real sellers NOT invented) |

The 12 real rows: `radiator-assembly`, `radiator-fan`, `thermostat`, `water-pump`, `oil-filter`, `air-filter`, `alternator`, `timing-belt`, `head-gasket`, `front-brake-pad`, `front-brake-disc`, `front-shock-absorber` — all with `titleEn`, technical description, category/brand/assembly, and `sourceUpdatedAt`.

## Provenance model (enforced, not optional)

- Batch-level: `sourceRef` (required), `sourceUrl`, **`sourceUpdatedAt` (required — F10 fix)**, `createdBy`, format.
- Part-level: `sourceRef`, `sourceUrl`, `sourceUpdatedAt`, `dataVersion`, `dataNotes` (batch label), `dataStatus`.
- Import NEVER births a row `VERIFIED`; it lands `REVIEW_REQUIRED`. Admin verification is a separate act.
- Import NEVER overwrites a `VERIFIED` part — such rows become `CONFLICT` and are surfaced to the admin, not silently applied.

## Import pipeline (F5) — `src/lib/catalog-import.ts` + `/admin/imports`

`RAW → normalize (Persian + identifier normalization, display text preserved) → validate (required headers, identifier or SKU, negative price/stock/shipping ranges, unknown assembly/category → row INVALID) → admin review (per-row status) → approve → atomic commit (single transaction, all-or-nothing)`.

Deterministic row actions on commit: `CREATE` / `UPDATE` (re-marks `REVIEW_REQUIRED`) / `UNCHANGED` / `DEPRECATE` / `CONFLICT` (target VERIFIED). Duplicate detection by normalized identifier + SKU, in-batch and against DB (`externalKey` stores the RAW value — F5 fix, see Final Report).

## Fitment (F4)

All real-part compatibility flows through the central Fitment Engine (`resolveFitment`) — no second algorithm. Verdict semantics preserved: missing rules ⇒ `REVIEW_REQUIRED`, never silent `COMPATIBLE`. Real regression set (`tests/p2f-fitment-real.test.ts`): family-level compatible, TU3/TU5 head-gasket explicit negative, year boundary, missing-context ⇒ REVIEW_REQUIRED.

## Seller separation (F6)

Canonical Part carries no price/stock; Offer carries only seller-owned fields and references the Part. Seller mutations cannot touch canonical identity, fitment, mapping, or vehicles (P2-D/P2-E authorization tests continue to pass). A future real seller enters via the existing authenticated portal path with zero model changes.

## Real end-to-end path (F7, proven in DB and preview)

`zone_cooling (mesh) → MeshMapping → radiator-assembly (REAL part) → Fitment (COMPATIBLE for تیپ ۵/TU5 via engine rule) → Offer (dev-marked) → cart → checkout → SellerOrder` — `tests/p2f-end-to-end.test.ts` + live preview walkthrough (PDP shows fitment explanation citing the source note, add-to-cart, cart totals).
