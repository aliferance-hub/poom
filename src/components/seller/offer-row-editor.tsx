"use client";

import { useState, useTransition } from "react";
import { saveOfferAction, toggleOfferAction } from "@/app/seller/seller-actions";
import { toPersianDigits } from "@/lib/persian";

type OfferEdit = {
  id: string;
  partTitle: string;
  partSku: string;
  sellerSku: string | null;
  price: number;
  stock: number;
  lowStockThreshold: number;
  shippingDaysMin: number;
  shippingDaysMax: number;
  warrantyFa: string | null;
  active: boolean;
};

/**
 * One seller offer row (mobile-friendly card layout). Immutable catalog data
 * (part title/SKU) is displayed as read-only text; only Offer fields are
 * editable — the visual separation required by §47.
 */
export function OfferRowEditor({ offer, bucket, freshness }: { offer: OfferEdit; bucket: string; freshness: string }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function submit(form: FormData) {
    start(async () => {
      const res = await saveOfferAction(form);
      setMsg(res.ok ? { ok: true, text: "ذخیره شد ✓" } : { ok: false, text: res.error ?? "خطا" });
      if (res.ok) setTimeout(() => setMsg(null), 2500);
    });
  }

  return (
    <div className="p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-44 flex-1">
          <div className="font-medium">{offer.partTitle}</div>
          <div className="text-[10px] text-black/40" dir="ltr">{offer.partSku}{offer.sellerSku ? ` · ${offer.sellerSku}` : ""}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
            <span className={`badge ${offer.stock === 0 ? "bg-red-100 text-red-900" : offer.stock <= offer.lowStockThreshold ? "bg-amber-100 text-amber-900" : "bg-green-100 text-green-900"}`}>{bucket}</span>
            <span className="badge bg-black/6">{offer.active ? "فعال" : "غیرفعال"}</span>
            <span className="text-black/40">{freshness}</span>
          </div>
        </div>
        <div className="text-left">
          <div className="font-bold">{toPersianDigits(offer.price.toLocaleString("en-US"))}</div>
          <div className="text-[10px] text-black/45">موجودی: {toPersianDigits(offer.stock)}</div>
        </div>
        <div className="flex items-center gap-1">
          <button className="btn-ghost !px-3 !py-1 !text-xs" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "بستن" : "ویرایش"}
          </button>
          <button
            className="btn-ghost !px-2 !py-1 !text-xs"
            disabled={pending}
            onClick={() => {
              const fd = new FormData();
              fd.set("offerId", offer.id);
              fd.set("active", String(!offer.active));
              start(async () => {
                const res = await toggleOfferAction(fd);
                setMsg(res.ok ? { ok: true, text: !offer.active ? "فعال شد" : "غیرفعال شد" } : { ok: false, text: res.error ?? "خطا" });
                if (res.ok) setTimeout(() => setMsg(null), 2000);
              });
            }}
          >
            {offer.active ? "غیرفعال" : "فعال‌سازی"}
          </button>
        </div>
      </div>

      {msg && (
        <div role="status" className={`mt-2 rounded px-2 py-1 text-xs ${msg.ok ? "bg-green-100 text-green-900" : "bg-red-100 text-red-900"}`}>
          {msg.text}
        </div>
      )}

      {open && (
        <form action={submit} className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-black/3 p-3 md:grid-cols-3">
          <input type="hidden" name="offerId" value={offer.id} />
          <input type="hidden" name="active" value={String(offer.active)} />
          <label className="text-[11px] text-black/55">
            قیمت (ریال)
            <input name="priceIrr" type="number" min={1} step={1} defaultValue={offer.price} className="input !py-1" dir="ltr" required />
          </label>
          <label className="text-[11px] text-black/55">
            موجودی
            <input name="stock" type="number" min={0} step={1} defaultValue={offer.stock} className="input !py-1" dir="ltr" required />
          </label>
          <label className="text-[11px] text-black/55">
            SKU فروشنده
            <input name="sellerSku" defaultValue={offer.sellerSku ?? ""} className="input !py-1" dir="ltr" maxLength={40} />
          </label>
          <label className="text-[11px] text-black/55">
            حداقل روز ارسال
            <input name="shippingDaysMin" type="number" min={0} max={60} defaultValue={offer.shippingDaysMin} className="input !py-1" dir="ltr" required />
          </label>
          <label className="text-[11px] text-black/55">
            حداکثر روز ارسال
            <input name="shippingDaysMax" type="number" min={0} max={90} defaultValue={offer.shippingDaysMax} className="input !py-1" dir="ltr" required />
          </label>
          <label className="text-[11px] text-black/55">
            گارانتی
            <input name="warrantyFa" defaultValue={offer.warrantyFa ?? ""} className="input !py-1" maxLength={120} placeholder="مثلاً ۶ ماه" />
          </label>
          <div className="col-span-2 md:col-span-3">
            <button type="submit" className="btn-ghost !px-4" disabled={pending}>{pending ? "..." : "ذخیره"}</button>
          </div>
        </form>
      )}
    </div>
  );
}
