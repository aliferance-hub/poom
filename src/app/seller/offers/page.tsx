import Link from "next/link";
import { redirect } from "next/navigation";
import { SellerNav } from "@/components/seller/seller-nav";
import { getAuthenticatedSeller } from "@/lib/seller/seller-auth";
import { getSellerOffers, type SellerOfferFilters } from "@/lib/seller/seller-offers";
import { formatToman, toPersianDigits } from "@/lib/persian";
import { BUCKET_FA, bucketOf, freshnessLabel } from "@/lib/seller/seller-inventory";
import { OfferRowEditor } from "@/components/seller/offer-row-editor";
import { NewOfferForm } from "@/components/seller/new-offer-form";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const STATUS_TABS: [string, string][] = [
  ["", "همه"],
  ["active", "فعال"],
  ["inactive", "غیرفعال"],
  ["in_stock", "موجود"],
  ["low_stock", "کم‌موجود"],
  ["out_of_stock", "ناموجود"],
];

const SORT_OPTIONS: [string, string][] = [
  ["updated_desc", "آخرین بروزرسانی"],
  ["price_asc", "ارزان‌ترین"],
  ["price_desc", "گران‌ترین"],
  ["stock_asc", "کم‌ترین موجودی"],
  ["title_asc", "نام قطعه"],
];

export default async function SellerOffersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; sort?: string; q?: string; page?: string; saved?: string; error?: string }>;
}) {
  const identity = await getAuthenticatedSeller();
  if (!identity) redirect("/login?next=/seller/offers");
  const sp = await searchParams;

  const filters: SellerOfferFilters = {
    status: (sp.status || undefined) as SellerOfferFilters["status"],
    sort: (sp.sort || undefined) as SellerOfferFilters["sort"],
    q: sp.q,
    page: Number(sp.page ?? 1) || 1,
    pageSize: 20,
  };
  const { rows, total } = await getSellerOffers(identity.seller.id, filters);
  const pages = Math.max(1, Math.ceil(total / 20));

  // P2-G: real sellers publish offers on REAL catalog rows only. The form is
  // offered to ACTIVE sellers; eligibility is re-validated server-side on submit.
  const sellableParts = identity.seller.sellerStatus === "ACTIVE"
    ? await prisma.part.findMany({
        // P2-G audit fix (M-2): match the server-side eligibility of
        // createSellerOffer exactly — active + real (sourceRef) + not deprecated.
        where: { active: true, sourceRef: { not: null }, dataStatus: { not: "DEPRECATED" } },
        select: { slug: true, title: true, sku: true },
        orderBy: { title: "asc" },
        take: 200,
      })
    : [];

  const qs = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { status: sp.status, sort: sp.sort, q: sp.q, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/seller/offers${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-4">
      <SellerNav />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">آفرهای من ({toPersianDigits(total)})</h1>
        <div className="flex items-center gap-2">
          {identity.seller.sellerStatus === "ACTIVE" && sellableParts.length > 0 && (
            <NewOfferForm sellableParts={sellableParts} />
          )}
          <Link href="/seller/inventory" className="btn-ghost text-sm">درون‌ریزی CSV از صفحه‌ی موجودی</Link>
        </div>
      </div>

      {sp.saved && <div className="card border border-green-300 bg-green-50 p-2 text-sm text-green-900" role="status">تغییرات ذخیره شد.</div>}
      {sp.error && <div className="card border border-red-300 bg-red-50 p-2 text-sm text-red-900" role="alert">ذخیره نشد: {sp.error}</div>}

      <form method="get" action="/seller/offers" className="card flex flex-wrap items-end gap-2 p-3 text-sm">
        <label className="text-xs text-black/50">
          جستجو
          <input name="q" defaultValue={sp.q ?? ""} className="input !w-44 !py-1" placeholder="نام قطعه یا کد" />
        </label>
        <label className="text-xs text-black/50">
          ترتیب
          <select name="sort" defaultValue={sp.sort ?? "updated_desc"} className="input !w-36 !py-1">
            {SORT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <input type="hidden" name="status" value={sp.status ?? ""} />
        <button className="btn-ghost !py-1" type="submit">اعمال</button>
      </form>

      <div className="flex flex-wrap gap-1">
        {STATUS_TABS.map(([v, label]) => (
          <Link key={v || "all"} href={qs({ status: v || undefined, page: undefined })}
            className={`badge ${((sp.status ?? "") === v) ? "bg-[var(--color-accent)] text-white" : "bg-black/6"}`}>
            {label}
          </Link>
        ))}
      </div>

      {rows.length === 0 && (
        <div className="card p-6 text-center text-sm text-black/50">هنوز آفری با این فیلتر ندارید.</div>
      )}

      <div className="card divide-y divide-black/6">
        {rows.map((o) => (
          <OfferRowEditor
            key={o.id}
            offer={{
              id: o.id,
              partTitle: o.partTitle,
              partSku: o.partSku,
              sellerSku: o.sellerSku,
              price: o.price,
              stock: o.stock,
              lowStockThreshold: o.lowStockThreshold,
              shippingDaysMin: o.shippingDaysMin,
              shippingDaysMax: o.shippingDaysMax,
              warrantyFa: o.warrantyFa,
              active: o.active,
            }}
            bucket={BUCKET_FA[bucketOf(o.stock, o.lowStockThreshold)]}
            freshness={freshnessLabel(o.stockUpdatedAt)}
          />
        ))}
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-center gap-2 text-sm">
          {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
            <Link key={p} href={qs({ page: String(p) })}
              className={`badge ${p === filters.page ? "bg-[var(--color-accent)] text-white" : "bg-black/6"}`}>
              {toPersianDigits(p)}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
