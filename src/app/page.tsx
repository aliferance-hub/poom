import Link from "next/link";
import { getVehicleWithVariants, getZonesForVehicle, searchParts } from "@/lib/catalog";
import { getSessionId } from "@/lib/session";
import { getActiveVehicleContext, vehicleContextLabel } from "@/lib/vehicle";
import { toPersianDigits, formatToman } from "@/lib/persian";

export default async function HomePage() {
  const vehicle = await getVehicleWithVariants("Peugeot", "206");
  const zones = vehicle ? await getZonesForVehicle(vehicle.id) : [];
  const popular = await searchParts("لنت رادیاتور لاستیک");
  const sid = await getSessionId();
  const activeVehicle = await getActiveVehicleContext(sid).catch(() => null);

  return (
    <div className="space-y-8">
      <section className="card overflow-hidden">
        <div className="flex flex-col items-start gap-6 bg-gradient-to-l from-[--color-graphite] to-[--color-graphite-2] p-8 text-white md:flex-row md:items-center">
          <div className="flex-1 space-y-3">
            <h1 className="text-2xl font-bold md:text-3xl">قطعه را روی ماشینت پیدا کن</h1>
            <p className="text-white/70">
              خودرو را انتخاب کن، ناحیه را روی مدل سه‌بعدی ببین، قطعه را پیدا کن و بهترین پیشنهاد فروشنده‌ها را مقایسه کن.
            </p>
            <div className="flex flex-wrap gap-2 pt-2">
              <Link href="/vehicles/peugeot/206" className="btn-primary">خودرویت را انتخاب کن</Link>
              <Link href="/search" className="btn-ghost !border-white/20 !bg-white/10 !text-white">جستجوی قطعه</Link>
            </div>
            {activeVehicle && (
              <p className="pt-1 text-xs text-white/70">
                خودروی فعال: <b className="text-white">{vehicleContextLabel(activeVehicle)}</b> —
                <Link href="/account/garage" className="underline"> تغییر</Link>
              </p>
            )}
          </div>
          <div className="grid w-full grid-cols-3 gap-2 text-center md:w-72" dir="rtl">
            {[["۸", "ناحیه خودرو"], ["۴۱", "قطعه نمایشی"], ["۳", "فروشنده نمایشی"]].map(([n, l]) => (
              <div key={l} className="rounded-lg bg-white/10 p-3">
                <div className="text-lg font-bold">{n}</div>
                <div className="text-[11px] text-white/60">{l}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-bold">نواحی ۲۰۶</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {zones.map((z) => (
            <Link key={z.id} href={`/vehicles/peugeot/206/zone/${z.key}`} className="card p-4 transition-shadow hover:shadow-md">
              <div className="font-semibold">{z.title}</div>
              <div className="mt-1 text-xs text-black/50">{z.description}</div>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-bold">قطعات پرجستجو</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {popular.slice(0, 4).map((p) => (
            <Link key={p.id} href={`/parts/${p.slug}`} className="card p-4 transition-shadow hover:shadow-md">
              <div className="font-semibold">{p.title}</div>
              <div className="mt-1 text-[11px] text-black/45">DEMO · {p.sku}</div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
