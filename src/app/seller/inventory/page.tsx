import { redirect } from "next/navigation";
import { SellerNav } from "@/components/seller/seller-nav";
import { getAuthenticatedSeller } from "@/lib/seller/seller-auth";
import { getSellerOffers } from "@/lib/seller/seller-offers";
import { getInventorySummary, BUCKET_FA, bucketOf, freshnessLabel } from "@/lib/seller/seller-inventory";
import { toPersianDigits, formatToman } from "@/lib/persian";
import { CsvImportPanel } from "@/components/seller/csv-import-panel";

export const dynamic = "force-dynamic";

export default async function SellerInventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; error?: string }>;
}) {
  const identity = await getAuthenticatedSeller();
  if (!identity) redirect("/login?next=/seller/inventory");
  const sp = await searchParams;

  const [summary, offers] = await Promise.all([
    getInventorySummary(identity.seller.id),
    getSellerOffers(identity.seller.id, {
      status: (sp.status || undefined) as never,
      sort: "stock_asc",
      pageSize: 50,
    }),
  ]);

  return (
    <div className="space-y-4">
      <SellerNav />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">موجودی</h1>
        <span className="badge bg-amber-100 text-amber-900">داده نمایشی</span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {([
          ["کل آفرها", summary.totalOffers],
          ["موجود", summary.inStock],
          ["کم‌موجود", summary.lowStock],
          ["ناموجود", summary.outOfStock],
          ["بروزرسانی کهنه", summary.stale],
        ] as [string, number][]).map(([label, v]) => (
          <div key={label} className="card p-3 text-center">
            <div className="text-lg font-bold">{toPersianDigits(v)}</div>
            <div className="text-[11px] text-black/50">{label}</div>
          </div>
        ))}
      </div>

      <CsvImportPanel />

      <div className="card p-3">
        <h2 className="mb-1 text-sm font-semibold">نمایش فایل خروجی</h2>
        <p className="mb-2 text-xs text-black/50">
          خروجی CSV فقط شامل ردیف‌های فروشگاه خودتان است؛ فیلدهایی که با = + - @ شروع شوند برای جلوگیری از تزریق فرمول اکسل escape می‌شوند.
        </p>
        <a className="btn-ghost inline-block text-sm" href="/api/seller/inventory/export">دانلود CSV موجودی</a>
      </div>

      <div className="card divide-y divide-black/6">
        {offers.rows.length === 0 && <div className="p-6 text-center text-sm text-black/50">هنوز آفری ندارید.</div>}
        {offers.rows.map((o) => (
          <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
            <div className="min-w-44 flex-1">
              <div className="font-medium">{o.partTitle}</div>
              <div className="text-[10px] text-black/40" dir="ltr">{o.sellerSku ?? o.partSku}</div>
              <div className="text-[10px] text-black/40">{freshnessLabel(o.stockUpdatedAt)}</div>
            </div>
            <div className="flex items-center gap-2">
              <span className={`badge ${o.stock === 0 ? "bg-red-100 text-red-900" : o.stock <= o.lowStockThreshold ? "bg-amber-100 text-amber-900" : "bg-green-100 text-green-900"}`}>
                {BUCKET_FA[bucketOf(o.stock, o.lowStockThreshold)]} · {toPersianDigits(o.stock)}
              </span>
              <b>{formatToman(o.price)}</b>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
