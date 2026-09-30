# POOM — پوم | فروشگاه بصری سه‌بعدی قطعات خودرو

> ماشینت را انتخاب کن. قطعه را روی آن پیدا کن. بخر.https://poom-jet.vercel.app/

مارکت‌پلیس قطعات یدکی با کشف بصری سه‌بعدی — **انتخاب خودرو → نمای سه‌بعدی → ناحیه → اسمبلی → قطعه → سازگاری → مقایسه فروشنده‌ها → سبد چندفروشنده‌ای → پرداخت Mock → سفارش + SellerOrder → کاهش موجودی**.

## وضعیت واقعی داده‌ها (Labels: DEMO / REAL / VERIFIED / NOT YET ACQUIRED)

| مورد | وضعیت |
| --- | --- |
| داده‌های نمایشی (کاتالوگ، قیمت‌ها، SKUهای `DEMO-*`) | **DEMO** — جدا و برچسب‌خورده |
| فروشنده واقعی (ثبت‌نام از طریق پلتفرم) | **REAL** — ۱ |
| فروشنده تأییدشده | **VERIFIED** — ۰ (تأیید اداری هنوز انجام نشده) |
| آفر واقعی | **REAL** — ۱ |
| کاتالوگ تأییدشده | **VERIFIED** — ۰ |
| مدل سه‌بعدی واقعی GLB | **NOT YET ACQUIRED** — فقط placeholder داخل ریپو |
| احراز هویت تولید | **NOT YET PRODUCTION-READY** — ارائه‌دهنده دمو (OTP واقعی در فاز بعد) |
| درگاه پرداخت | **MOCK** — `MOCK_PAYMENTS=1` (درگاه واقعی پشت همان interface) |

هیچ کد OEM، قیمت واقعی، ضمانت یا فروشنده واقعی خارج از موارد بالا وجود ندارد.

## Quick start (لوکال)

```bash
. scripts/env.sh                     # PATH: tools/node + tools/pgsql (portable, no admin)
powershell -NoProfile -File scripts/pg-start.ps1   # PostgreSQL on 127.0.0.1:5433
cd poom
npm install && npx prisma migrate deploy && node prisma/seed.mjs
npm run dev                          # next dev -p 3010
```

- ۲۰۶ → تیپ ۲/تیپ ۵، ۸ ناحیه، ۴۳ قطعه، ۹۳ آفر
- جستجو با نرمال‌سازی فارسی (ی/ك، ارقام، نیم‌فاصله): «لنت ترمز ۲۰۶» ≡ «لنت ترمز 206»
- Seed فقط روی دیتابیس محلی اجرا می‌شود؛ روی دیتابیس غیرمحلی با خطای واضح متوقف می‌شود (محافظ H14).

## Verification

```bash
cd poom
npx tsc --noEmit     # strict — TypeScript
npm run lint         # ESLint (next/core-web-vitals) — صفر خطا
npm test             # 212 tests در 17 فایل — روی DB واقعی (vitest، ترتیبی)
npm run build        # prisma generate && next build (لینت در build هم فعال است)
```

CI (`.github/workflows/ci.yml`) همین دروازه‌ها را روی GitHub Actions اجرا می‌کند: Node 22، Postgres 17 ephemeral، `prisma generate` → `db push` (فقط دیتابیس آزمون) → typecheck → lint → tests → build. CI هرگز مایگریشن تولید را اجرا نمی‌کند و هیچ راز تولیدی نمی‌گیرد.

## استقرار (Production)

- **Vercel**: پروژه `poom` متصل به GitHub — هر push روی `main` دیپلوی تولید می‌شود. Build: `prisma generate && next build`.
- **دیتابیس**: Supabase Postgres 17 (region ap-northeast-1). ران‌تایم از pooled (`:6543` + pgbouncer) و مایگریشن‌ها از session pooler (`:5432`) استفاده می‌کنند (`DATABASE_URL` / `DIRECT_DATABASE_URL`).
- **مایگریشن تولید**: فقط `prisma migrate deploy` — رویه کامل و آشتی‌سازی drift در `docs/phase2/PHASE2-H-MIGRATION-RUNBOOK.md`.
- **Storage**: Supabase Storage، باکت `assets` (public read) از طریق آداپتور `src/lib/storage/` — در تولید باینری‌ها هرگز روی فایل‌سیستم نوشته نمی‌شوند و کلید سرویس هرگز به مرورگر نمی‌رسد. آستانه بارگذاری بزرگ: فایل‌های بالای ۴ مگابایت باید از مسیر resumable (TUS) بروند (`docs/phase2/PHASE2-H-STORAGE.md`).
- **سلامت**: `GET /api/health` — فقط وضعیت بی‌خطر (بدون راز، بدون توپولوژی).

## Architecture (key invariant)

**Catalog ≠ Commerce ≠ 3D** — `src/lib/catalog.ts` · `src/lib/cart.ts` + `src/lib/checkout.ts` + `src/lib/payments.ts` · `src/lib/asset-registry.ts` + `src/lib/storage/`

زنجیره: `3D Mesh → MeshMapping → Part → Fitment → Offer → Seller`
مدل جایگزین (primitives) با همان Asset Contract بسته شده؛ برای جایگزینی با GLB لایسنس‌دار فقط رکورد `AssetVersion` عوض می‌شود، بدون تغییر کد commerce.

- سبد: PostgreSQL مرجع حقیقت؛ Zustand فقط شمارنده UI
- پول: integer IRR در DB؛ نمایش تومان
- پرداخت: `PaymentService` + `MockPaymentAdapter` (درگاه واقعی بعداً پشت همین interface)
- سفارش: `Order → SellerOrder → OrderItem` (سبد چندفروشنده‌ای از روز اول)
- Asset: مسیرهای شیء تغییرناپذیر (`uploads/assets/<assetId>/v<n>/…`)؛ بازنویسی شیء ممنوع؛ سازگاری Storage↔DB با `src/lib/asset-reconciliation.ts` پایش می‌شود

## مستندات فاز ۲

`docs/phase2/` — گزارش‌های B/C/D/E/F/F1/G/G1 و فاز H:
`PHASE2-H-BASELINE.md` · `PHASE2-H-STORAGE.md` · `PHASE2-H-MIGRATION-RUNBOOK.md` · `PHASE2-H-DISASTER-RECOVERY.md` · `PHASE2-H-FINAL-REPORT.md`

See `docs/adr/ADR-001-stack.md` for version decisions and `../.freebuff/run.md` for the environment runbook.
