import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/identity";
import { toPersianDigits } from "@/lib/persian";

export const dynamic = "force-dynamic";

const EVENT_FA: Record<string, string> = {
  user_login: "ورود کاربر",
  user_login_failed: "ورود ناموفق",
  user_logout: "خروج",
  session_revoked: "ابطال نشست",
  seller_approved: "تأیید فروشنده",
  seller_suspended: "تعلیق فروشنده",
  seller_rejected: "رد فروشنده",
  seller_reactivated: "فعال‌سازی مجدد",
  seller_order_status_changed: "تغییر وضعیت سفارش فروشنده",
  order_created: "ثبت سفارش",
  payment_attempt_created: "ایجاد تلاش پرداخت",
  payment_verified: "تأیید پرداخت",
  payment_verification_failed: "شکست تأیید پرداخت",
  settlement_started: "شروع تسویه",
  settlement_completed: "تسویه کامل شد",
  settlement_failed: "شکست تسویه",
  return_created: "ثبت درخواست مرجوعی",
  return_state_changed: "تغییر وضعیت مرجوعی",
  refund_state_changed: "تغییر وضعیت بازگشت وجه",
  seller_offer_price_updated: "تغییر قیمت آفر",
  seller_offer_stock_updated: "تغییر موجودی",
  seller_offer_status_changed: "تغییر وضعیت آفر",
  seller_inventory_csv_imported: "درون‌ریزی CSV",
  seller_inventory_csv_rejected: "رد CSV",
  seller_profile_updated: "ویرایش پروفایل",
  customer_order_cancelled: "لغو سفارش توسط مشتری",
};

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string; entity?: string }>;
}) {
  const admin = await requireAdmin();
  if (!admin) redirect("/login?next=/admin/audit");
  const sp = await searchParams;

  const where = {
    ...(sp.event ? { event: sp.event } : {}),
    ...(sp.entity ? { entity: sp.entity } : {}),
  };
  const [logs, events, entities] = await Promise.all([
    prisma.sellerEventLog.findMany({ where, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.sellerEventLog.findMany({ distinct: ["event"], select: { event: true }, orderBy: { event: "asc" } }),
    prisma.sellerEventLog.findMany({ distinct: ["entity"], select: { entity: true }, orderBy: { entity: "asc" } }),
  ]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">گزارش رخدادها (Audit)</h1>
        <Link href="/admin" className="btn-ghost text-sm">بازگشت به پنل ادمین</Link>
      </div>

      <form method="get" action="/admin/audit" className="card flex flex-wrap items-end gap-2 p-3 text-sm">
        <label className="text-xs text-black/50">
          رخداد
          <select name="event" defaultValue={sp.event ?? ""} className="input !w-52 !py-1">
            <option value="">همه</option>
            {events.map((e) => <option key={e.event} value={e.event}>{EVENT_FA[e.event] ?? e.event}</option>)}
          </select>
        </label>
        <label className="text-xs text-black/50">
          موجودیت
          <select name="entity" defaultValue={sp.entity ?? ""} className="input !w-36 !py-1">
            <option value="">همه</option>
            {entities.map((e) => <option key={e.entity} value={e.entity}>{e.entity}</option>)}
          </select>
        </label>
        <button className="btn-ghost !py-1" type="submit">اعمال</button>
      </form>

      <div className="card divide-y divide-black/6 font-mono text-xs" dir="ltr">
        {logs.length === 0 && <div className="p-6 text-center text-black/50">رخدادی یافت نشد.</div>}
        {logs.map((l) => (
          <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 p-2">
            <div>
              <b>{EVENT_FA[l.event] ?? l.event}</b>
              <span className="text-black/45"> · {l.entity}{l.entityId ? `#${l.entityId.slice(-6)}` : ""} · actor:{l.actor.slice(-6)}</span>
            </div>
            <div className="text-black/40">{toPersianDigits(l.createdAt.toISOString().slice(0, 16).replace("T", " "))}</div>
          </div>
        ))}
      </div>
      <p className="text-xs text-black/40">رازها/اطلاعات پرداخت در این گزارش ذخیره نمی‌شود؛ متادیتا فقط شناسه‌ها و تغییرات وضعیت است.</p>
    </div>
  );
}
