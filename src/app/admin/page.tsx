import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/identity";

const __adminGate = async () => { const a = await requireAdmin(); if (!a) redirect("/login?next=/admin"); return a; };
import { prisma } from "@/lib/prisma";
import { formatToman, toPersianDigits } from "@/lib/persian";

export default async function AdminPage() {
  await __adminGate();
  const [orders, offers, assets, zones, parts, sellers] = await Promise.all([
    prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 8, include: { sellerOrders: { include: { seller: true } } } }),
    prisma.offer.findMany({ take: 8, include: { part: true, seller: true }, orderBy: { updatedAt: "desc" } }),
    prisma.asset.findMany({ include: { versions: { orderBy: { version: "desc" }, include: { meshMappings: true } } } }),
    prisma.vehicleZone.findMany({ include: { _count: { select: { assemblies: true } } } }),
    prisma.part.count(),
    prisma.seller.findMany(),
  ]);

  const assetCards = assets.map((a) => ({ ...a, maps: a.versions.flatMap((v) => v.meshMappings) }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">پنل ادمین (DEMO)</h1>
        <div className="flex gap-2 text-sm">
          <Link href="/admin/fitment" className="btn-ghost">مدیریت سازگاری</Link>
          <Link href="/admin/inquiries" className="btn-ghost">استعلام‌ها</Link>
          <Link href="/admin/parts" className="btn-ghost">قطعات</Link>
          <Link href="/admin/categories" className="btn-ghost">دسته‌بندی‌ها</Link>
          <Link href="/admin/vehicles" className="btn-ghost">خودروها</Link>
          <Link href="/admin/zones" className="btn-ghost">نواحی</Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          ["قطعات", toPersianDigits(parts)],
          ["فروشندگان", toPersianDigits(sellers.length)],
          ["سفارش‌ها", toPersianDigits(orders.length)],
          ["نواحی", toPersianDigits(zones.length)],
          ["Assetهای 3D", toPersianDigits(assets.length)],
        ].map(([l, v]) => (
          <div key={l} className="card p-3 text-center">
            <div className="text-lg font-bold">{v}</div>
            <div className="text-[11px] text-black/50">{l}</div>
          </div>
        ))}
      </div>

      <section className="space-y-2">
        <h2 className="font-semibold">سفارش‌های اخیر</h2>
        {orders.length === 0 && <div className="card p-4 text-sm text-black/50">سفارشی ثبت نشده.</div>}
        {orders.map((o) => (
          <div key={o.id} className="card flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
            <div>
              <span dir="ltr" className="font-medium">{o.orderNumber}</span>
              <span className="text-black/45">
                {" "}· {o.sellerOrders.map((so) => `${so.seller.businessName} (${so.status})`).join("، ")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`badge ${o.paymentStatus === "SUCCEEDED" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>
                {o.paymentStatus}
              </span>
              <b>{formatToman(o.total)}</b>
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">3D Asset Manager</h2>
        {assetCards.map((a) => (
          <div key={a.id} className="card space-y-1 p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-xs" dir="ltr">{a.assetId}</span>
              <span className="badge bg-black/6">{a.source}</span>
              <Link href={`/admin/assets/${a.assetId}`} className="btn-ghost !px-2 !py-1 !text-xs">استودیو نگاشت</Link>
            </div>
            <div className="text-xs text-black/55">
              نسخه فعال: {toPersianDigits(a.versions.find((v) => v.status === "ACTIVE")?.version ?? "—")} ·
              نگاشت ناحیه: {toPersianDigits(a.maps.filter((m) => m.kind === "zone").length)} ·
              نگاشت قطعه: {toPersianDigits(a.maps.filter((m) => m.kind === "part").length)}
            </div>
            <div className="flex flex-wrap gap-1 pt-1">
              {a.maps.filter((m) => m.kind === "zone").map((m) => (
                <span key={m.id} className="badge bg-blue-50 font-mono text-[10px] text-blue-700" dir="ltr">{m.meshName}</span>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {a.maps.filter((m) => m.kind === "part").map((m) => (
                <span key={m.id} className="badge bg-purple-50 font-mono text-[10px] text-purple-700" dir="ltr">{m.meshName}</span>
              ))}
            </div>
            <div className="text-[10px] text-black/40">{a.licenseNote}</div>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">آخرین آفرها</h2>
        <div className="card divide-y divide-black/6 text-sm">
          {offers.map((o) => (
            <div key={o.id} className="flex items-center justify-between p-3">
              <span>{o.part.title} <span className="text-black/40">· {o.seller.businessName}</span></span>
              <b>{formatToman(o.price)}</b>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
