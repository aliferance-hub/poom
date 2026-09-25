import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/identity";
import { getGovernanceList } from "@/lib/governance";
import { transitionSellerStatusAction, setSellerVerificationAction } from "@/app/admin/admin-p2e-actions";
import { toPersianDigits, formatToman } from "@/lib/persian";

export const dynamic = "force-dynamic";

const STATUS_FA: Record<string, string> = {
  PENDING: "در انتظار بررسی",
  ACTIVE: "فعال",
  SUSPENDED: "تعلیق",
  REJECTED: "رد شده",
};

// P2-G.1: neutral verification wording — "تأیید شده در سیستم" = verified in THIS
// system per the implemented workflow; never a legal/business-registry claim.
const VERIFICATION_FA: Record<string, string> = {
  UNVERIFIED: "تأیید نشده",
  PENDING_REVIEW: "در انتظار بررسی",
  VERIFIED: "تأیید شده در سیستم",
  REJECTED: "رد شده",
};

const ORIGIN_FA: Record<string, string> = {
  DEMO: "نمایشی",
  REAL_ONBOARDING: "ثبت‌نام واقعی",
  SYSTEM: "سیستمی",
};

// Verification actions offered per current verification state.
const VERIFICATION_ACTIONS: Record<string, [string, string, string][]> = {
  UNVERIFIED: [["PENDING_REVIEW", "صف", ""], ["VERIFIED", "تأیید در سیستم", ""]],
  PENDING_REVIEW: [["VERIFIED", "تأیید در سیستم", ""], ["REJECTED", "رد تأیید", ""], ["UNVERIFIED", "بازگشت", ""]],
  VERIFIED: [["UNVERIFIED", "لغو تأیید", ""]],
  REJECTED: [["PENDING_REVIEW", "بررسی مجدد", ""]],
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
                {/* P2-G.1: origin from the authoritative axis (legacy isRealSeller
                    kept in sync but no longer rendered). */}
                <span className={`badge ml-1 ${s.sellerOrigin === "REAL_ONBOARDING" ? "bg-blue-50 text-blue-700" : s.sellerOrigin === "SYSTEM" ? "bg-black/5 text-black/30" : "bg-black/5 text-black/50"}`}>
                  {ORIGIN_FA[s.sellerOrigin]}
                </span>
                {/* Verification is shown independently of origin and status. */}
                <span className={`badge ml-1 ${s.sellerVerificationStatus === "VERIFIED" ? "bg-green-100 text-green-900" : s.sellerVerificationStatus === "REJECTED" ? "bg-red-100 text-red-900" : "bg-amber-50 text-amber-900"}`}>
                  {VERIFICATION_FA[s.sellerVerificationStatus]}
                </span>
              </div>
              <div className="text-[10px] text-black/40">{s.city ?? "—"} · {s.phone ?? "—"} · امتیاز {toPersianDigits(s.rating.toFixed(1))}</div>
              <div className="text-[10px] text-black/40">{toPersianDigits(s._count.offers)} آفر · {toPersianDigits(s._count.orders)} سفارش · <Link className="underline" href={`/seller-demo?seller=${s.id}`}>مشاهده</Link></div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
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
            {/* P2-G.1: verification actions — separate from governance actions;
                every button is a form POST to the audited server action. */}
            <div className="flex flex-wrap items-center gap-1 pl-2">
              {(VERIFICATION_ACTIONS[s.sellerVerificationStatus] ?? []).map(([to, label]) => (
                <form key={to} action={setSellerVerificationAction}>
                  <input type="hidden" name="sellerId" value={s.id} />
                  <input type="hidden" name="to" value={to} />
                  <button className="btn-ghost !px-2 !py-1 !text-xs" type="submit">{label}</button>
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
