import Link from "next/link";
import { redirect } from "next/navigation";
import { SellerNav } from "@/components/seller/seller-nav";
import { getAuthenticatedSeller } from "@/lib/seller/seller-auth";
import { getSellerDashboard } from "@/lib/seller/seller-service";
import { computeDemoScore } from "@/lib/seller/seller-metrics";
import { formatToman, toPersianDigits } from "@/lib/persian";
import { BUCKET_FA } from "@/lib/seller/seller-inventory";

export const dynamic = "force-dynamic";

export default async function SellerDashboardPage() {
  const identity = await getAuthenticatedSeller();
  if (!identity) redirect("/login?next=/seller");
  const d = await getSellerDashboard({ sellerId: identity.seller.id });
  const score = computeDemoScore(d.metrics);

  return (
    <div className="space-y-4">
      <SellerNav />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">داشبورد فروشنده</h1>
        <span className="badge bg-amber-100 text-amber-900">داده نمایشی</span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["فروش امروز", formatToman(d.todaySalesIrr)],
          ["سفارش‌های جدید", toPersianDigits(d.newOrders)],
          ["آفرهای فعال", toPersianDigits(d.inventory.active)],
          ["لغو سفارش", toPersianDigits(d.metrics.cancelledOrders)],
        ].map(([label, value]) => (
          <div key={label} className="card p-3 text-center">
            <div className="text-lg font-bold">{value}</div>
            <div className="text-[11px] text-black/50">{label}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="card p-4">
          <h2 className="mb-2 text-sm font-semibold">وضعیت موجودی</h2>
          <ul className="space-y-1 text-sm">
            <li>کالاهای کم‌موجود: <b>{toPersianDigits(d.inventory.lowStock)}</b> ({BUCKET_FA.low_stock})</li>
            <li>کالاهای ناموجود: <b>{toPersianDigits(d.inventory.outOfStock)}</b></li>
            <li>موجودی کهنه (بیش از ۴۸ ساعت): <b>{toPersianDigits(d.inventory.stale)}</b></li>
          </ul>
          <Link href="/seller/inventory" className="btn-ghost mt-3 block text-center text-sm">مدیریت موجودی</Link>
        </div>
        <div className="card p-4">
          <h2 className="mb-2 text-sm font-semibold">امتیاز فروشنده (نمایشی)</h2>
          <div className="text-3xl font-bold">{toPersianDigits(score.score)}</div>
          <p className="mt-1 text-[11px] leading-5 text-black/50">
            فرمول قطعی: ۴۰٪ تکمیل سفارش + ۳۰٪ کم‌بودن لغو + ۳۰٪ امتیاز مدیریت. بدون هیچ ادعای هوشمند.
          </p>
        </div>
        <div className="card p-4">
          <h2 className="mb-2 text-sm font-semibold">سفارش‌های اخیر</h2>
          {d.recentOrders.length === 0 && <p className="text-sm text-black/50">هنوز سفارشی برای فروشگاه شما ثبت نشده است.</p>}
          <ul className="space-y-1 text-sm" dir="ltr">
            {d.recentOrders.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-2">
                <Link href={`/seller/orders/${o.id}`} className="underline">{o.orderNumber}</Link>
                <span>{formatToman(o.subtotal)}</span>
              </li>
            ))}
          </ul>
          <Link href="/seller/orders" className="btn-ghost mt-3 block text-center text-sm">همه‌ی سفارش‌ها</Link>
        </div>
      </div>
    </div>
  );
}
