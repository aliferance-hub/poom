# P2-D — Inventory & Freshness

## Data model changes (additive)

- `Offer.shippingDaysMin/Max Int?` — backfilled from the legacy single `shippingDays`; seller services write both (the customer UI keeps reading the legacy field, unchanged).
- `Offer.stockUpdatedAt`, `Offer.priceUpdatedAt` — per-field freshness timestamps (`updatedAt` remains the row-wide marker). Backfilled to migration time.
- Indexes added: `Offer(sellerId, active)`, `Offer(sellerId, updatedAt)`, `SellerOrder(sellerId, status)`, `SellerEventLog(sellerId, createdAt)`, `SellerEventLog(event)`, `User(role)`, unique `Seller(userId)`.

## Freshness policy (documented, simple — §16)

`freshState()` in `seller-inventory.ts`: **fresh = stockUpdatedAt within the last 48 hours** (`FRESH_HOURS = 48`), otherwise `stale`. UI wording:
- fresh → `موجودی اخیراً بروزرسانی شده (امروز، HH:MM)`
- stale → `آخرین بروزرسانی: بیش از ۴۸ ساعت پیش`

No real-time sync claim is made anywhere. The threshold is a service constant surfaced in docs/UI — never hard-coded inside React components. Inventory status buckets reuse the Phase-1 threshold field `Offer.lowStockThreshold` (default 3): `موجود / کم‌موجود / ناموجود` via `bucketOf()`; the low-stock filter uses a row-level field comparison (`stock <= lowStockThreshold`, Prisma `fields` reference) so it is correct per-row and pagination-safe.

## Concurrency (§36, §37)

- **Seller stock update vs customer settlement:** the offer row is updated inside a transaction while settlement uses the Phase-1 conditional decrement (`updateMany where stock >= qty`). Both are single-row atomic writes; the final state is always one of the two valid linearizations — never negative stock, never a lost settlement (proven by Scenario A in the suite and 10/10 spike rounds; final stock ∈ {9−2, 9} depending on interleaving, order always PAID).
- **Two concurrent seller updates:** both transactions commit; last-committed-wins on the full seller-authored value set (Scenario B). No partial mixes because each write is one atomic UPDATE.
- **CSV commit vs manual edit:** CSV applies whole-row `set` values in one bounded transaction; a concurrent manual edit is serialized by row-level locking on UPDATE — deterministic last-writer-wins, no torn rows.
- Deliberately **no global serialization**: locks are per-row/per-seller; different sellers never contend.

## Server-authoritative stock

Stock is written only through `updateSellerOffer` / `commitSellerInventoryImport` (both Zod-validated, `stock ≥ 0`, integer) and settlement decrements. There is no client path that mutates stock — cart/checkout endpoints derive quantities server-side (Phase 1 guarantee, re-tested green).
