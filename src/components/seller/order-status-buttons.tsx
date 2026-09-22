"use client";

import { useState, useTransition } from "react";
import { setOrderStatusAction } from "@/app/seller/seller-actions";

/**
 * Explicit state-machine UI: only the allowed next statuses render (§26).
 * Duplicate submits of the same target are idempotent server-side.
 */
export function OrderStatusButtons({
  sellerOrderId,
  current,
  allowed,
  statusFa,
}: {
  sellerOrderId: string;
  current: string;
  allowed: string[];
  statusFa: Record<string, string>;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (allowed.length === 0) {
    return (
      <div className="card p-4 text-sm text-black/55">
        این سفارش در وضعیت پایانی است ({statusFa[current] ?? current}) و تغییر بیشتری ندارد.
      </div>
    );
  }

  function go(next: string) {
    const fd = new FormData();
    fd.set("sellerOrderId", sellerOrderId);
    fd.set("status", next);
    start(async () => {
      const res = await setOrderStatusAction(fd);
      setMsg(res.ok ? { ok: true, text: `وضعیت به «${statusFa[next] ?? next}» تغییر کرد.` } : { ok: false, text: res.error ?? "خطا" });
      if (res.ok) setTimeout(() => window.location.reload(), 900);
    });
  }

  return (
    <div className="card space-y-2 p-4">
      <h2 className="text-sm font-semibold">تغییر وضعیت</h2>
      <div className="flex flex-wrap gap-2">
        {allowed.map((s) => (
          <button key={s} className="btn-ghost !px-4 !text-sm" disabled={pending} onClick={() => go(s)}>
            {s === "CANCELLED" ? `لغو سفارش` : (statusFa[s] ?? s)}
          </button>
        ))}
      </div>
      {msg && (
        <div role="status" className={`rounded px-2 py-1 text-xs ${msg.ok ? "bg-green-100 text-green-900" : "bg-red-100 text-red-900"}`}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
