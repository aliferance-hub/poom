import Link from "next/link";
import { redirect } from "next/navigation";
import { SellerNav } from "@/components/seller/seller-nav";
import { getAuthenticatedSeller } from "@/lib/seller/seller-auth";
import { getSellerOrders } from "@/lib/seller/seller-orders";
import { formatToman, toPersianDigits } from "@/lib/persian";

export const dynamic = "force-dynamic";

const STATUS_FA: Record<string, string> = {
  PENDING: "در انتظار تأیید",
  CONFIRMED: "تأیید شده",
  PROCESSING: "در حال آماده‌سازی",
  READY_TO_SHIP: "آماده ارسال",
  SHIPPED: "ارسال شده",
  DELIVERED: "تحویل شده",
  CANCELLED: "لغو شده",
  RETURNED: "مرجوعی",
};

const TABS = ["", "PENDING", "CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED"];

export default async function SellerOrdersPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const identity = await getAuthenticatedSeller();
  if (!identity) redirect("/login?next=/seller/orders");
  const sp = await searchParams;

  const { rows, total } = await getSellerOrders(identity.seller.id, {
    status: sp.status || undefined,
    page: Number(sp.page ?? 1) || 1,
    pageSize: 20,
  });

  const qs = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { status: sp.status, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/seller/orders${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-4">
      <SellerNav />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">سفارش‌های فروشگاه ({toPersianDigits(total)})</h1>
        <span className="badge bg-amber-100 text-amber-900">داده نمایشی</span>
      </div>

      <div className="flex flex-wrap gap-1">
        {TABS.map((v) => (
          <Link key={v || "all"} href={qs({ status: v || undefined })}
            className={`badge ${(sp.status ?? "") === v ? "bg-[var(--color-accent)] text-white" : "bg-black/6"}`}>
            {v ? STATUS_FA[v] : "همه"}
          </Link>
        ))}
      </div>

      {rows.length === 0 && (
        <div className="card p-6 text-center text-sm text-black/50">هنوز سفارشی برای فروشگاه شما ثبت نشده است.</div>
      )}

      <div className="card divide-y divide-black/6">
        {rows.map((so) => (
          <Link key={so.id} href={`/seller/orders/${so.id}`} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm hover:bg-black/3">
            <div>
              <span className="font-medium" dir="ltr">{so.orderNumber}</span>
              <span className="text-black/45"> · {toPersianDigits(so.itemCount)} قلم</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`badge ${so.status === "CANCELLED" || so.status === "RETURNED" ? "bg-red-100 text-red-900" : so.status === "DELIVERED" ? "bg-green-100 text-green-900" : "bg-amber-100 text-amber-900"}`}>
                {STATUS_FA[so.status] ?? so.status}
              </span>
              <b>{formatToman(so.subtotal)}</b>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
