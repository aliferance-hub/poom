import Link from "next/link";
import { notFound } from "next/navigation";
import { getCustomerOrder } from "@/lib/governance";
import { getSessionId } from "@/lib/session";
import { getCurrentUser } from "@/lib/auth/identity";
import { getReturnEligibility } from "@/lib/returns";
import { cancelCustomerOrder } from "@/app/account/order-actions";
import { formatToman, toPersianDigits } from "@/lib/persian";

export const dynamic = "force-dynamic";

const SO_STATUS_FA: Record<string, string> = {
  PENDING: "تأیید شده (در انتظار آماده‌سازی)",
  CONFIRMED: "تأیید شده",
  SHIPPED: "ارسال شده",
  DELIVERED: "تحویل شده",
  CANCELLED: "لغو شده",
  RETURNED: "مرجوعی",
};

const RETURN_STATUS_FA: Record<string, string> = {
  REQUESTED: "ثبت شده",
  UNDER_REVIEW: "در حال بررسی",
  APPROVED: "تأیید شده",
  REJECTED: "رد شده",
  RECEIVED: "دریافت شد",
  REFUND_PENDING: "در انتظار بازگشت وجه",
  REFUNDED: "وجه برگشت داده شد",
  CANCELLED: "لغو شده",
};

const TIMELINE = ["ثبت سفارش", "پرداخت", "تأیید فروشنده", "ارسال", "تحویل"];

function timelineStep(status: string): number {
  switch (status) {
    case "PENDING": return 2;
    case "CONFIRMED": return 2;
    case "SHIPPED": return 3;
    case "DELIVERED": return 4;
    default: return 1;
  }
}

export default async function CustomerOrderDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const sid = await getSessionId();
  const user = await getCurrentUser();
  const owner = { sessionId: sid, userId: user?.id };

  // Ownership in the query (§17): another user's order id → 404.
  const order = await getCustomerOrder(owner, orderId);
  if (!order) notFound();

  const canCancel = order.status === "PENDING_PAYMENT" && order.paymentStatus !== "SUCCEEDED";
  const eligibilities = await Promise.all(
    order.sellerOrders.flatMap((so) =>
      so.items.map(async (it) => ({
        itemId: it.id,
        eligibility: await getReturnEligibility(it.id, owner),
        hasActive: so.items.some(() => (it.returnRequests?.length ?? 0) > 0),
      })),
    ),
  );
  const eligMap = new Map(eligibilities.map((e) => [e.itemId, e]));

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold" dir="ltr">{order.orderNumber}</h1>
        <div className="flex items-center gap-2">
          {canCancel && (
            <form action={cancelCustomerOrder}>
              <input type="hidden" name="orderId" value={order.id} />
              <button className="btn-ghost !text-xs !text-red-700" type="submit">لغو سفارش</button>
            </form>
          )}
          <span className={`badge ${order.status === "PAID" ? "bg-green-100 text-green-900" : order.status === "CANCELLED" ? "bg-red-100 text-red-900" : "bg-amber-100 text-amber-900"}`}>
            {order.status === "PAID" ? "پرداخت شده" : order.status === "PENDING_PAYMENT" ? "در انتظار پرداخت" : order.status === "CANCELLED" ? "لغو شده" : order.status}
          </span>
        </div>
      </div>
      <div className="card p-3 text-sm">
        تاریخ ثبت: {toPersianDigits(order.createdAt.toISOString().slice(0, 10))} · مبلغ کل: <b>{formatToman(order.total)}</b> · پرداخت: {order.paymentStatus === "SUCCEEDED" ? "موفق" : order.paymentStatus === "PENDING" ? "در انتظار" : "ناموفق"}
      </div>

      {order.sellerOrders.length > 1 && (
        <p className="text-xs text-black/50">این سفارش شامل {toPersianDigits(order.sellerOrders.length)} فروشنده است؛ هر فروشنده جداگانه آماده و ارسال می‌کند.</p>
      )}

      {order.sellerOrders.map((so) => {
        const step = timelineStep(so.status);
        return (
          <section key={so.id} className="card space-y-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold">{so.seller.businessName}</h2>
              <div className="flex items-center gap-1">
                {so.seller.verified && <span className="badge bg-green-100 text-green-900">✓ فروشنده تأییدشده</span>}
                <span className="badge bg-black/6">{SO_STATUS_FA[so.status] ?? so.status}</span>
              </div>
            </div>

            {so.status !== "CANCELLED" && so.status !== "RETURNED" && (
              <ol className="flex flex-wrap items-center gap-1 text-[11px]" aria-label="مراحل سفارش">
                {TIMELINE.map((t, i) => (
                  <li key={t} className={`badge ${i < step ? "bg-green-100 text-green-900" : i === step ? "bg-amber-100 text-amber-900" : "bg-black/5 text-black/40"}`}>
                    {i < step ? "✓ " : i === step ? "⏳ " : ""}{t}
                  </li>
                ))}
              </ol>
            )}

            {so.shipment && so.shipment.status !== "PENDING" && (
              <div className="rounded bg-black/3 p-2 text-xs">
                ارسال: {so.shipment.status === "SHIPPED" ? "ارسال شده" : so.shipment.status === "DELIVERED" ? "تحویل شده" : so.shipment.status}
                {so.shipment.trackingCode && <> · کد رهگیری: <span dir="ltr">{so.shipment.trackingCode}</span></>}
              </div>
            )}

            <div className="divide-y divide-black/6 text-sm">
              {so.items.map((it) => {
                const elig = eligMap.get(it.id)?.eligibility;
                const hasActive = (it.returnRequests?.length ?? 0) > 0;
                return (
                  <div key={it.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div>
                      {/* §40: snapshot title, fallback to live title for legacy rows */}
                      <div className="font-medium">{it.partTitleSnapshot ?? it.offer.part.title}</div>
                      <div className="text-[10px] text-black/40" dir="ltr">{it.partSkuSnapshot ?? it.offer.part.sku}{it.sellerSkuSnapshot ? ` · ${it.sellerSkuSnapshot}` : ""}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span>{toPersianDigits(it.quantity)} × {formatToman(it.unitPrice)}</span>
                      {elig?.eligible && !hasActive && (
                        <form action="/account/returns/new" method="get" className="inline">
                          <input type="hidden" name="item" value={it.id} />
                          <button className="btn-ghost !px-2 !py-1 !text-xs" type="submit">درخواست مرجوعی</button>
                        </form>
                      )}
                      {hasActive && it.returnRequests?.[0] && (
                        <span className="badge bg-amber-100 text-amber-900">مرجوعی: {RETURN_STATUS_FA[it.returnRequests[0].status] ?? it.returnRequests[0].status}</span>
                      )}
                      {elig && !elig.eligible && so.status === "DELIVERED" && (
                        <span className="text-[10px] text-black/35" title={elig.reason}>—</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="text-left text-xs text-black/50">جمع این فروشنده: {formatToman(so.subtotal)}</div>
          </section>
        );
      })}

      <Link href="/account/orders" className="btn-ghost inline-block text-sm">بازگشت به سفارش‌ها</Link>
    </div>
  );
}
