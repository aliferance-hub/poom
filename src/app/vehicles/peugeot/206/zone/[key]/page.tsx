import Link from "next/link";
import { notFound } from "next/navigation";
import { getVehicleWithVariants, getZoneByKey } from "@/lib/catalog";
import { toPersianDigits } from "@/lib/persian";

export default async function ZonePage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const vehicle = await getVehicleWithVariants("Peugeot", "206");
  if (!vehicle) notFound();
  const zone = await getZoneByKey(vehicle.id, key);
  if (!zone) notFound();

  return (
    <div className="space-y-4">
      <nav className="text-xs text-black/50" aria-label="breadcrumb">
        <Link href="/" className="hover:underline">خانه</Link> /{" "}
        <Link href="/vehicles/peugeot/206/type-5" className="hover:underline">پژو ۲۰۶</Link> / {zone.title}
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">{zone.title}</h1>
          <p className="text-sm text-black/50">{zone.description}</p>
        </div>
        <Link href={`/vehicles/peugeot/206/type-5?zone=${zone.key}`} className="btn-ghost">
          نمایش در مدل سه‌بعدی
        </Link>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {zone.assemblies.map((a) => (
          <Link key={a.id} href={`/assemblies/${a.slug}`} className="card flex items-center justify-between p-4 hover:shadow-md">
            <div>
              <div className="font-semibold">{a.title}</div>
              <div className="mt-1 text-xs text-black/45">اسمبلی · {toPersianDigits(a._count.parts)} قطعه</div>
            </div>
            <span className="text-black/30">‹</span>
          </Link>
        ))}
        {zone.assemblies.length === 0 && (
          <div className="card p-6 text-sm text-black/50">برای این ناحیه هنوز اسمبلی ثبت نشده است (DEMO).</div>
        )}
      </div>
    </div>
  );
}
