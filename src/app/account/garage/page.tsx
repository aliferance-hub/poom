import { prisma } from "@/lib/prisma";
import { getSessionId } from "@/lib/session";
import { toPersianDigits } from "@/lib/persian";
import {
  getMyVehicles,
  getActiveVehicleContext,
  vehicleContextLabel,
} from "@/lib/vehicle";

export const metadata = { title: "خودروهای من" };

export default async function GaragePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const sp = await searchParams;
  const errorFa: Record<string, string> = {
    NOT_OWNER: "این خودرو در گاراژ شما نیست.",
    NOT_FOUND: "این خودرو دیگر وجود ندارد.",
    CONFLICT: "تغییر وضعیت خودرو در لحظه‌ای ممکن نشد — دوباره تلاش کنید.",
    INVALID: "اطلاعات ارسالی معتبر نیست.",
  };
  const sid = await getSessionId();
  const saved = await getMyVehicles(sid);
  const variants = await prisma.vehicleVariant.findMany({
    where: { vehicle: { active: true } },
    select: {
      id: true,
      trim: true,
      engineRef: { select: { name: true } },
      transmissionRef: { select: { name: true } },
      vehicle: { select: { displayName: true } },
    },
    orderBy: { trim: "asc" },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">خودروهای من</h1>

      {sp.error && errorFa[sp.error] && (
        <div role="alert" className="card p-3 text-sm text-red-700 bg-red-50">
          {errorFa[sp.error]}
        </div>
      )}

      {saved.length === 0 ? (
        <div className="card p-8 text-center text-sm text-black/55">
          هنوز خودرویی ثبت نکرده‌اید. خودروی خود را انتخاب کنید تا سازگاری قطعات دقیق نمایش داده شود.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {saved.map((g) => (
            <div key={g.id} className={`card p-4 ${g.isActive ? "ring-2 ring-[var(--color-accent)]" : ""}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold">
                  {g.nickname ?? `${g.vehicleLabel} ${g.variantLabel}`}
                </div>
                {g.isActive && <span className="badge bg-green-100 text-green-800">خودروی فعال</span>}
              </div>
              <div className="mt-1 text-xs text-black/55">
                {g.vehicleLabel} {g.variantLabel}
                {g.year != null && <> · سال {toPersianDigits(g.year)}</>}
                {g.engineLabel && <> · موتور {g.engineLabel}</>}
                {g.transmissionLabel && <> · گیربکس {g.transmissionLabel}</>}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {!g.isActive && (
                  <form action="/api/garage/activate" method="post">
                    <input type="hidden" name="garageId" value={g.id} />
                    <button className="btn-primary px-3 py-1.5 text-xs">انتخاب به‌عنوان خودروی فعال</button>
                  </form>
                )}
                <form action="/api/garage/delete" method="post">
                  <input type="hidden" name="garageId" value={g.id} />
                  <button className="btn-ghost px-3 py-1.5 text-xs !text-red-700">حذف</button>
                </form>
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="card p-4">
        <h2 className="mb-3 font-bold">افزودن خودرو</h2>
        <form action="/api/garage/add" method="post" className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-black/60">
            خودرو
            <select name="variantId" className="input mt-1 block w-56" required>
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.vehicle.displayName} {v.trim}
                  {v.engineRef ? ` — ${v.engineRef.name}` : ""}
                  {v.transmissionRef ? ` / ${v.transmissionRef.name}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-black/60">
            سال ساخت (میلادی، اختیاری)
            <input name="year" type="number" min={1300} max={2100} className="input mt-1 block w-40" placeholder="مثلاً 1390" />
          </label>
          <label className="text-xs text-black/60">
            نام مستعار (اختیاری)
            <input name="nickname" className="input mt-1 block w-40" placeholder="مثلاً ماشین پدر" />
          </label>
          <button className="btn-primary">افزودن</button>
        </form>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-bold text-black/70">زمینه فعال فعلی</h2>
        <ActiveContextLine sessionId={sid} />
      </section>
    </div>
  );
}

async function ActiveContextLine({ sessionId }: { sessionId: string }) {
  const ctx = await getActiveVehicleContext(sessionId);
  if (!ctx) {
    return <p className="text-sm text-black/50">خودروی فعالی انتخاب نشده است.</p>;
  }
  return <p className="text-sm">{vehicleContextLabel(ctx)} — زمینه سازگاری روی همین خودرو اعمال می‌شود.</p>;
}
