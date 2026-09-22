import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getSessionId } from "@/lib/session";
import { formatToman, toPersianDigits } from "@/lib/persian";

export default async function ResultPage({ searchParams }: { searchParams: Promise<{ order?: string; failed?: string; reason?: string }> }) {
  const { order: orderNumber, failed, reason } = await searchParams;

  if (!orderNumber) {
    return (
      <div className="mx-auto max-w-md space-y-3 text-center">
        <div className="card space-y-2 p-8">
          <div className="text-3xl">✕</div>
          <h1 className="text-lg font-bold">پرداخت ناموفق</h1>
          <p className="text-sm text-black/55">پرداخت انجام نشد. می‌توانید دوباره تلاش کنید.</p>
          <Link href="/cart" className="btn-primary mt-2">بازگشت به سبد</Link>
        </div>
      </div>
    );
  }

  // Horizontal-tenancy guard: a guest may only view orders created by its own session.
  const sid = await getSessionId();
  const order = await prisma.order.findFirst({
    where: { orderNumber, sessionId: sid },
    include: { sellerOrders: { include: { seller: true, items: { include: { offer: { include: { part: true } } } } } } },
  });

  if (!order) {
    return (
      <div className="card p-8 text-center text-sm">سفارش پیدا نشد.</div>
    );
  }

  // The DB is the single source of truth for the outcome — a `failed` query
  // param from the gateway can never override the authoritative order state.
  if (order.status !== "PAID") {
    return (
      <div className="mx-auto max-w-md space-y-3 text-center">
        <div className="card space-y-2 p-8">
          <div className="text-3xl">✕</div>
          <h1 className="text-lg font-bold">پرداخت انجام نشد</h1>
          <p className="text-sm text-black/55">پرداخت دریافت نشد یا تکمیل نشد. می‌توانید دوباره تلاش کنید.</p>
          <Link href="/cart" className="btn-primary mt-2">بازگشت به سبد</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="card space-y-2 p-6 text-center">
        <div className="text-3xl text-green-600">✓</div>
        <h1 className="text-lg font-bold">پرداخت با موفقیت انجام شد</h1>
        <p className="text-xs text-black/50" dir="ltr">{order.orderNumber}</p>
        <p className="text-sm">مبلغ: <b>{formatToman(order.total)}</b></p>
      </div>

      <h2 className="text-sm font-bold text-black/60">سفارش‌های فروشندگان ({toPersianDigits(order.sellerOrders.length)})</h2>
      {order.sellerOrders.map((so) => (
        <div key={so.id} className="card p-4">
          <div className="flex items-center justify-between">
            <div className="font-semibold">{so.seller.businessName}</div>
            <span className="badge bg-green-100 text-green-800">
              {so.status === "CONFIRMED" ? "تأیید شده" : so.status}
            </span>
          </div>
          <ul className="mt-2 space-y-1 text-sm">
            {so.items.map((it) => (
              <li key={it.id} className="flex justify-between">
                <span>{it.offer.part.title} × {toPersianDigits(it.quantity)}</span>
                <span>{formatToman(it.total)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 border-t border-black/8 pt-2 text-xs text-black/50">
            جمع این فروشنده: {formatToman(so.subtotal)}
          </div>
        </div>
      ))}

      <div className="flex justify-center gap-2">
        <Link href="/account/orders" className="btn-ghost">سفارش‌های من</Link>
        <Link href="/" className="btn-primary">بازگشت به خانه</Link>
      </div>
    </div>
  );
}
