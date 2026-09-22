import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { SellerNav } from "@/components/seller/seller-nav";
import { getAuthenticatedSeller } from "@/lib/seller/seller-auth";
import { getSellerOrder } from "@/lib/seller/seller-orders";
import { formatToman, toPersianDigits } from "@/lib/persian";
import { OrderStatusButtons } from "@/components/seller/order-status-buttons";
import { ShipmentActions } from "@/components/seller/shipment-actions";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const STATUS_FA: Record<string, string> = {
  PENDING: "در انتظار تأیید",
  CONFIRMED: "تأیید شده",
  PROCESSING: "در حال آماده‌سازی",
  READY_TO_SHIP: "آماده ارسال",
  SHIPPED: "ارسال شده",
  DELIVERED: "تحویل شده",
  CANCELLED: "لغو شده",
  RETURNED: "مرجوعی",
};

export default async function SellerOrderDetailPage({
  params,
}: {
  params: Promise<{ sellerOrderId: string }>;
}) {
  const identity = await getAuthenticatedSeller();
  if (!identity) redirect("/login?next=/seller/orders");
  const { sellerOrderId } = await params;

  // Ownership enforced in the service WHERE; a foreign id → 404 (no existence leak).
  const so = await getSellerOrder(identity.seller.id, sellerOrderId);
  if (!so) notFound();
  const shipment = await prisma.shipment.findUnique({
    where: { sellerOrderId },
    select: { status: true, trackingCode: true, shippedAt: true, deliveredAt: true, carrier: true },
  });
  const shipmentStatus = shipment?.status ?? "PENDING";
  const trackingCode = shipment?.trackingCode ?? "";

  return (
    <div className="space-y-4">
      <SellerNav />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold" dir="ltr">{so.orderNumber}</h1>
        <span className="badge bg-black/6">{STATUS_FA[so.status] ?? so.status}</span>
      </div>

      <div className="card space-y-1 p-4 text-sm">
        <div>پرداخت: {so.paymentStatus === "SUCCEEDED" ? "موفق" : so.paymentStatus === "PENDING" ? "در انتظار" : "ناموفق"} · وضعیت سفارش مشتری: {so.orderStatus}</div>
        <div>جمع اقلام: <b>{formatToman(so.subtotal)}</b></div>
      </div>

      <div className="card p-4">
        <h2 className="mb-2 text-sm font-semibold">اقلام (قیمت لحظه‌ی خرید — تغییرات بعدی قیمت آفر اینجا اعمال نمی‌شود)</h2>
        <div className="divide-y divide-black/6 text-sm">
          {so.items.map((it) => (
            <div key={it.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <div className="font-medium">{it.partTitle}</div>
                <div className="text-[10px] text-black/40" dir="ltr">{it.partSku}</div>
              </div>
              <div className="text-left">
                <div>{toPersianDigits(it.quantity)} × {formatToman(it.unitPrice)}</div>
                <div className="text-[11px] text-black/50">جمع: {formatToman(it.total)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <OrderStatusButtons
        sellerOrderId={so.id}
        current={so.status}
        allowed={so.allowedNext}
        statusFa={STATUS_FA}
      />

      <ShipmentActions
        sellerOrderId={so.id}
        shipmentStatus={shipmentStatus}
        trackingCode={trackingCode}
      />

      <Link href="/seller/orders" className="btn-ghost inline-block text-sm">بازگشت به سفارش‌ها</Link>
    </div>
  );
}
