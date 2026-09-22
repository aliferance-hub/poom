import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getSessionId, } from "@/lib/session";
import { getCurrentUser } from "@/lib/auth/identity";
import { getActiveVehicleContext } from "@/lib/vehicle";
import { toPersianDigits, formatToman } from "@/lib/persian";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const sid = await getSessionId();
  const user = await getCurrentUser();
  const [vehicle, recentOrders, orderCount] = await Promise.all([
    getActiveVehicleContext(sid).catch(() => null),
    prisma.order.findMany({
      where: { sessionId: sid },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { sellerOrders: { include: { seller: { select: { businessName: true } } } } },
    }),
    prisma.order.count({ where: { sessionId: sid } }),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-bold">حساب من</h1>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="card p-4">
          <h2 className="mb-1 text-sm font-semibold">خودروی فعال</h2>
          {vehicle ? (
            <p className="text-sm">
              {[vehicle.vehicleLabel, vehicle.variantLabel].filter(Boolean).join(" · ")}
            </p>
          ) : (
            <p className="text-sm text-black/50">هنوز خودرویی انتخاب نکرده‌اید.</p>
          )}
          <Link href="/account/garage" className="btn-ghost mt-3 block text-center text-sm">گاراژ من</Link>
        </div>
        <div className="card p-4">
          <h2 className="mb-1 text-sm font-semibold">سفارش‌ها</h2>
          <p className="text-2xl font-bold">{toPersianDigits(orderCount)}</p>
          <Link href="/account/orders" className="btn-ghost mt-3 block text-center text-sm">مشاهده سفارش‌ها</Link>
        </div>
        <div className="card p-4">
          <h2 className="mb-1 text-sm font-semibold">وضعیت حساب</h2>
          {user ? (
            <p className="text-sm">وارد شده‌اید · نقش: {user.role === "CUSTOMER" ? "مشتری" : user.role === "SELLER" ? "فروشنده" : "مدیر"}</p>
          ) : (
            <p className="text-sm text-black/50">کاربر مهمان (سبد و گاراژ روی همین دستگاه ذخیره می‌شود).</p>
          )}
          <Link href="/login?next=/account" className="btn-ghost mt-3 block text-center text-sm">{user ? "ورود با حساب دیگر" : "ورود"}</Link>
        </div>
      </div>

      <section className="space-y-2">
        <h2 className="font-semibold">سفارش‌های اخیر</h2>
        {recentOrders.length === 0 && <div className="card p-4 text-sm text-black/50">هنوز سفارشی ثبت نکرده‌اید.</div>}
        {recentOrders.map((o) => (
          <Link key={o.id} href={`/account/orders/${o.id}`} className="card flex flex-wrap items-center justify-between gap-2 p-3 text-sm hover:bg-black/3">
            <div>
              <span className="font-medium" dir="ltr">{o.orderNumber}</span>
              <span className="text-black/45"> · {o.sellerOrders.map((so) => so.seller.businessName).join("، ")}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="badge bg-black/6">{o.status === "PAID" ? "پرداخت شده" : o.status === "PENDING_PAYMENT" ? "در انتظار پرداخت" : o.status}</span>
              <b>{formatToman(o.total)}</b>
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}
