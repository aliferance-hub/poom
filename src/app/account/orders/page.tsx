import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getSessionId } from "@/lib/session";
import { formatToman } from "@/lib/persian";

// Customer-facing labels for the per-seller suborder status (P2-D §69: the
// customer order view mirrors the seller's SellerOrder status).
const SELLER_STATUS_FA: Record<string, string> = {
  PENDING: "در انتظار تأیید",
  CONFIRMED: "تأیید شده",
  SHIPPED: "ارسال شده",
  DELIVERED: "تحویل شده",
  CANCELLED: "لغو شده",
  RETURNED: "مرجوعی",
};export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ status?: string; error?: string }> }) {
  const sp = await searchParams;
  const sid = await getSessionId();

  // §66 filters: status tabs derive from actual state values.
  const statusFilter = sp.status;
  const where = {
    sessionId: sid,
    ...(statusFilter === "cancelled"
      ? { status: "CANCELLED" as const }
      : statusFilter === "pending"
        ? { status: "PENDING_PAYMENT" as const }
        : statusFilter === "paid"
          ? { status: "PAID" as const }
          : statusFilter === "returned"
            ? { sellerOrders: { some: { status: "RETURNED" as const } } }
            : {}),
  };
  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { sellerOrders: { include: { seller: true, items: { include: { offer: { include: { part: true } } } } } } },
  });

  const TABS: [string, string][] = [
    ["", "همه"], ["pending", "در انتظار پرداخت"], ["paid", "پرداخت شده"], ["cancelled", "لغو شده"], ["returned", "مرجوعی"],
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">سفارش‌های من</h1>
      {sp.error && <div className="card border border-red-300 bg-red-50 p-2 text-sm text-red-900" role="alert">{sp.error === "NOT_CANCELLABLE" ? "این سفارش قابل لغو نیست." : "سفارش یافت نشد."}</div>}
      <div className="flex flex-wrap gap-1">
        {TABS.map(([v, label]) => (
          <Link key={v || "all"} href={v ? `/account/orders?status=${v}` : "/account/orders"}
            className={`badge ${(sp.status ?? "") === v ? "bg-[var(--color-accent)] text-white" : "bg-black/6"}`}>
            {label}
          </Link>
        ))}
      </div>
      {orders.length === 0 && <div className="card p-8 text-center text-sm text-black/50">هنوز سفارشی ثبت نکرده‌اید.</div>}
      {orders.map((o) => (
        <Link key={o.id} href={`/account/orders/${o.id}`} className="card block p-4 hover:bg-black/3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold" dir="ltr">{o.orderNumber}</div>
            <span className={`badge ${o.status === "PAID" ? "bg-green-100 text-green-800" : o.status === "PENDING_PAYMENT" ? "bg-amber-100 text-amber-800" : "bg-black/8"}`}>
              {o.status === "PAID" ? "پرداخت شده" : o.status === "PENDING_PAYMENT" ? "در انتظار پرداخت" : o.status}
            </span>
          </div>
          <div className="mt-1 text-xs text-black/50">مبلغ: {formatToman(o.total)}</div>
          <ul className="mt-2 space-y-1 text-sm">
            {o.sellerOrders.map((so) => (
              <li key={so.id}>
                {so.seller.businessName}: {so.items.map((i) => i.offer.part.title).join("، ")}
                <span className="badge mr-1 bg-black/6">{SELLER_STATUS_FA[so.status] ?? so.status}</span>
              </li>
            ))}
          </ul>
        </Link>
      ))}
    </div>
  );
}
