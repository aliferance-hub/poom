# POOM — پوم | فروشگاه بصری سه‌بعدی قطعات خودرو (MVP)

> ماشینت را انتخاب کن. قطعه را روی آن پیدا کن. بخر.

مارکت‌پلیس نمایشی قطعات یدکی با کشف بصری سه‌بعدی — مطابق طرح محصول: **انتخاب خودرو → نمای سه‌بعدی → ناحیه → اسمبلی → قطعه → سازگاری → مقایسه فروشنده‌ها → سبد چندفروشنده‌ای → پرداخت Mock → سفارش + SellerOrder → کاهش موجودی**.

⚠️ **همه داده‌ها DEMO هستند** — `DEMO-206-*` SKUها، فروشنده‌های نمایشی، قیمت‌های نمونه. هیچ کد OEM، قیمت، ضمانت یا فروشنده واقعی در این نسخه وجود ندارد.

## Quick start (this worktree)

```bash
. scripts/env.sh                 # PATH: tools/node + tools/pgsql (portable, no admin)
powershell -NoProfile -File scripts/pg-start.ps1     # PostgreSQL on 127.0.0.1:5433
cd poom
npm install && npx prisma migrate deploy && node prisma/seed.mjs
npm run dev                      # next dev -p 3010
```

- 206 → تیپ ۲/تیپ ۵، ۸ ناحیه، ۴۱ قطعه، ۹۲ آفر از ۳ فروشنده نمایشی
- جستجو با نرمال‌سازی فارسی (ی/ك، ارقام، نیم‌فاصله): «لنت ترمز ۲۰۶» ≡ «لنت ترمز 206»

## Verification

```bash
cd poom
npx tsc --noEmit   # strict
npm test           # 16 tests — شامل state machine پرداخت روی DB واقعی
npm run build
```

مسیر طلایی در UI: `/vehicles/peugeot/206/type-5` → کلیک روی ناحیه/قطعه در نمای 3D → صفحه قطعه → افزودن به سبد → `/checkout` → درگاه Mock → سفارش موفق → کاهش موجودی (فقط پس از پرداخت موفق، داخل یک تراکنش).

## Architecture (key invariant)

**Catalog ≠ Commerce ≠ 3D** — `src/lib/catalog.ts` · `src/lib/cart.ts` + `src/lib/checkout.ts` + `src/lib/payments.ts` · `src/lib/registry3d.ts`

زنجیره: `3D Mesh → ZoneMeshMapping/PartMeshMapping → Part → Fitment → Offer → Seller`
مدل جایگزین (primitives) با همان Asset Contract بسته شده؛ برای جایگزینی با GLB لایسنس‌دار فقط رکورد `AssetVersion` عوض می‌شود، بدون تغییر کد commerce.

- سبد: PostgreSQL مرجع حقیقت؛ Zustand فقط شمارنده UI
- پول: integer IRR در DB؛ نمایش تومان
- پرداخت: `PaymentService` + `MockPaymentAdapter` (درگاه واقعی بعداً پشت همین interface)
- سفارش: `Order → SellerOrder → OrderItem` (سبد چندفروشنده‌ای از روز اول)

See `docs/adr/ADR-001-stack.md` for version decisions and `../.freebuff/run.md` for the environment runbook.
