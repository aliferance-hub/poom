# POOM — دستور کار برای هرمس

مارکتپلیس بصری سهبعدی قطعات خودرو (MVP). خودرو → نمای 3D → ناحیه → اسمبلی →
قطعه → سازگاری → مقایسهٔ فروشندهها → سبد چندفروشندهای → پرداخت → سفارش.

## قبل از هر کار: محیط را بالا بیاور

این پروژه روی یک worktree با ابزار پرتابل اجرا میشود. در **هر** شل، اول محیط را
source کن، وگرنه `node`/`psql` اشتباه برداشته میشود:

```bash
cd "/d/carip freebuff" && . scripts/env.sh
```

`env.sh` موارد زیر را تنظیم میکند:
- `PATH` → `tools/node` (v22.23.2) و `tools/pgsql/bin` (PostgreSQL 18.6 پرتابل)
- `PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres PGDATABASE=poom`
- `npm_config_cache`/`TMP` → داخل خودِ worktree (چون درایو C پر است)

سپس PostgreSQL (در صورت خاموش بودن):
```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pg-start.ps1
```
⚠️ باید از طریق یک پدر **native** (PowerShell) اجرا شود. اجرا زیر bash/MSYS باعث
خطای `could not reserve shared memory region ... error 487` میشود.
`-ExecutionPolicy Bypass` روی این هاست الزامی است.

## اجرای اپ

```bash
cd poom && npm run dev      # next dev -p 3010
```
آدرس: http://127.0.0.1:3010

## دستورهای تأیید (قبل از هر ادعای «انجام شد» اجرا کن)

```bash
npx tsc --noEmit    # باید ۰ خطا بدهد
npm test            # vitest — نباید هیچ تستی رد شود
npm run build       # قبل از build، سرور dev را متوقف کن
```

آخرین بیلد تأییدشده: `tsc` ۰ خطا · ۱۹۱ تست در ۱۶ فایل همه پاس · `npm run dev` پاسخ 200.

نکتهٔ P2-G.1: منشأ فروشنده (`sellerOrigin`)، وضعیت تأیید (`sellerVerificationStatus`) و
وضعیت فروشگاه (`sellerStatus`) سه محور مستقل‌اند؛ REAL_ONBOARDING به معنی VERIFIED نیست.
واژگان مشتری فقط از `src/lib/seller/seller-trust-label.ts` می‌آید. تغییر تأیید فقط از
`setSellerVerificationStatus` (ادمین + ممیزی). جزئیات: `docs/phase2/PHASE2-G1-SELLER-TRUST-REPORT.md`.

## قواعد سخت این پروژه

1. **دادهٔ DEMO را واقعی جا نزن.** همهٔ SKUهای `DEMO-206-*`، فروشندهها و قیمتها
   ساختگیاند. هر جا داده واقعی نیست، برچسبش باید بماند. این یک تصمیم طراحی است،
   نه چیزی که «بعداً درست میشود».
2. **Catalog ≠ Commerce ≠ 3D.** مرزهای دامنه:
   `src/lib/catalog.ts` · `src/lib/cart.ts` + `checkout.ts` + `payments.ts` ·
   `src/lib/registry3d.ts`. از این مرزها عبور نکن.
3. **سازگاری فقط از روی `fitments`.** اگر ردیف fitment نیست، UI باید
   «نیازمند بررسی» نشان دهد، نه «مناسب است». هرگز سازگاری را حدس نزن.
4. **پول = integer IRR در دیتابیس**؛ نمایش به تومان. هرگز از float برای پول استفاده نکن.
5. **مدل 3D فعلی placeholder است** (primitives، نه اسکن واقعی ۲۰۶). معماری طوری
   ساخته شده که GLB واقعی بدون تغییر منطق commerce جایگزین شود — قرارداد Asset را نشکن.
6. **محدودیتهای شناختهشده را پنهان نکن** — `docs/MVP-AUDIT.md` و
   `docs/phase2/*-SECURITY.md` را قبل از دست زدن به auth/checkout بخوان.
   موارد Critical/High هنوز باز هستند (باند اعتماد admin/seller، سبک `poom_sid`).

## ساختار

```
src/app/          مسیرهای Next.js App Router (store, seller, admin, api)
src/components/   UI به تفکیک دامنه (three/, catalog/, cart/, seller/)
src/lib/          منطق دامنه مستقل از فریمورک
prisma/schema.prisma      ۳۵ مدل
prisma/seed.mjs           دادهٔ دمو (۴۱ قطعه، ۹۲ آفر، ۳ فروشنده)
scripts/          ابزارهای محیط + اسپایکهای همزمانی
tests/            vitest
docs/             تصمیمهای معماری + گزارشهای فاز
```

## مستندات کلیدی

- `README.md` — تصویر کلی و مسیر راهاندازی
- `docs/MVP-AUDIT.md` — ممیزی تولیدی، مسائل Critical/High باز
- `docs/adr/ADR-001-stack.md` — انتخاب نسخهها
- `docs/phase2/PHASE2-G-FINAL-REPORT.md` — آخرین فاز تمامشده (آنبوردینگ فروشندهٔ واقعی)
- `../.freebuff/run.md` — runbook محیط

## گیت

repo از ۲۰۲۶-۰۹-۲۲ فعال شد. کامیت پایه: `cb65543`.
`node_modules`, `.next`, `.pgdata`, `.env` و `tmp-loop-logs/` در `.gitignore` هستند —
دوباره اضافهشان نکن.

## گراف کد (Graphify) — اول گراف بپرس، بعد فایل بخوان

`graphify-out/graph.json` موجود است (۱۳۷۴ گره، ۳۰۳۰ یال، بدون LLM — کاملاً محلی).
**قبل از هر جستجوی کد یا خواندن فایل، گراف را کوئری بگیر:**

```bash
export PATH="/c/Users/ali/.local/bin:$PATH"   # graphify اینجاست
graphify explain "createCheckout"             # یک نماد و اتصالاتش
graphify path "createCheckout" "PaymentService"  # کوتاهترین مسیر
graphify query "which tests cover checkout?"  # BFS پرسشی
graphify update .                             # بعد از تغییر کد (بدون هزینهٔ API)
```

- یالها برچسب `EXTRACTED`/`INFERRED` دارند — به INFERRED مثل حدس نگاه کن (§67).
- اگر `graphify update` بعد از refactor گره کم آورد: `graphify update . --force`.
- `graphify-out/` در `.gitignore` است؛ کامیت نشود.
- گراف از کامیت `cb65543` ساخته شده — بعد از کامیت جدید، update بزن.
