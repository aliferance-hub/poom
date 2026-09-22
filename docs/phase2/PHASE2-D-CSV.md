# P2-D — CSV Import / Export

## Flow (§18)

```text
Upload (file or paste) → Parse → Validate (Zod, pure) → Preview (DB-backed) → Commit (all-or-nothing)
```

Nothing is written until the seller reviews the preview and commits. The preview table shows row number, part, SKU, price, stock and a per-row status with a Persian error for every invalid row.

## Contract (§58)

Header (required columns): `seller_sku, part_id, price_irr, stock, shipping_days_min, shipping_days_max, active`; optional `warranty_fa`. `active` accepts `1/0/true/false`. Money = integer IRR. Functions: `parseSellerInventoryCsv → previewSellerInventoryImport → commitSellerInventoryImport` plus `exportSellerInventoryCsv` (`src/lib/seller/seller-csv.ts`).

## Ownership (§20, mandatory)

`sellerId` in CSV is **ignored** — there is no such column in the contract. The commit's `updateMany` and the preview's offer lookup are both scoped to the authenticated seller. An unknown SKU and a **foreign** SKU produce the same Persian message («آفر با این seller_sku برای فروشگاه شما یافت نشد…») — no existence leak. Verified live: seller 1 importing seller 2's SKU → row INVALID, commit refused (`HAS_INVALID`), seller 2 untouched.

## Transaction strategy (§21): all-or-nothing

If **any** row is INVALID, nothing is written («یکی از ردیف‌ها معتبر نیست؛ هیچ تغییری اعمال نشد»). Valid files commit in one bounded transaction with per-row audit entries (`seller_offer_stock_updated` + a summary `seller_inventory_csv_imported`). Rejected files are audited as `seller_inventory_csv_rejected`. Rationale: a seller must never receive a half-applied inventory file; partial-commit UX is a later-phase option.

CSV can only **update existing offers** (matched by `seller_sku` + `part_id` consistency) — it can never create Parts or Offers (§19).

## Limits (§22)

| Limit | Value |
|---|---|
| Max file size | 2 MB (client and server enforced) |
| Max rows | 500 |
| Max field length | 4,000 chars (parser throws → fatal) |
| Encoding | UTF-8 with BOM tolerated; export prepends BOM for Excel |

Oversized files are rejected before parse and audited.

## Export (§23)

`GET /api/seller/inventory/export` streams **only** the authenticated seller's rows: `seller_sku, part_id, part_name, price_irr, stock, shipping_days_min, shipping_days_max, active, stock_updated_at, price_updated_at`. No customer data, no other sellers, no auth/payment fields.

## Formula-injection safety (§43)

Every text cell is passed through `csvSafe()`: values beginning with `= + - @ TAB CR` are prefixed with `'` (standard spreadsheet mitigation). Verified by test (SKU `=1+1` exports escaped).

## Known limitations

- Synchronous in-memory parsing only (bounded by limits; no background jobs by design).
- Encoding is UTF-8-only; Windows-1256 CSVs must be converted first.
- `part_id` mismatch with the SKU's offer is rejected rather than auto-corrected (deliberate: prevents cross-part writes).
