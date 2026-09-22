import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/identity";
import { getGovernanceList } from "@/lib/governance";
import { transitionSellerStatusAction } from "@/app/admin/admin-p2e-actions";
import { toPersianDigits, formatToman } from "@/lib/persian";

export const dynamic = "force-dynamic";

const STATUS_FA: Record<string, string> = {
  PENDING: "در انتظار بررسی",
  ACTIVE: "فعال",
  SUSPENDED: "تعلیق",
  REJECTED: "رد شده",
};

const NEXT_ACTIONS: Record<string, [string, string][]> = {
  PENDING: [["ACTIVE", "تأیید"], ["REJECTED", "رد"]],
  ACTIVE: [["SUSPENDED", "تعلیق"]],
  SUSPENDED: [["ACTIVE", "فعال‌سازی مجدد"], ["REJECTED", "رد"]],
  REJECTED: [],
};

export default async function AdminSellersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; error?: string }>;
}) {
  const admin = await requireAdmin();
  if (!admin) redirect("/login?next=/admin/sellers");
  const sp = await searchParams;
  const sellers = await getGovernanceList({
    status: (sp.status || undefined) as never,
    q: sp.q,
  });

  const statusCount = await prisma.seller.groupBy({ by: ["sellerStatus"], _count: { _all: true } });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">مدیریت فروشندگان</h1>
        <Link href="/admin" className="btn-ghost text-sm">بازگشت به پنل ادمین</Link>
      </div>

      {sp.error && <div className="card border border-red-300 bg-red-50 p-2 text-sm text-red-900" role="alert">تغییر وضعیت انجام نشد: {sp.error}</div>}

      <div className="flex flex-wrap gap-1">
        {statusCount.map((s) => (
          <Link key={s.sellerStatus} href={`/admin/sellers?status=${s.sellerStatus}`}
            className={`badge ${sp.status === s.sellerStatus ? "bg-[var(--color-accent)] text-white" : "bg-black/6"}`}>
            {STATUS_FA[s.sellerStatus]} ({toPersianDigits(s._count._all)})
          </Link>
        ))}
        <Link href="/admin/sellers" className={`badge ${!sp.status ? "bg-[var(--color-accent)] text-white" : "bg-black/6"}`}>همه</Link>
      </div>

      <form method="get" action="/admin/sellers" className="card flex items-end gap-2 p-3">
        <input type="hidden" name="status" value={sp.status ?? ""} />
        <label className="text-xs text-black/50">
          جستجو
          <input name="q" defaultValue={sp.q ?? ""} className="input !w-48 !py-1" placeholder="نام فروشگاه" />
        </label>
        <button className="btn-ghost !py-1" type="submit">اعمال</button>
      </form>

      <div className="card divide-y divide-black/6">
        {sellers.length === 0 && <div className="p-6 text-center text-sm text-black/50">فروشنده‌ای با این فیلتر یافت نشد.</div>}
        {sellers.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
            <div className="min-w-48 flex-1">
              <div className="font-medium">
                {s.businessName}
                {/* P2-G audit fix (M-3): origin is a governance-relevant fact for admins. */}
                <span className={`badge ml-1 ${s.isRealSeller ? "bg-blue-50 text-blue-700" : "bg-black/5 text-black/50"}`}>
                  {s.isRealSeller ? "ثبت‌نام واقعی" : "نمایشی"}
                </span>
              </div>
              <div className="text-[10px] text-black/40">{s.city ?? "—"} · {s.phone ?? "—"} · امتیاز {toPersianDigits(s.rating.toFixed(1))}</div>
              <div className="text-[10px] text-black/40">{toPersianDigits(s._count.offers)} آفر · {toPersianDigits(s._count.orders)} سفارش · <Link className="underline" href={`/seller-demo?seller=${s.id}`}>مشاهده</Link></div>
            </div>
            <div className="flex items-center gap-2">
              <span className={`badge ${s.sellerStatus === "ACTIVE" ? "bg-green-100 text-green-900" : s.sellerStatus === "SUSPENDED" || s.sellerStatus === "REJECTED" ? "bg-red-100 text-red-900" : "bg-amber-100 text-amber-900"}`}>
                {STATUS_FA[s.sellerStatus]}
              </span>
              {(NEXT_ACTIONS[s.sellerStatus] ?? []).map(([to, label]) => (
                <form key={to} action={transitionSellerStatusAction}>
                  <input type="hidden" name="sellerId" value={s.id} />
                  <input type="hidden" name="to" value={to} />
                  <button className={`btn-ghost !px-2 !py-1 !text-xs ${to === "REJECTED" || to === "SUSPENDED" ? "!text-red-700" : ""}`} type="submit">
                    {label}
                  </button>
                </form>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-black/40">مقادیر امتیاز/تأیید فقط توسط همین پنل (ادمین) قابل تغییر است؛ فروشنده به آن‌ها دسترسی ندارد. هر تغییر در گزارش رخدادها ثبت می‌شود.</p>
    </div>
  );
}
