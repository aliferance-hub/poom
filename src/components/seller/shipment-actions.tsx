"use client";

import { useState, useTransition } from "react";
import { shipShipmentAction, deliverShipmentAction, readyShipmentAction } from "@/app/seller/shipment-actions";

/**
 * Shipment controls (P2-E §33): READY_TO_SHIP → SHIPPED (tracking required)
 * → DELIVERED. Only the next legal action per current status renders.
 */
export function ShipmentActions({ sellerOrderId, shipmentStatus, trackingCode }: {
  sellerOrderId: string;
  shipmentStatus: string;
  trackingCode: string;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tracking, setTracking] = useState(trackingCode);

  function go(action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData, okText: string) {
    start(async () => {
      const res = await action(fd);
      setMsg(res.ok ? { ok: true, text: okText } : { ok: false, text: res.error ?? "خطا" });
      if (res.ok) setTimeout(() => window.location.reload(), 900);
    });
  }

  if (shipmentStatus === "DELIVERED" || shipmentStatus === "RETURNED") {
    return (
      <div className="card p-4 text-sm text-black/55">
        وضعیت ارسال: {shipmentStatus === "DELIVERED" ? "تحویل شده" : "مرجوعی"}{trackingCode ? <> · کد رهگیری: <span dir="ltr">{trackingCode}</span></> : null}
      </div>
    );
  }

  const fd = new FormData();
  fd.set("sellerOrderId", sellerOrderId);
  fd.set("trackingCode", tracking);

  return (
    <div className="card space-y-2 p-4">
      <h2 className="text-sm font-semibold">ارسال</h2>
      <div className="flex flex-wrap items-end gap-2">
        {shipmentStatus === "PENDING" && (
          <button className="btn-ghost !px-4 !text-sm" disabled={pending}
            onClick={() => go(readyShipmentAction, fd, "آماده ارسال ثبت شد.")}>
            آماده‌سازی کامل شد (READY_TO_SHIP)
          </button>
        )}
        {shipmentStatus === "READY_TO_SHIP" && (
          <>
            <label className="text-[11px] text-black/55">
              کد رهگیری
              <input value={tracking} onChange={(e) => setTracking(e.target.value)} dir="ltr" maxLength={60}
                className="input !w-44 !py-1" placeholder="DEMO-TRACK-123" />
            </label>
            <button className="btn-ghost !px-4 !text-sm" disabled={pending || !tracking.trim()}
              onClick={() => go(shipShipmentAction, fd, "سفارش ارسال شد.")}>
              ثبت ارسال
            </button>
          </>
        )}
        {shipmentStatus === "SHIPPED" && (
          <button className="btn-ghost !px-4 !text-sm" disabled={pending}
            onClick={() => go(deliverShipmentAction, fd, "تحویل ثبت شد.")}>
            تحویل شد
          </button>
        )}
        {trackingCode && shipmentStatus !== "PENDING" && (
          <span className="text-[11px] text-black/45" dir="ltr">رهگیری: {trackingCode}</span>
        )}
      </div>
      {msg && (
        <div role="status" className={`rounded px-2 py-1 text-xs ${msg.ok ? "bg-green-100 text-green-900" : "bg-red-100 text-red-900"}`}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
