import Link from "next/link";
import { searchParts2, type SearchSort } from "@/lib/search";
import { getActiveVehicleContext, vehicleContextLabel } from "@/lib/vehicle";
import { getSessionId } from "@/lib/session";
import { formatToman, toPersianDigits } from "@/lib/persian";
import { fitmentPresentation, fitmentPresentationReason, FITMENT_BADGE, FITMENT_FA } from "@/lib/fitment";
import { getCategoryTree } from "@/lib/catalog";
import { SearchBox } from "@/components/search-box";
import { CompatToggle } from "@/components/compat-toggle";

export const metadata = { title: "جستجوی قطعه" };

const SORTS: { key: SearchSort; label: string }[] = [
  { key: "RELEVANCE", label: "مرتبط‌ترین" },
  { key: "PRICE_ASC", label: "ارزان‌ترین" },
  { key: "PRICE_DESC", label: "گران‌ترین" },
  { key: "NEWEST", label: "جدیدترین" },
];

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; vehicle?: string; compat?: string; cat?: string; sort?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";
  const compatOnly = sp.compat === "1";
  const sort = (SORTS.find((s) => s.key === sp.sort)?.key ?? "RELEVANCE") as SearchSort;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);

  const sid = await getSessionId();
  const activeCtx = await getActiveVehicleContext(sid);
  // An explicit ?vehicle=vehicleId override (deep-linkable); falls back to the
  // active garage vehicle. The variantId is NOT inferable from a vehicle id, so
  // a vehicle-level context is intentionally variant-less (rules still resolve).
  const overrideCtx = sp.vehicle ? await getVehicleLevelContext(sp.vehicle) : null;
  const ctx = overrideCtx ?? activeCtx;

  const result = q || ctx
    ? await searchParts2({
        query: q,
        vehicleContext: ctx,
        categoryId: sp.cat || undefined,
        compatibleOnly: compatOnly,
        sort,
        page,
      })
    : null;

  const categories = await getCategoryTree();

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">جستجوی قطعه</h1>

      <SearchBox initialVehicleHint={ctx ? vehicleContextLabel(ctx) : null} />
      {ctx && (
        <noscript>
          <form action="/search" className="flex flex-wrap gap-2">
            <input name="q" defaultValue={q} className="input flex-1 min-w-56" />
            <input type="hidden" name="vehicle" value={ctx.vehicleId} />
            <button className="btn-primary">جستجو</button>
          </form>
        </noscript>
      )}

      {/* Active vehicle context */}
      <div className="card flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="text-sm">
          {ctx ? (
            <>
              <span className="text-black/50">خودروی من: </span>
              <b>{vehicleContextLabel(ctx)}</b>
              {ctx.engineLabel && <span className="text-black/50"> · موتور {ctx.engineLabel}</span>}
              <span className="ms-2 badge bg-black/5 text-black/60">زمینه فعال</span>
            </>
          ) : (
            <span className="text-black/55">برای بررسی دقیق سازگاری، خودروی خود را انتخاب کنید.</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {ctx && <CompatToggle defaultChecked={compatOnly} label="فقط قطعات سازگار با خودروی من" />}
          <Link href="/account/garage" className="btn-ghost px-3 py-1.5 text-xs">تغییر خودرو</Link>
        </div>
      </div>
      {ctx && (
        <form id="compat-form" action="/search" className="hidden">
          {q && <input type="hidden" name="q" value={q} />}
          {sp.cat && <input type="hidden" name="cat" value={sp.cat} />}
          {sort !== "RELEVANCE" && <input type="hidden" name="sort" value={sort} />}
        </form>
      )}

      {/* Filters + sort */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-black/45">دسته:</span>
        <Link href={buildUrl({ q, compat: compatOnly, sort, vehicle: ctx?.vehicleId })} className={`badge ${!sp.cat ? "bg-black/8" : "bg-black/5 text-black/50"}`}>
          همه
        </Link>
        {categories.slice(0, 6).map((c) => (
          <Link key={c.id} href={buildUrl({ q, cat: c.slug, compat: compatOnly, sort, vehicle: ctx?.vehicleId })} className={`badge ${sp.cat === c.slug ? "bg-[var(--color-accent)] text-white" : "bg-black/5 text-black/60"}`}>
            {c.titleFa}
          </Link>
        ))}
        <span className="ms-2 text-black/45">ترتیب:</span>
        {SORTS.map((s) => (
          <Link key={s.key} href={buildUrl({ q, cat: sp.cat, compat: compatOnly, sort: s.key, vehicle: ctx?.vehicleId })} className={`badge ${sort === s.key ? "bg-black/8" : "bg-black/5 text-black/50"}`}>
            {s.label}
          </Link>
        ))}
      </div>

      {result && (
        <p className="text-xs text-black/45">
          {toPersianDigits(result.total)} نتیجه{q && <> برای «{q}»</>}
          {ctx && <> · زمینه: {vehicleContextLabel(ctx)}</>}
        </p>
      )}

      {/* Results */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {result?.hits.map((h) => (
          <Link key={h.part.id} href={`/parts/${h.part.slug}`} className="card flex flex-col p-4 transition-shadow hover:shadow-md">
            <div className="flex items-start justify-between gap-2">
              <div className="font-semibold">{h.part.title}</div>
              {h.fitment && (() => {
                // P2-F.1 (§3): same presentation policy as the PDP — a COMPATIBLE
                // verdict on an unverified catalog row is shown as needs-review.
                const presented = fitmentPresentation(h.fitment.status, h.part.dataStatus) ?? h.fitment.status;
                // P2-G audit (HIGH): tooltip must not assert «… سازگار است.» when
                // the badge was softened to needs-review for unverified data.
                const presentedReason = fitmentPresentationReason(h.fitment.status, h.part.dataStatus, h.fitment.reasonFa);
                return (
                  <span className={`badge shrink-0 ${FITMENT_BADGE[presented]}`} title={presentedReason}>
                    {FITMENT_FA[presented]}
                  </span>
                );
              })()}
            </div>
            <div className="mt-1 text-[11px] text-black/45">
              {h.part.dataStatus === "DEMO" && <span className="badge me-1 bg-amber-50 text-amber-700">اطلاعات نمایشی</span>}
              {h.part.brandName && <>{h.part.brandName} · </>}
              {h.part.categoryTitle ?? "—"} · {h.part.sku}
            </div>
            <div className="mt-auto flex items-center justify-between pt-3 text-xs">
              <span className="text-black/60">
                {h.minPriceToman != null ? `از ${formatToman(h.minPriceToman * 10)}` : "بدون پیشنهاد"}
              </span>
              <span className="text-black/40">{toPersianDigits(h.offerCount)} فروشنده</span>
            </div>
            {h.fitment && (
              <p className="mt-2 line-clamp-2 text-[11px] text-black/45">
                {fitmentPresentationReason(h.fitment.status, h.part.dataStatus, h.fitment.reasonFa)}
              </p>
            )}
          </Link>
        ))}
      </div>

      {/* Zero-result states — NO_RESULTS vs NO_COMPATIBLE_RESULTS distinguished */}
      {result?.NO_RESULTS && (
        <div className="card p-6 text-sm">
          <p className="font-semibold">نتیجه‌ای پیدا نشد.</p>
          <ul className="mt-2 list-disc space-y-1 ps-5 text-black/55">
            {compatOnly && <li><Link className="text-[var(--color-accent)] underline" href={buildUrl({ q, cat: sp.cat, sort, vehicle: ctx?.vehicleId, compat: false })}>فیلتر سازگاری را بردارید</Link></li>}
            {ctx && <li><Link className="text-[var(--color-accent)] underline" href="/account/garage">خودرو را تغییر دهید</Link></li>}
            <li>جستجوی ساده‌تر انجام دهید (نرمال‌سازی فارسی فعال است).</li>
          </ul>
        </div>
      )}
      {result && !result.NO_RESULTS && result.hits.length === 0 && (
        <div className="card p-6 text-sm text-black/55">صفحهٔ درخواستی خالی است — به صفحهٔ قبل برگردید.</div>
      )}
      {result?.NO_COMPATIBLE_RESULTS && (
        <div className="card border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
          هیچ قطعه‌ای با وضعیت «سازگار» برای این خودرو یافت نشد؛ نتایج دیگری ممکن است نیازمند بررسی باشند.
        </div>
      )}
    </div>
  );
}

/** vehicleId-only context: variant-less by design (deep link cannot prove a variant). */
async function getVehicleLevelContext(vehicleId: string) {
  const { prisma } = await import("@/lib/prisma");
  const v = await prisma.vehicle.findFirst({ where: { id: vehicleId, active: true }, select: { id: true, displayName: true } });
  if (!v) return null;
  return {
    vehicleId: v.id,
    variantId: null,
    engineId: null,
    transmissionId: null,
    engine: null,
    transmission: null,
    bodyType: null,
    year: null,
    vehicleLabel: v.displayName,
    variantLabel: null,
    engineLabel: null,
    transmissionLabel: null,
  };
}

function buildUrl(params: {
  q: string; cat?: string | false; compat?: boolean | false; sort?: SearchSort; vehicle?: string | null; page?: number;
}): string {
  const usp = new URLSearchParams();
  if (params.q) usp.set("q", params.q);
  if (typeof params.cat === "string" && params.cat) usp.set("cat", params.cat);
  if (params.compat === true) usp.set("compat", "1");
  if (params.sort && params.sort !== "RELEVANCE") usp.set("sort", params.sort);
  if (params.vehicle) usp.set("vehicle", params.vehicle);
  if (params.page && params.page > 1) usp.set("page", String(params.page));
  const s = usp.toString();
  return s ? `/search?${s}` : "/search";
}
