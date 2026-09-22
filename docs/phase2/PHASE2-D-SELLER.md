# P2-D — Seller Portal Architecture

## Identity (the core fix)

Phase 1 shipped `/seller` as a **public demo page where the browser chose the seller via `?seller=<id>`** — the known MVP-audit finding SEC-1. P2-D replaces that trust model:

```text
poom_uid cookie (set only by demo login action)
  → User row (role verified server-side)
    → Seller (unique userId link)
      → every query/mutation scoped by this derived sellerId
```

- `getAuthenticatedSeller()` (`src/lib/seller/seller-auth.ts`) is the only identity source for portal pages/actions/routes. It returns `null` for guests, CUSTOMER users, ADMIN users, and Sellers without a login — callers treat null as `404`/redirect (no existence leak).
- `demoLoginAction` verifies the phone against `SELLER_LOGIN`/`ADMIN_LOGIN` (server-side env values, never shipped to the client) and sets the `poom_uid` HttpOnly cookie. The guest `poom_sid` (cart/garage) is untouched by login.
- The old public page is preserved verbatim at **`/seller-demo`**; the session-gated portal is **`/seller`**.
- **Never accepted from the browser:** sellerId, userId, ownership claims. `offerId`/`sellerOrderId` are data — ownership is re-checked server-side in every mutation's WHERE/lock.
- Test-only identity mirrors live in `seller-auth-test.ts`, asserted to never appear in route surfaces.

## Routes

| Route | Purpose |
|---|---|
| `/login` | demo login (lists demo phones — demo environment only) |
| `/seller` | dashboard: فروش امروز، سفارش‌های جدید، آفرهای فعال، کم‌موجود/ناموجود، لغو سفارش، امتیاز |
| `/seller/offers` | list + filter (فعال/غیرفعال/موجود/کم‌موجود/ناموجود) + sort + search + pagination + inline editor |
| `/seller/inventory` | buckets, freshness, CSV import panel, CSV export |
| `/seller/orders` + `/seller/orders/[id]` | seller order list/detail with explicit state machine |
| `/seller/profile` | editable seller-owned fields; verified/rating/status rendered read-only |
| `/api/seller/inventory/import` | POST preview (no writes), PUT all-or-nothing commit |
| `/api/seller/inventory/export` | seller-scoped CSV, formula-injection-safe |
| `/api/seller/logout` | clears `poom_uid` |

## Offer ↔ Catalog boundary

Seller edits **only**: `price, stock, sellerSku, shippingDaysMin/Max, warrantyNote, active` (Zod whitelist `seller-validation.ts`). Immutable Catalog data (part title/SKU/category/fitment) renders as read-only text — visually separated in the editor (§47). No seller surface can write Part/Fitment/Category/Zone/Asset (asserted by test scanning the seller service exports).

## Services

`src/lib/seller/`: `seller-auth` (identity) · `seller-offers` (queries+mutations) · `seller-inventory` (freshness/buckets/summary) · `seller-orders` (list/detail/state machine) · `seller-csv` (parse/validate/preview/commit/export) · `seller-metrics` (real-DB metrics + deterministic demo score) · `seller-service` (dashboard/profile) · `seller-audit` (SellerEventLog writer).

## Metrics & demo labeling

All dashboard/metric values come from real DB aggregates (`getSellerMetrics`, `getInventorySummary`). The demo dataset cannot support real sales analytics — every seller page therefore carries the badge **«داده نمایشی»**, and the score card shows its deterministic formula (۴۰٪ fulfillment + ۳۰٪ کم‌بودن لغو + ۳۰٪ امتیاز مدیریت). `responseTimeDays` is explicitly `null` (no data source) and renders as «—» elsewhere; nothing is fabricated.
