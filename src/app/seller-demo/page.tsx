import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { SellerOfferRow } from "@/components/seller-offer-row";
import { formatToman, toPersianDigits } from "@/lib/persian";

/**
 * PRESERVED PUBLIC DEMO (P2-D): the original Phase-1 seller page, moved to
 * /seller-demo. It is a public, unauthenticated demo view for showcasing the
 * marketplace; the real session-gated portal lives at /seller.
 */
export default async function SellerDemoPage({ searchParams }: { searchParams: Promise<{ seller?: string }> }) {
  const { seller: sellerParam } = await searchParams;
  const sellers = await prisma.seller.findMany({ orderBy: { businessName: "asc" } });
  const current = sellers.find((s) => s.id === sellerParam) ?? sellers[0];
  if (!current) return <div className="card p-8 text-sm">فروشنده‌ای ثبت نشده (DEMO).</div>;

  const [orders, offers] = await Promise.all([
    prisma.sellerOrder.findMany({
      where: { sellerId: current.id },
      orderBy: { id: "desc" },
      include: { order: true, items: { include: { offer: { include: { part: true } } } } },
      take: 10,
    }),
    prisma.offer.findMany({
      where: { sellerId: current.id },
      include: { part: true },
      orderBy: { part: { title: "asc" } },
      take: 60,
    }),
  ]);

  const lowStock = offers.filter((o) => o.stock <= o.lowStockThreshold && o.stock > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">پنل فروشنده (DEMO)</h1>
        <div className="flex flex-wrap gap-1">
          {sellers.map((s) => (
            <Link key={s.id} href={`/seller-demo?seller=${s.id}`}
              className={`badge ${s.id === current.id ? "bg-[var(--color-accent)] text-white" : "bg-black/6"}`}>
              {s.businessName}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["سفارش‌ها", toPersianDigits(orders.length)],
          ["آفرهای فعال", toPersianDigits(offers.filter((o) => o.active).length)],
          ["کم‌موجود", toPersianDigits(lowStock.length)],
          ["امتیاز (DEMO)", toPersianDigits(current.rating.toFixed(1))],
        ].map(([l, v]) => (
          <div key={l} className="card p-3 text-center">
            <div className="text-lg font-bold">{v}</div>
            <div className="text-[11px] text-black/50">{l}</div>
          </div>
        ))}
      </div>

      <section className="space-y-2">
        <h2 className="font-semibold">سفارش‌های من</h2>
        {orders.length === 0 && <div className="card p-4 text-sm text-black/50">سفارشی نیست.</div>}
        {orders.map((so) => (
          <div key={so.id} className="card flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
            <div>
              <span dir="ltr" className="font-medium">{so.order.orderNumber}</span>
              <span className="text-black/45"> · {so.items.map((i) => `${i.offer.part.title} ×${i.quantity}`).join("، ")}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="badge bg-black/6">{so.status}</span>
              <b>{formatToman(so.subtotal)}</b>
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">موجودی و قیمت‌ها</h2>
        <div className="card divide-y divide-black/6">
          {offers.map((o) => (
            <SellerOfferRow key={o.id} offer={{ id: o.id, price: o.price, stock: o.stock, active: o.active, partTitle: o.part.title, partSku: o.part.sku }} />
          ))}
        </div>
      </section>
    </div>
  );
}
